#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>

// Fail a stuck local TCP write promptly so the dedicated network task
// can tear down a half-open socket and reconnect instead of blocking for
// the library default 5 seconds.
#define WEBSOCKETS_TCP_TIMEOUT 1000
#include <WebSocketsClient.h>

#include "MAX30105.h"
#include <protocentral_TLA20xx.h>

#include "esp_timer.h"
#include "esp_system.h"

#include <stdarg.h>
#include <stdint.h>

// ============================================================
//                    USER NETWORK CONFIG
// ============================================================
// Local values are supplied by an ignored firmware/secrets.h file.
#include "secrets.h"

constexpr uint16_t WS_PORT = 8080;
const char *WS_PATH = "/objective";

// ============================================================
//                         HARDWARE
// ============================================================

constexpr uint8_t SDA_PIN = 21;
constexpr uint8_t SCL_PIN = 22;

constexpr uint8_t TMP117_ADDR   = 0x48;
constexpr uint8_t TINYGSR_ADDR  = 0x49;
constexpr uint8_t MAX30101_ADDR = 0x57;
constexpr uint8_t MPU6050_ADDR  = 0x68;

constexpr uint8_t ECG_PIN      = 34;
constexpr uint8_t ECG_LO_PLUS  = 25;
constexpr uint8_t ECG_LO_MINUS = 26;

constexpr uint8_t MAX30101_INT = 32;
constexpr uint8_t MPU6050_INT  = 27;
constexpr uint8_t TMP117_INT   = 33;

// ============================================================
//                     SENSOR OBJECTS
// ============================================================

MAX30105 ppgSensor;
TLA20XX tla2022(TINYGSR_ADDR);

// ============================================================
//                       NETWORK OBJECT
// ============================================================

WebSocketsClient webSocket;

// ============================================================
//                         TIMING
// ============================================================

constexpr int64_t ECG_PERIOD_US = 4000;          // 250 Hz
constexpr int64_t PPG_SERVICE_PERIOD_US = 5000;  // service FIFO at 200 Hz
constexpr int64_t PPG_SAMPLE_PERIOD_US = 10000;  // nominal PPG 100 Hz
constexpr int64_t GSR_PERIOD_US = 7813;           // ~128 Hz
constexpr int64_t IMU_PERIOD_US = 10000;          // 100 Hz
constexpr int64_t TEMP_PERIOD_US = 500000;        // 2 Hz

constexpr int64_t BATCH_PERIOD_US = 100000;       // 100 ms
constexpr int64_t DIAGNOSTIC_PERIOD_US = 1000000; // 1 s

// ============================================================
//                    SAMPLE STRUCTURES
// ============================================================

struct EcgSample {
  int64_t timestamp_us;
  uint16_t adc;
  uint8_t loPlus;
  uint8_t loMinus;
};

struct PpgSample {
  int64_t timestamp_us;
  uint32_t red;
  uint32_t ir;
};

struct GsrSample {
  int64_t timestamp_us;
  int16_t raw;
};

struct ImuSample {
  int64_t timestamp_us;
  int16_t axRaw;
  int16_t ayRaw;
  int16_t azRaw;
  int16_t gxRaw;
  int16_t gyRaw;
  int16_t gzRaw;
};

struct TempSample {
  int64_t timestamp_us;
  int16_t raw;
};

// ============================================================
//                     RING BUFFER
// ============================================================

struct RingStats {
  uint32_t produced;
  uint32_t enqueued;
  uint32_t consumed;
  uint32_t overflows;
  uint16_t depth;
  uint16_t highWater;
};

template <typename T, size_t N>
class SampleRingBuffer {
private:
  T data[N];
  size_t head = 0;
  size_t tail = 0;
  size_t count = 0;
  size_t highWater = 0;

  uint32_t produced = 0;
  uint32_t enqueued = 0;
  uint32_t consumed = 0;
  uint32_t overflows = 0;

public:
  bool push(const T &sample, portMUX_TYPE *mux) {
    bool ok = false;

    portENTER_CRITICAL(mux);

    produced++;

    if (count >= N) {
      overflows++;
    } else {
      data[head] = sample;
      head = (head + 1) % N;
      count++;
      enqueued++;

      if (count > highWater) {
        highWater = count;
      }

      ok = true;
    }

    portEXIT_CRITICAL(mux);
    return ok;
  }

  bool pop(T &sample, portMUX_TYPE *mux) {
    bool ok = false;

    portENTER_CRITICAL(mux);

    if (count > 0) {
      sample = data[tail];
      tail = (tail + 1) % N;
      count--;
      consumed++;
      ok = true;
    }

    portEXIT_CRITICAL(mux);
    return ok;
  }

  RingStats snapshot(portMUX_TYPE *mux) {
    RingStats s;

    portENTER_CRITICAL(mux);

    s.produced = produced;
    s.enqueued = enqueued;
    s.consumed = consumed;
    s.overflows = overflows;
    s.depth = (uint16_t)count;
    s.highWater = (uint16_t)highWater;

    portEXIT_CRITICAL(mux);

    return s;
  }
};

// ============================================================
//                   SENSOR RING BUFFERS
// ============================================================

constexpr size_t ECG_BUFFER_CAPACITY  = 1024;
constexpr size_t PPG_BUFFER_CAPACITY  = 512;
constexpr size_t GSR_BUFFER_CAPACITY  = 512;
constexpr size_t IMU_BUFFER_CAPACITY  = 512;
constexpr size_t TEMP_BUFFER_CAPACITY = 32;

SampleRingBuffer<EcgSample, ECG_BUFFER_CAPACITY> ecgBuffer;
SampleRingBuffer<PpgSample, PPG_BUFFER_CAPACITY> ppgBuffer;
SampleRingBuffer<GsrSample, GSR_BUFFER_CAPACITY> gsrBuffer;
SampleRingBuffer<ImuSample, IMU_BUFFER_CAPACITY> imuBuffer;
SampleRingBuffer<TempSample, TEMP_BUFFER_CAPACITY> tempBuffer;

portMUX_TYPE ecgBufferMux  = portMUX_INITIALIZER_UNLOCKED;
portMUX_TYPE ppgBufferMux  = portMUX_INITIALIZER_UNLOCKED;
portMUX_TYPE gsrBufferMux  = portMUX_INITIALIZER_UNLOCKED;
portMUX_TYPE imuBufferMux  = portMUX_INITIALIZER_UNLOCKED;
portMUX_TYPE tempBufferMux = portMUX_INITIALIZER_UNLOCKED;

portMUX_TYPE runtimeMux = portMUX_INITIALIZER_UNLOCKED;
portMUX_TYPE networkMux = portMUX_INITIALIZER_UNLOCKED;

// ============================================================
//                 ACQUISITION HEALTH COUNTERS
// ============================================================

volatile uint32_t ecgMissed = 0;
volatile uint32_t ppgServiceMissed = 0;
volatile uint32_t gsrMissed = 0;
volatile uint32_t imuMissed = 0;
volatile uint32_t tempMissed = 0;

volatile uint32_t i2cErrors = 0;
volatile int32_t ecgMaxLateUs = 0;

volatile uint32_t ppgTimestampCorrections = 0;
volatile uint32_t ppgFutureErrors = 0;

uint32_t futureTimestampErrorsTotal = 0;
uint32_t excessiveSpanErrorsTotal = 0;

uint32_t ecgOrderErrors = 0;
uint32_t ppgOrderErrors = 0;
uint32_t gsrOrderErrors = 0;
uint32_t imuOrderErrors = 0;
uint32_t tempOrderErrors = 0;

int64_t lastEcgTimestamp = 0;
int64_t lastPpgTimestampConsumer = 0;
int64_t lastGsrTimestamp = 0;
int64_t lastImuTimestamp = 0;
int64_t lastTempTimestamp = 0;

// ============================================================
//                       BATCH PACKET
// ============================================================

constexpr size_t BATCH_ECG_MAX  = 64;
constexpr size_t BATCH_PPG_MAX  = 32;
constexpr size_t BATCH_GSR_MAX  = 32;
constexpr size_t BATCH_IMU_MAX  = 32;
constexpr size_t BATCH_TEMP_MAX = 4;

struct BatchPacket {
  uint32_t sequence;

  int64_t created_us;
  int64_t t0_us;
  int64_t t1_us;

  bool truncated;

  uint16_t ecgCount;
  uint16_t ppgCount;
  uint16_t gsrCount;
  uint16_t imuCount;
  uint16_t tempCount;

  EcgSample ecg[BATCH_ECG_MAX];
  PpgSample ppg[BATCH_PPG_MAX];
  GsrSample gsr[BATCH_GSR_MAX];
  ImuSample imu[BATCH_IMU_MAX];
  TempSample temp[BATCH_TEMP_MAX];
};

BatchPacket currentBatch;

char sessionId[32];
uint32_t nextSequence = 0;

// ============================================================
//                    JSON SERIALIZATION
// ============================================================

constexpr size_t JSON_BUFFER_SIZE = 8192;

char lastJson[JSON_BUFFER_SIZE];
size_t lastJsonLength = 0;
uint32_t lastJsonSequence = 0;

uint32_t packetsBuiltWindow = 0;
uint32_t packetsSerializedWindow = 0;
uint32_t packetTruncationsTotal = 0;
uint32_t serializationErrorsTotal = 0;
uint32_t batchScheduleMissesTotal = 0;

uint32_t bytesSerializedWindow = 0;
uint32_t maxPacketBytesWindow = 0;

// ============================================================
//                     NETWORK QUEUE
// ============================================================
// The observed V4 packets were ~1.35 KB.
// 2048 B intentionally leaves headroom while also detecting an
// unexpectedly large transport packet instead of silently hiding it.

constexpr size_t NETWORK_PAYLOAD_MAX = 2048;
constexpr uint8_t NETWORK_QUEUE_LENGTH = 8;

struct NetworkFrame {
  uint32_t sequence;
  uint16_t length;
  char payload[NETWORK_PAYLOAD_MAX];
};

QueueHandle_t networkQueue = nullptr;

// Packetizer -> network counters.
volatile uint32_t netEnqueuedWindow = 0;
volatile uint32_t netSentWindow = 0;
volatile uint32_t netBytesSentWindow = 0;

volatile uint32_t netQueueDropsTotal = 0;
volatile uint32_t netDisconnectedDropsTotal = 0;
volatile uint32_t netOversizeDropsTotal = 0;
volatile uint32_t netSendFailuresTotal = 0;

volatile uint16_t netQueueHighWater = 0;

volatile bool wsConnected = false;
volatile uint32_t wsConnectEvents = 0;
volatile uint32_t wsDisconnectEvents = 0;
volatile uint32_t wsErrorEvents = 0;
volatile uint32_t wsTextEvents = 0;

// End-to-end application ACK health.
// The Ubuntu receiver sends "ACK:<seq>" for every valid packet.
volatile uint32_t lastAckSeq = 0;
volatile uint32_t lastAckMillis = 0;
volatile uint32_t ackEvents = 0;
volatile uint32_t ackTimeoutsTotal = 0;
volatile uint32_t forcedReconnectsTotal = 0;
volatile uint32_t recoveryQueueDropsTotal = 0;

constexpr uint32_t ACK_TIMEOUT_MS = 3000;

// ============================================================
//                        I2C HELPERS
// ============================================================

void recordI2CError() {
  portENTER_CRITICAL(&runtimeMux);
  i2cErrors++;
  portEXIT_CRITICAL(&runtimeMux);
}

bool i2cProbe(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission() == 0;
}

bool i2cWriteByte(uint8_t address, uint8_t reg, uint8_t value) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  Wire.write(value);

  uint8_t result = Wire.endTransmission();

  if (result != 0) {
    recordI2CError();
    return false;
  }

  return true;
}

bool i2cReadBytes(
    uint8_t address,
    uint8_t reg,
    uint8_t *buffer,
    uint8_t length) {

  Wire.beginTransmission(address);
  Wire.write(reg);

  if (Wire.endTransmission(false) != 0) {
    recordI2CError();
    return false;
  }

  uint8_t received = Wire.requestFrom(address, length);

  if (received != length) {
    recordI2CError();

    while (Wire.available()) {
      Wire.read();
    }

    return false;
  }

  for (uint8_t i = 0; i < length; i++) {
    buffer[i] = Wire.read();
  }

  return true;
}

// ============================================================
//                         MPU6050
// ============================================================

bool initMPU6050() {
  if (!i2cWriteByte(MPU6050_ADDR, 0x6B, 0x80)) return false;

  delay(100);

  if (!i2cWriteByte(MPU6050_ADDR, 0x6B, 0x01)) return false;
  if (!i2cWriteByte(MPU6050_ADDR, 0x1A, 0x03)) return false;
  if (!i2cWriteByte(MPU6050_ADDR, 0x19, 9))    return false; // 100 Hz
  if (!i2cWriteByte(MPU6050_ADDR, 0x1B, 0x00)) return false; // +-250 dps
  if (!i2cWriteByte(MPU6050_ADDR, 0x1C, 0x00)) return false; // +-2 g

  return true;
}

void acquireMPU6050() {
  uint8_t data[14];

  int64_t timestamp = esp_timer_get_time();

  if (!i2cReadBytes(MPU6050_ADDR, 0x3B, data, 14)) {
    return;
  }

  ImuSample sample;

  sample.timestamp_us = timestamp;

  sample.axRaw = ((int16_t)data[0] << 8) | data[1];
  sample.ayRaw = ((int16_t)data[2] << 8) | data[3];
  sample.azRaw = ((int16_t)data[4] << 8) | data[5];

  sample.gxRaw = ((int16_t)data[8]  << 8) | data[9];
  sample.gyRaw = ((int16_t)data[10] << 8) | data[11];
  sample.gzRaw = ((int16_t)data[12] << 8) | data[13];

  imuBuffer.push(sample, &imuBufferMux);
}

// ============================================================
//                          TMP117
// ============================================================

void acquireTMP117() {
  uint8_t data[2];

  int64_t timestamp = esp_timer_get_time();

  if (!i2cReadBytes(TMP117_ADDR, 0x00, data, 2)) {
    return;
  }

  TempSample sample;

  sample.timestamp_us = timestamp;
  sample.raw = ((int16_t)data[0] << 8) | data[1];

  tempBuffer.push(sample, &tempBufferMux);
}

// ============================================================
//                         TinyGSR
// ============================================================

void acquireGSR() {
  GsrSample sample;

  sample.timestamp_us = esp_timer_get_time();
  sample.raw = tla2022.read_adc();

  gsrBuffer.push(sample, &gsrBufferMux);
}

// ============================================================
//                         MAX30101
// ============================================================

int64_t lastPpgTimestampProducer = 0;

void servicePPGFIFO() {
  ppgSensor.check();

  int availableSamples = ppgSensor.available();

  if (availableSamples <= 0) {
    return;
  }

  // Every sample in the FIFO existed no later than this observation.
  int64_t observedNow = esp_timer_get_time();

  int64_t firstTimestamp =
      observedNow -
      ((int64_t)(availableSamples - 1) * PPG_SAMPLE_PERIOD_US);

  if (lastPpgTimestampProducer != 0 &&
      firstTimestamp <= lastPpgTimestampProducer) {

    firstTimestamp = lastPpgTimestampProducer + 1;

    portENTER_CRITICAL(&runtimeMux);
    ppgTimestampCorrections++;
    portEXIT_CRITICAL(&runtimeMux);
  }

  int64_t spacingUs = PPG_SAMPLE_PERIOD_US;

  if (availableSamples > 1) {
    int64_t predictedLast =
        firstTimestamp +
        ((int64_t)(availableSamples - 1) * spacingUs);

    // Never generate a timestamp in the future.
    if (predictedLast > observedNow) {
      if (lastPpgTimestampProducer != 0 &&
          observedNow > lastPpgTimestampProducer) {

        int64_t availableTime =
            observedNow - lastPpgTimestampProducer;

        spacingUs = availableTime / availableSamples;

        if (spacingUs < 1) {
          spacingUs = 1;
        }

        firstTimestamp =
            lastPpgTimestampProducer + spacingUs;
      } else {
        firstTimestamp = observedNow - (availableSamples - 1);
        spacingUs = 1;
      }

      portENTER_CRITICAL(&runtimeMux);
      ppgTimestampCorrections++;
      portEXIT_CRITICAL(&runtimeMux);
    }
  }

  int index = 0;

  while (ppgSensor.available()) {
    PpgSample sample;

    sample.timestamp_us =
        firstTimestamp + ((int64_t)index * spacingUs);

    if (sample.timestamp_us > observedNow) {
      sample.timestamp_us = observedNow;

      portENTER_CRITICAL(&runtimeMux);
      ppgFutureErrors++;
      portEXIT_CRITICAL(&runtimeMux);
    }

    if (lastPpgTimestampProducer != 0 &&
        sample.timestamp_us <= lastPpgTimestampProducer) {

      if (lastPpgTimestampProducer < observedNow) {
        sample.timestamp_us = lastPpgTimestampProducer + 1;
      } else {
        sample.timestamp_us = observedNow;

        portENTER_CRITICAL(&runtimeMux);
        ppgFutureErrors++;
        portEXIT_CRITICAL(&runtimeMux);
      }

      portENTER_CRITICAL(&runtimeMux);
      ppgTimestampCorrections++;
      portEXIT_CRITICAL(&runtimeMux);
    }

    sample.red = ppgSensor.getFIFORed();
    sample.ir  = ppgSensor.getFIFOIR();

    ppgBuffer.push(sample, &ppgBufferMux);

    lastPpgTimestampProducer = sample.timestamp_us;

    ppgSensor.nextSample();
    index++;
  }
}

// ============================================================
//                    DEADLINE HELPER
// ============================================================

uint32_t advanceDeadline(
    int64_t now,
    int64_t &deadline,
    int64_t period) {

  if (now < deadline) {
    return 0;
  }

  int64_t lateness = now - deadline;
  uint32_t missed = (uint32_t)(lateness / period);

  deadline += ((int64_t)missed + 1) * period;

  return missed;
}

// ============================================================
//                         ECG TASK
// ============================================================

void ecgTask(void *parameter) {
  int64_t nextSample =
      esp_timer_get_time() + ECG_PERIOD_US;

  while (true) {
    int64_t now = esp_timer_get_time();
    int64_t remaining = nextSample - now;

    if (remaining > 1500) {
      vTaskDelay(pdMS_TO_TICKS(1));
      continue;
    }

    if (remaining > 0) {
      delayMicroseconds((uint32_t)remaining);
    }

    now = esp_timer_get_time();

    uint32_t missed = 0;
    int64_t lateness = now - nextSample;

    if (lateness >= ECG_PERIOD_US) {
      missed = (uint32_t)(lateness / ECG_PERIOD_US);
      nextSample += (int64_t)missed * ECG_PERIOD_US;
    }

    EcgSample sample;

    sample.timestamp_us = esp_timer_get_time();
    sample.adc = (uint16_t)analogRead(ECG_PIN);
    sample.loPlus = (uint8_t)digitalRead(ECG_LO_PLUS);
    sample.loMinus = (uint8_t)digitalRead(ECG_LO_MINUS);

    int32_t actualLate =
        (int32_t)(sample.timestamp_us - nextSample);

    ecgBuffer.push(sample, &ecgBufferMux);

    portENTER_CRITICAL(&runtimeMux);

    ecgMissed += missed;

    if (actualLate > ecgMaxLateUs) {
      ecgMaxLateUs = actualLate;
    }

    portEXIT_CRITICAL(&runtimeMux);

    nextSample += ECG_PERIOD_US;
  }
}

// ============================================================
//                      I2C SENSOR TASK
// ============================================================

void i2cSensorTask(void *parameter) {
  int64_t start = esp_timer_get_time();

  int64_t nextPPG  = start + PPG_SERVICE_PERIOD_US;
  int64_t nextGSR  = start + GSR_PERIOD_US;
  int64_t nextIMU  = start + IMU_PERIOD_US;
  int64_t nextTEMP = start + TEMP_PERIOD_US;

  while (true) {
    bool didWork = false;

    int64_t now = esp_timer_get_time();

    if (now >= nextPPG) {
      uint32_t missed =
          advanceDeadline(now, nextPPG, PPG_SERVICE_PERIOD_US);

      if (missed > 0) {
        portENTER_CRITICAL(&runtimeMux);
        ppgServiceMissed += missed;
        portEXIT_CRITICAL(&runtimeMux);
      }

      servicePPGFIFO();
      didWork = true;
    }

    now = esp_timer_get_time();

    if (now >= nextGSR) {
      uint32_t missed =
          advanceDeadline(now, nextGSR, GSR_PERIOD_US);

      if (missed > 0) {
        portENTER_CRITICAL(&runtimeMux);
        gsrMissed += missed;
        portEXIT_CRITICAL(&runtimeMux);
      }

      acquireGSR();
      didWork = true;
    }

    now = esp_timer_get_time();

    if (now >= nextIMU) {
      uint32_t missed =
          advanceDeadline(now, nextIMU, IMU_PERIOD_US);

      if (missed > 0) {
        portENTER_CRITICAL(&runtimeMux);
        imuMissed += missed;
        portEXIT_CRITICAL(&runtimeMux);
      }

      acquireMPU6050();
      didWork = true;
    }

    now = esp_timer_get_time();

    if (now >= nextTEMP) {
      uint32_t missed =
          advanceDeadline(now, nextTEMP, TEMP_PERIOD_US);

      if (missed > 0) {
        portENTER_CRITICAL(&runtimeMux);
        tempMissed += missed;
        portEXIT_CRITICAL(&runtimeMux);
      }

      acquireTMP117();
      didWork = true;
    }

    if (!didWork) {
      vTaskDelay(pdMS_TO_TICKS(1));
    }
  }
}

// ============================================================
//                       BATCH BUILDING
// ============================================================

void updateBatchBounds(BatchPacket &batch, int64_t timestamp) {
  if (timestamp < batch.t0_us) batch.t0_us = timestamp;
  if (timestamp > batch.t1_us) batch.t1_us = timestamp;
}

template <typename T, size_t RingCapacity, size_t BatchCapacity>
void collectIntoBatch(
    SampleRingBuffer<T, RingCapacity> &ring,
    portMUX_TYPE *mux,
    T (&destination)[BatchCapacity],
    uint16_t &count,
    BatchPacket &batch,
    int64_t &lastTimestamp,
    uint32_t &orderErrors) {

  T sample;

  while (count < BatchCapacity &&
         ring.pop(sample, mux)) {

    if (lastTimestamp != 0 &&
        sample.timestamp_us <= lastTimestamp) {
      orderErrors++;
    }

    lastTimestamp = sample.timestamp_us;

    destination[count++] = sample;

    updateBatchBounds(batch, sample.timestamp_us);
  }

  if (count >= BatchCapacity) {
    RingStats stats = ring.snapshot(mux);

    if (stats.depth > 0) {
      batch.truncated = true;
    }
  }
}

void buildBatch(BatchPacket &batch) {
  batch.sequence = nextSequence++;

  // IMPORTANT:
  // created_us is the time at which this batch has FINISHED
  // collecting its samples. Acquisition tasks continue running
  // concurrently while the packetizer drains the ring buffers.
  //
  // Capturing created_us before the drains can therefore make a
  // perfectly valid sample appear to be "from the future".
  batch.created_us = 0;

  batch.t0_us = INT64_MAX;
  batch.t1_us = INT64_MIN;

  batch.truncated = false;

  batch.ecgCount = 0;
  batch.ppgCount = 0;
  batch.gsrCount = 0;
  batch.imuCount = 0;
  batch.tempCount = 0;

  collectIntoBatch(
      ecgBuffer, &ecgBufferMux,
      batch.ecg, batch.ecgCount,
      batch, lastEcgTimestamp, ecgOrderErrors);

  collectIntoBatch(
      ppgBuffer, &ppgBufferMux,
      batch.ppg, batch.ppgCount,
      batch, lastPpgTimestampConsumer, ppgOrderErrors);

  collectIntoBatch(
      gsrBuffer, &gsrBufferMux,
      batch.gsr, batch.gsrCount,
      batch, lastGsrTimestamp, gsrOrderErrors);

  collectIntoBatch(
      imuBuffer, &imuBufferMux,
      batch.imu, batch.imuCount,
      batch, lastImuTimestamp, imuOrderErrors);

  collectIntoBatch(
      tempBuffer, &tempBufferMux,
      batch.temp, batch.tempCount,
      batch, lastTempTimestamp, tempOrderErrors);

  // Take creation time only AFTER every sample that belongs to
  // this packet has been copied out of the acquisition buffers.
  batch.created_us = esp_timer_get_time();

  if (batch.t0_us == INT64_MAX) {
    batch.t0_us = batch.created_us;
    batch.t1_us = batch.created_us;
  }
}

// ============================================================
//                     JSON SERIALIZATION
// ============================================================

bool appendFormat(
    char *buffer,
    size_t capacity,
    size_t &position,
    const char *format,
    ...) {

  if (position >= capacity) {
    return false;
  }

  va_list args;
  va_start(args, format);

  int written =
      vsnprintf(
          buffer + position,
          capacity - position,
          format,
          args);

  va_end(args);

  if (written < 0) {
    return false;
  }

  if ((size_t)written >= (capacity - position)) {
    buffer[capacity - 1] = '\0';
    return false;
  }

  position += (size_t)written;
  return true;
}

bool serializeBatchJSON(
    const BatchPacket &batch,
    char *output,
    size_t outputCapacity,
    size_t &outputLength) {

  size_t pos = 0;

  if (!appendFormat(
          output, outputCapacity, pos,
          "{"
          "\"schema\":1,"
          "\"session_id\":\"%s\","
          "\"seq\":%lu,"
          "\"timebase\":\"esp_timer_us\","
          "\"created_us\":%lld,"
          "\"t0_us\":%lld,"
          "\"t1_us\":%lld,"
          "\"truncated\":%u,"
          "\"n\":[%u,%u,%u,%u,%u],",

          sessionId,
          (unsigned long)batch.sequence,
          (long long)batch.created_us,
          (long long)batch.t0_us,
          (long long)batch.t1_us,
          batch.truncated ? 1 : 0,
          batch.ecgCount,
          batch.ppgCount,
          batch.gsrCount,
          batch.imuCount,
          batch.tempCount)) {
    return false;
  }

  // ECG: [dt_us, adc, lo+, lo-]
  if (!appendFormat(output, outputCapacity, pos, "\"ecg\":[")) return false;

  for (uint16_t i = 0; i < batch.ecgCount; i++) {
    const EcgSample &s = batch.ecg[i];
    int64_t dt = s.timestamp_us - batch.t0_us;

    if (i > 0 && !appendFormat(output, outputCapacity, pos, ",")) return false;

    if (!appendFormat(
            output, outputCapacity, pos,
            "[%lld,%u,%u,%u]",
            (long long)dt,
            s.adc,
            s.loPlus,
            s.loMinus)) {
      return false;
    }
  }

  if (!appendFormat(output, outputCapacity, pos, "],")) return false;

  // PPG: [dt_us, red, ir]
  if (!appendFormat(output, outputCapacity, pos, "\"ppg\":[")) return false;

  for (uint16_t i = 0; i < batch.ppgCount; i++) {
    const PpgSample &s = batch.ppg[i];
    int64_t dt = s.timestamp_us - batch.t0_us;

    if (i > 0 && !appendFormat(output, outputCapacity, pos, ",")) return false;

    if (!appendFormat(
            output, outputCapacity, pos,
            "[%lld,%lu,%lu]",
            (long long)dt,
            (unsigned long)s.red,
            (unsigned long)s.ir)) {
      return false;
    }
  }

  if (!appendFormat(output, outputCapacity, pos, "],")) return false;

  // GSR: [dt_us, raw]
  if (!appendFormat(output, outputCapacity, pos, "\"gsr\":[")) return false;

  for (uint16_t i = 0; i < batch.gsrCount; i++) {
    const GsrSample &s = batch.gsr[i];
    int64_t dt = s.timestamp_us - batch.t0_us;

    if (i > 0 && !appendFormat(output, outputCapacity, pos, ",")) return false;

    if (!appendFormat(
            output, outputCapacity, pos,
            "[%lld,%d]",
            (long long)dt,
            s.raw)) {
      return false;
    }
  }

  if (!appendFormat(output, outputCapacity, pos, "],")) return false;

  // IMU: [dt_us, ax, ay, az, gx, gy, gz]
  if (!appendFormat(output, outputCapacity, pos, "\"imu\":[")) return false;

  for (uint16_t i = 0; i < batch.imuCount; i++) {
    const ImuSample &s = batch.imu[i];
    int64_t dt = s.timestamp_us - batch.t0_us;

    if (i > 0 && !appendFormat(output, outputCapacity, pos, ",")) return false;

    if (!appendFormat(
            output, outputCapacity, pos,
            "[%lld,%d,%d,%d,%d,%d,%d]",
            (long long)dt,
            s.axRaw,
            s.ayRaw,
            s.azRaw,
            s.gxRaw,
            s.gyRaw,
            s.gzRaw)) {
      return false;
    }
  }

  if (!appendFormat(output, outputCapacity, pos, "],")) return false;

  // TEMP: [dt_us, raw]
  if (!appendFormat(output, outputCapacity, pos, "\"temp\":[")) return false;

  for (uint16_t i = 0; i < batch.tempCount; i++) {
    const TempSample &s = batch.temp[i];
    int64_t dt = s.timestamp_us - batch.t0_us;

    if (i > 0 && !appendFormat(output, outputCapacity, pos, ",")) return false;

    if (!appendFormat(
            output, outputCapacity, pos,
            "[%lld,%d]",
            (long long)dt,
            s.raw)) {
      return false;
    }
  }

  if (!appendFormat(output, outputCapacity, pos, "]}")) return false;

  outputLength = pos;
  return true;
}

// ============================================================
//                    WEBSOCKET EVENTS
// ============================================================

void webSocketEvent(
    WStype_t type,
    uint8_t *payload,
    size_t length) {

  switch (type) {
    case WStype_CONNECTED: {
      portENTER_CRITICAL(&networkMux);

      wsConnected = true;
      wsConnectEvents++;

      // Start a fresh ACK watchdog window for this connection.
      lastAckMillis = millis();

      portEXIT_CRITICAL(&networkMux);
      break;
    }

    case WStype_DISCONNECTED: {
      portENTER_CRITICAL(&networkMux);

      wsConnected = false;
      wsDisconnectEvents++;

      portEXIT_CRITICAL(&networkMux);
      break;
    }

    case WStype_ERROR: {
      portENTER_CRITICAL(&networkMux);
      wsErrorEvents++;
      portEXIT_CRITICAL(&networkMux);
      break;
    }

    case WStype_TEXT: {
      portENTER_CRITICAL(&networkMux);
      wsTextEvents++;
      portEXIT_CRITICAL(&networkMux);

      // The test receiver replies with ASCII: ACK:<uint32 sequence>
      if (payload != nullptr && length >= 5) {
        char ackBuffer[32];

        size_t copyLength =
            (length < sizeof(ackBuffer) - 1)
                ? length
                : sizeof(ackBuffer) - 1;

        memcpy(ackBuffer, payload, copyLength);
        ackBuffer[copyLength] = '\0';

        unsigned long sequence = 0;

        if (sscanf(
                ackBuffer,
                "ACK:%lu",
                &sequence) == 1) {

          portENTER_CRITICAL(&networkMux);

          lastAckSeq = (uint32_t)sequence;
          lastAckMillis = millis();
          ackEvents++;

          portEXIT_CRITICAL(&networkMux);
        }
      }

      break;
    }

    default:
      break;
  }
}

// ============================================================
//                 PACKETIZER -> NETWORK QUEUE
// ============================================================

void enqueueForNetwork(
    const char *json,
    size_t length,
    uint32_t sequence) {

  bool connected;

  portENTER_CRITICAL(&networkMux);
  connected = wsConnected;
  portEXIT_CRITICAL(&networkMux);

  // Live stream policy: do not build a stale backlog while offline.
  if (!connected) {
    portENTER_CRITICAL(&networkMux);
    netDisconnectedDropsTotal++;
    portEXIT_CRITICAL(&networkMux);
    return;
  }

  if (length >= NETWORK_PAYLOAD_MAX) {
    portENTER_CRITICAL(&networkMux);
    netOversizeDropsTotal++;
    portEXIT_CRITICAL(&networkMux);
    return;
  }

  static NetworkFrame frame;

  frame.sequence = sequence;
  frame.length = (uint16_t)length;

  memcpy(frame.payload, json, length);
  frame.payload[length] = '\0';

  if (xQueueSend(networkQueue, &frame, 0) != pdTRUE) {
    portENTER_CRITICAL(&networkMux);
    netQueueDropsTotal++;
    portEXIT_CRITICAL(&networkMux);
    return;
  }

  UBaseType_t depth = uxQueueMessagesWaiting(networkQueue);

  portENTER_CRITICAL(&networkMux);

  netEnqueuedWindow++;

  if (depth > netQueueHighWater) {
    netQueueHighWater = (uint16_t)depth;
  }

  portEXIT_CRITICAL(&networkMux);
}

// ============================================================
//                 NETWORK RECOVERY HELPERS
// ============================================================

uint32_t discardNetworkQueue() {
  NetworkFrame dropped;
  uint32_t count = 0;

  while (xQueueReceive(
             networkQueue,
             &dropped,
             0) == pdTRUE) {
    count++;
  }

  if (count > 0) {
    portENTER_CRITICAL(&networkMux);
    recoveryQueueDropsTotal += count;
    portEXIT_CRITICAL(&networkMux);
  }

  return count;
}

void forceWebSocketReconnect() {
  // Stop the producer from feeding a socket that we already know is bad.
  portENTER_CRITICAL(&networkMux);

  wsConnected = false;
  forcedReconnectsTotal++;

  portEXIT_CRITICAL(&networkMux);

  // We are a live stream. Old queued packets are explicitly discarded
  // instead of being replayed after reconnection.
  discardNetworkQueue();

  // This moves arduinoWebSockets back to WSC_NOT_CONNECTED.
  // Its configured reconnect interval will then establish a fresh TCP/WS
  // connection from webSocket.loop().
  webSocket.disconnect();
}

// ============================================================
//                      NETWORK TASK
// ============================================================
// This is the ONLY task that calls webSocket.loop()/sendTXT().
// A slow or broken network therefore cannot block sensor
// acquisition or the packetizer.

void networkTask(void *parameter) {
  NetworkFrame frame;

  bool wsStartedForCurrentWiFi = false;

  int64_t lastWiFiReconnectAttempt = 0;

  while (true) {
    bool wifiUp =
        (WiFi.status() == WL_CONNECTED);

    if (!wifiUp) {
      if (wsStartedForCurrentWiFi) {
        webSocket.disconnect();
        wsStartedForCurrentWiFi = false;
      }

      portENTER_CRITICAL(&networkMux);
      wsConnected = false;
      portEXIT_CRITICAL(&networkMux);

      discardNetworkQueue();

      int64_t now = esp_timer_get_time();

      if (now - lastWiFiReconnectAttempt >= 5000000LL) {
        WiFi.reconnect();
        lastWiFiReconnectAttempt = now;
      }

      vTaskDelay(pdMS_TO_TICKS(50));
      continue;
    }

    if (!wsStartedForCurrentWiFi) {
      webSocket.begin(
          WS_HOST,
          WS_PORT,
          WS_PATH);

      webSocket.setReconnectInterval(2000);

      // Keep the protocol-level heartbeat too. The application ACK watchdog
      // below is stricter: it proves that complete sensor packets are
      // actually reaching the Ubuntu process and replies are returning.
      webSocket.enableHeartbeat(
          5000,
          1500,
          2);

      wsStartedForCurrentWiFi = true;
    }

    // This must run continuously for connection management and inbound ACKs.
    webSocket.loop();

    bool connected =
        webSocket.isConnected();

    portENTER_CRITICAL(&networkMux);
    wsConnected = connected;
    uint32_t ackMillisSnapshot = lastAckMillis;
    portEXIT_CRITICAL(&networkMux);

    if (!connected) {
      discardNetworkQueue();
      vTaskDelay(pdMS_TO_TICKS(5));
      continue;
    }

    // End-to-end liveness watchdog.
    //
    // Public WebSocketsClient::isConnected() reflects the library's
    // websocket state. A half-open TCP path can temporarily leave that state
    // looking connected even though the receiver is no longer getting data.
    // Valid receiver ACKs are therefore our source of truth.
    uint32_t nowMs = millis();

    if ((uint32_t)(nowMs - ackMillisSnapshot) >
        ACK_TIMEOUT_MS) {

      portENTER_CRITICAL(&networkMux);
      ackTimeoutsTotal++;
      portEXIT_CRITICAL(&networkMux);

      forceWebSocketReconnect();

      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }

    // Send at most one frame, then immediately return to webSocket.loop().
    if (xQueueReceive(
            networkQueue,
            &frame,
            0) == pdTRUE) {

      bool ok =
          webSocket.sendTXT(
              frame.payload,
              frame.length);

      if (ok) {
        portENTER_CRITICAL(&networkMux);

        netSentWindow++;
        netBytesSentWindow += frame.length;

        portEXIT_CRITICAL(&networkMux);
      } else {
        // sendTXT() returning false is a hard transport failure for this
        // live stream. Do not keep feeding the same half-open connection.
        portENTER_CRITICAL(&networkMux);
        netSendFailuresTotal++;
        portEXIT_CRITICAL(&networkMux);

        forceWebSocketReconnect();

        vTaskDelay(pdMS_TO_TICKS(20));
      }
    } else {
      vTaskDelay(pdMS_TO_TICKS(1));
    }
  }
}

// ============================================================
//                       FATAL ERROR
// ============================================================

void fatalError(const char *message) {
  Serial.println();
  Serial.println("======================================");
  Serial.println("FATAL ERROR");
  Serial.println(message);
  Serial.println("======================================");

  while (true) {
    delay(1000);
  }
}

// ============================================================
//                           SETUP
// ============================================================

void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println();
  Serial.println("==========================================");
  Serial.println("ESP32 FIVE-SENSOR ACQUISITION V5.2");
  Serial.println("Wi-Fi + QUEUED WEBSOCKET TRANSPORT");
  Serial.println("==========================================");

  // Local prototype session identifier.
  uint64_t chip = ESP.getEfuseMac();
  uint32_t bootRandom = esp_random();

  snprintf(
      sessionId,
      sizeof(sessionId),
      "%08lX-%08lX",
      (unsigned long)(chip & 0xFFFFFFFFULL),
      (unsigned long)bootRandom);

  Serial.print("Session: ");
  Serial.println(sessionId);

  // --------------------------------------------------------
  // I2C
  // --------------------------------------------------------

  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(100000);

  if (!i2cProbe(TMP117_ADDR))  fatalError("TMP117 missing @ 0x48");
  if (!i2cProbe(TINYGSR_ADDR)) fatalError("TinyGSR missing @ 0x49");
  if (!i2cProbe(MAX30101_ADDR)) fatalError("MAX30101 missing @ 0x57");
  if (!i2cProbe(MPU6050_ADDR)) fatalError("MPU6050 missing @ 0x68");

  Serial.println("I2C devices detected");

  // --------------------------------------------------------
  // ECG
  // --------------------------------------------------------

  pinMode(ECG_PIN, INPUT);
  pinMode(ECG_LO_PLUS, INPUT);
  pinMode(ECG_LO_MINUS, INPUT);

  analogReadResolution(12);

  // --------------------------------------------------------
  // Wired interrupt pins (still unused)
  // --------------------------------------------------------

  pinMode(MAX30101_INT, INPUT);
  pinMode(MPU6050_INT, INPUT);
  pinMode(TMP117_INT, INPUT);

  // --------------------------------------------------------
  // TinyGSR
  // --------------------------------------------------------

  tla2022.begin();
  tla2022.setMode(TLA20XX::OP_CONTINUOUS);
  tla2022.setDR(TLA20XX::DR_128SPS);
  tla2022.setFSR(TLA20XX::FSR_0_512V);

  // --------------------------------------------------------
  // MPU6050
  // --------------------------------------------------------

  if (!initMPU6050()) {
    fatalError("MPU6050 initialization failed");
  }

  // --------------------------------------------------------
  // MAX30101
  // --------------------------------------------------------

  if (!ppgSensor.begin(Wire, I2C_SPEED_STANDARD)) {
    fatalError("MAX30101 initialization failed");
  }

  byte ledBrightness = 0x1F;
  byte sampleAverage = 1;
  byte ledMode = 2;
  int sampleRate = 100;
  int pulseWidth = 411;
  int adcRange = 4096;

  ppgSensor.setup(
      ledBrightness,
      sampleAverage,
      ledMode,
      sampleRate,
      pulseWidth,
      adcRange);

  ppgSensor.clearFIFO();

  // --------------------------------------------------------
  // Network queue
  // --------------------------------------------------------

  networkQueue =
      xQueueCreate(
          NETWORK_QUEUE_LENGTH,
          sizeof(NetworkFrame));

  if (networkQueue == nullptr) {
    fatalError("Could not create network queue");
  }

  // --------------------------------------------------------
  // Wi-Fi
  // --------------------------------------------------------

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  webSocket.onEvent(webSocketEvent);

  Serial.print("Wi-Fi connecting to: ");
  Serial.println(WIFI_SSID);

  Serial.print("WebSocket target: ws://");
  Serial.print(WS_HOST);
  Serial.print(":");
  Serial.print(WS_PORT);
  Serial.println(WS_PATH);

  // --------------------------------------------------------
  // Acquisition tasks
  // --------------------------------------------------------

  BaseType_t ecgResult =
      xTaskCreatePinnedToCore(
          ecgTask,
          "ECG_Task",
          4096,
          nullptr,
          4,
          nullptr,
          1);

  if (ecgResult != pdPASS) {
    fatalError("Could not create ECG task");
  }

  // Wi-Fi/TCP work on ESP32 is concentrated on Core 0 and was
  // measurably disturbing the 100/128 Hz I2C schedules when the
  // I2C acquisition task was also pinned there.
  //
  // Keep both acquisition tasks on Core 1:
  //   ECG: priority 4
  //   I2C: priority 3
  //
  // ECG always pre-empts I2C at its 4 ms deadline. The packetizer
  // (Arduino loop) is lower priority and runs in the remaining time.
  BaseType_t i2cResult =
      xTaskCreatePinnedToCore(
          i2cSensorTask,
          "I2C_Sensor_Task",
          8192,
          nullptr,
          3,
          nullptr,
          1);

  if (i2cResult != pdPASS) {
    fatalError("Could not create I2C task");
  }

  // Networking remains isolated on Core 0.
  BaseType_t netResult =
      xTaskCreatePinnedToCore(
          networkTask,
          "Network_Task",
          12288,
          nullptr,
          1,
          nullptr,
          0);

  if (netResult != pdPASS) {
    fatalError("Could not create network task");
  }

  Serial.println();
  Serial.println("ECG task     -> Core 1 / priority 4");
  Serial.println("I2C task     -> Core 1 / priority 3");
  Serial.println("Network task -> Core 0 / priority 1");
  Serial.println("Packetizer   -> Arduino loop / 100 ms");
  Serial.println();
}

// ============================================================
//                            LOOP
// ============================================================

void loop() {
  static bool initialized = false;

  static int64_t nextBatch = 0;
  static int64_t nextDiagnostic = 0;

  static RingStats previousECG = {};
  static RingStats previousPPG = {};
  static RingStats previousGSR = {};
  static RingStats previousIMU = {};
  static RingStats previousTEMP = {};

  if (!initialized) {
    int64_t now = esp_timer_get_time();

    nextBatch = now + BATCH_PERIOD_US;
    nextDiagnostic = now + DIAGNOSTIC_PERIOD_US;

    initialized = true;
  }

  int64_t now = esp_timer_get_time();

  // ========================================================
  // 100 ms PACKETIZER
  // ========================================================

  if (now >= nextBatch) {
    int64_t lateness = now - nextBatch;

    uint32_t missedWindows =
        (uint32_t)(lateness / BATCH_PERIOD_US);

    if (missedWindows > 0) {
      batchScheduleMissesTotal += missedWindows;
    }

    nextBatch +=
        ((int64_t)missedWindows + 1) *
        BATCH_PERIOD_US;

    buildBatch(currentBatch);

    packetsBuiltWindow++;

    if (currentBatch.truncated) {
      packetTruncationsTotal++;
    }

    // Timestamp sanity checks.
    if (currentBatch.t1_us > currentBatch.created_us) {
      futureTimestampErrorsTotal++;
    }

    int64_t batchSpan =
        currentBatch.t1_us -
        currentBatch.t0_us;

    if (batchSpan > 150000) {
      excessiveSpanErrorsTotal++;
    }

    size_t jsonLength = 0;

    bool serialized =
        serializeBatchJSON(
            currentBatch,
            lastJson,
            JSON_BUFFER_SIZE,
            jsonLength);

    if (serialized) {
      lastJsonLength = jsonLength;
      lastJsonSequence = currentBatch.sequence;

      packetsSerializedWindow++;
      bytesSerializedWindow += (uint32_t)jsonLength;

      if (jsonLength > maxPacketBytesWindow) {
        maxPacketBytesWindow = (uint32_t)jsonLength;
      }

      // IMPORTANT: non-blocking queue handoff only.
      enqueueForNetwork(
          lastJson,
          jsonLength,
          currentBatch.sequence);

    } else {
      serializationErrorsTotal++;
      lastJsonLength = 0;
      lastJson[0] = '\0';
    }
  }

  now = esp_timer_get_time();

  // ========================================================
  // 1 SECOND DIAGNOSTICS
  // ========================================================

  if (now >= nextDiagnostic) {
    nextDiagnostic += DIAGNOSTIC_PERIOD_US;

    if (now - nextDiagnostic >= DIAGNOSTIC_PERIOD_US) {
      nextDiagnostic = now + DIAGNOSTIC_PERIOD_US;
    }

    RingStats e = ecgBuffer.snapshot(&ecgBufferMux);
    RingStats p = ppgBuffer.snapshot(&ppgBufferMux);
    RingStats g = gsrBuffer.snapshot(&gsrBufferMux);
    RingStats i = imuBuffer.snapshot(&imuBufferMux);
    RingStats t = tempBuffer.snapshot(&tempBufferMux);

    uint32_t eIn = e.produced - previousECG.produced;
    uint32_t pIn = p.produced - previousPPG.produced;
    uint32_t gIn = g.produced - previousGSR.produced;
    uint32_t iIn = i.produced - previousIMU.produced;
    uint32_t tIn = t.produced - previousTEMP.produced;

    uint32_t eOut = e.consumed - previousECG.consumed;
    uint32_t pOut = p.consumed - previousPPG.consumed;
    uint32_t gOut = g.consumed - previousGSR.consumed;
    uint32_t iOut = i.consumed - previousIMU.consumed;
    uint32_t tOut = t.consumed - previousTEMP.consumed;

    previousECG = e;
    previousPPG = p;
    previousGSR = g;
    previousIMU = i;
    previousTEMP = t;

    uint32_t eMiss;
    uint32_t pMiss;
    uint32_t gMiss;
    uint32_t iMiss;
    uint32_t tMiss;
    uint32_t errors;
    int32_t maxLate;
    uint32_t ppgCorr;
    uint32_t ppgFut;

    portENTER_CRITICAL(&runtimeMux);

    eMiss = ecgMissed;
    pMiss = ppgServiceMissed;
    gMiss = gsrMissed;
    iMiss = imuMissed;
    tMiss = tempMissed;

    errors = i2cErrors;
    maxLate = ecgMaxLateUs;

    ppgCorr = ppgTimestampCorrections;
    ppgFut = ppgFutureErrors;

    ecgMissed = 0;
    ppgServiceMissed = 0;
    gsrMissed = 0;
    imuMissed = 0;
    tempMissed = 0;
    ecgMaxLateUs = 0;

    portEXIT_CRITICAL(&runtimeMux);

    uint32_t averageBytes = 0;

    if (packetsSerializedWindow > 0) {
      averageBytes =
          bytesSerializedWindow /
          packetsSerializedWindow;
    }

    int64_t packetSpan =
        currentBatch.t1_us -
        currentBatch.t0_us;

    // ------------------------------------------------------
    // Network snapshot
    // ------------------------------------------------------

    bool wsUp;
    uint32_t netEnqueued;
    uint32_t netSent;
    uint32_t netBytes;
    uint32_t queueDrops;
    uint32_t offlineDrops;
    uint32_t oversizeDrops;
    uint32_t sendFailures;
    uint16_t queueHwm;
    uint32_t wsConn;
    uint32_t wsDisc;
    uint32_t wsErr;

    uint32_t ackSeq;
    uint32_t ackCount;
    uint32_t ackTimeouts;
    uint32_t forcedReconnects;
    uint32_t recoveryDrops;
    uint32_t ackAgeMs;

    portENTER_CRITICAL(&networkMux);

    wsUp = wsConnected;

    netEnqueued = netEnqueuedWindow;
    netSent = netSentWindow;
    netBytes = netBytesSentWindow;

    queueDrops = netQueueDropsTotal;
    offlineDrops = netDisconnectedDropsTotal;
    oversizeDrops = netOversizeDropsTotal;
    sendFailures = netSendFailuresTotal;

    queueHwm = netQueueHighWater;

    wsConn = wsConnectEvents;
    wsDisc = wsDisconnectEvents;
    wsErr = wsErrorEvents;

    ackSeq = lastAckSeq;
    ackCount = ackEvents;
    ackTimeouts = ackTimeoutsTotal;
    forcedReconnects = forcedReconnectsTotal;
    recoveryDrops = recoveryQueueDropsTotal;

    uint32_t ackMillisSnapshot = lastAckMillis;
    uint32_t nowMillisSnapshot = millis();

    ackAgeMs =
        (ackMillisSnapshot == 0)
            ? UINT32_MAX
            : (uint32_t)(
                  nowMillisSnapshot -
                  ackMillisSnapshot);

    netEnqueuedWindow = 0;
    netSentWindow = 0;
    netBytesSentWindow = 0;

    portEXIT_CRITICAL(&networkMux);

    UBaseType_t queueDepth =
        uxQueueMessagesWaiting(networkQueue);

    bool wifiUp =
        (WiFi.status() == WL_CONNECTED);

    // ------------------------------------------------------
    // Output
    // ------------------------------------------------------

    Serial.printf(
        "PKT RATE:%lu/s SEQ:%lu | "
        "LAST E:%u P:%u G:%u I:%u T:%u | "
        "SPAN:%lldus | JSON AVG:%luB MAX:%luB\n",

        (unsigned long)packetsBuiltWindow,
        (unsigned long)currentBatch.sequence,

        currentBatch.ecgCount,
        currentBatch.ppgCount,
        currentBatch.gsrCount,
        currentBatch.imuCount,
        currentBatch.tempCount,

        (long long)packetSpan,

        (unsigned long)averageBytes,
        (unsigned long)maxPacketBytesWindow);

    Serial.printf(
        "RATE IN E:%lu P:%lu G:%lu I:%lu T:%lu | "
        "OUT E:%lu P:%lu G:%lu I:%lu T:%lu\n",

        (unsigned long)eIn,
        (unsigned long)pIn,
        (unsigned long)gIn,
        (unsigned long)iIn,
        (unsigned long)tIn,

        (unsigned long)eOut,
        (unsigned long)pOut,
        (unsigned long)gOut,
        (unsigned long)iOut,
        (unsigned long)tOut);

    Serial.printf(
        "BUF DEPTH E:%u P:%u G:%u I:%u T:%u | "
        "HWM E:%u P:%u G:%u I:%u T:%u | "
        "OVF E:%lu P:%lu G:%lu I:%lu T:%lu\n",

        e.depth,
        p.depth,
        g.depth,
        i.depth,
        t.depth,

        e.highWater,
        p.highWater,
        g.highWater,
        i.highWater,
        t.highWater,

        (unsigned long)e.overflows,
        (unsigned long)p.overflows,
        (unsigned long)g.overflows,
        (unsigned long)i.overflows,
        (unsigned long)t.overflows);

    Serial.printf(
        "CHK MISS E:%lu Psvc:%lu G:%lu I:%lu T:%lu | "
        "ORDER E:%lu P:%lu G:%lu I:%lu T:%lu | "
        "TRUNC:%lu SERERR:%lu BATCHMISS:%lu | "
        "FUTURE:%lu SPANERR:%lu PPGCORR:%lu PPGFUT:%lu | "
        "ECG_LATE:%ldus I2CERR:%lu\n",

        (unsigned long)eMiss,
        (unsigned long)pMiss,
        (unsigned long)gMiss,
        (unsigned long)iMiss,
        (unsigned long)tMiss,

        (unsigned long)ecgOrderErrors,
        (unsigned long)ppgOrderErrors,
        (unsigned long)gsrOrderErrors,
        (unsigned long)imuOrderErrors,
        (unsigned long)tempOrderErrors,

        (unsigned long)packetTruncationsTotal,
        (unsigned long)serializationErrorsTotal,
        (unsigned long)batchScheduleMissesTotal,

        (unsigned long)futureTimestampErrorsTotal,
        (unsigned long)excessiveSpanErrorsTotal,
        (unsigned long)ppgCorr,
        (unsigned long)ppgFut,

        (long)maxLate,
        (unsigned long)errors);

    Serial.printf(
        "NET WIFI:%s WS:%s | "
        "ENQ:%lu/s SENT:%lu/s BYTES:%lu/s | "
        "Q:%u HWM:%u | "
        "QDROP:%lu OFFDROP:%lu BIGDROP:%lu SENDFAIL:%lu RECDROP:%lu | "
        "ACK_SEQ:%lu ACKS:%lu AGE:%lums ACKTO:%lu RECON:%lu | "
        "WS_EVT C:%lu D:%lu E:%lu\n",

        wifiUp ? "UP" : "DOWN",
        wsUp ? "UP" : "DOWN",

        (unsigned long)netEnqueued,
        (unsigned long)netSent,
        (unsigned long)netBytes,

        (unsigned)queueDepth,
        (unsigned)queueHwm,

        (unsigned long)queueDrops,
        (unsigned long)offlineDrops,
        (unsigned long)oversizeDrops,
        (unsigned long)sendFailures,
        (unsigned long)recoveryDrops,

        (unsigned long)ackSeq,
        (unsigned long)ackCount,
        (unsigned long)ackAgeMs,
        (unsigned long)ackTimeouts,
        (unsigned long)forcedReconnects,

        (unsigned long)wsConn,
        (unsigned long)wsDisc,
        (unsigned long)wsErr);

    if (wifiUp) {
      Serial.print("NET IP:");
      Serial.print(WiFi.localIP());
      Serial.print(" RSSI:");
      Serial.print(WiFi.RSSI());
      Serial.println(" dBm");
    }

    Serial.printf(
        "SYS FREE_HEAP:%lu MIN_HEAP:%lu\n\n",
        (unsigned long)ESP.getFreeHeap(),
        (unsigned long)ESP.getMinFreeHeap());

    packetsBuiltWindow = 0;
    packetsSerializedWindow = 0;
    bytesSerializedWindow = 0;
    maxPacketBytesWindow = 0;
  }

  delay(1);
}
