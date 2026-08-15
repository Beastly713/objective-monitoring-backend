export type EcgSample = [dtUs: number, adc: number, loPlus: 0 | 1, loMinus: 0 | 1];
export type PpgSample = [dtUs: number, red: number, ir: number];
export type GsrSample = [dtUs: number, raw: number];
export type ImuSample = [
  dtUs: number,
  ax: number,
  ay: number,
  az: number,
  gx: number,
  gy: number,
  gz: number,
];
export type TempSample = [dtUs: number, raw: number];

export interface SchemaV1Packet {
  schema: 1;
  session_id: string;
  seq: number;
  timebase: "esp_timer_us";
  created_us: number;
  t0_us: number;
  t1_us: number;
  truncated: 0 | 1;
  n: [number, number, number, number, number];
  ecg: EcgSample[];
  ppg: PpgSample[];
  gsr: GsrSample[];
  imu: ImuSample[];
  temp: TempSample[];
  [key: string]: unknown;
}

export type PacketValidationResult =
  | { valid: true; packet: SchemaV1Packet }
  | { valid: false; reason: string };

const MAX_PACKET_SPAN_US = 150_000;
const MAX_SEQUENCE = 0xffff_ffff;
const SENSOR_KEYS = ["ecg", "ppg", "gsr", "imu", "temp"] as const;
const SENSOR_MAXIMA = [64, 32, 32, 32, 4] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateSamples(
  sensor: (typeof SENSOR_KEYS)[number],
  samples: unknown[],
  packetSpanUs: number,
): string | null {
  let previousDtUs = -1;

  for (const [sampleIndex, sample] of samples.entries()) {
    if (!Array.isArray(sample)) {
      return `${sensor}[${sampleIndex}] must be an array`;
    }

    const expectedLength = sensor === "ecg" ? 4 : sensor === "imu" ? 7 : sensor === "ppg" ? 3 : 2;
    if (sample.length !== expectedLength) {
      return `${sensor}[${sampleIndex}] must contain exactly ${expectedLength} entries`;
    }

    const dtUs = sample[0];
    if (!isInteger(dtUs) || dtUs < 0 || dtUs > packetSpanUs) {
      return `${sensor}[${sampleIndex}][0] must be an integer within the packet span`;
    }

    if (dtUs < previousDtUs) {
      return `${sensor} sample dt_us values must not go backwards`;
    }
    previousDtUs = dtUs;

    if (sensor === "ecg") {
      if (!isInteger(sample[1])) {
        return `${sensor}[${sampleIndex}][1] must be an integer`;
      }
      if ((sample[2] !== 0 && sample[2] !== 1) || (sample[3] !== 0 && sample[3] !== 1)) {
        return `${sensor}[${sampleIndex}] lead-off values must be 0 or 1`;
      }
      continue;
    }

    if (sensor === "ppg") {
      if (!isInteger(sample[1]) || sample[1] < 0 || !isInteger(sample[2]) || sample[2] < 0) {
        return `${sensor}[${sampleIndex}] raw counts must be non-negative integers`;
      }
      continue;
    }

    for (let valueIndex = 1; valueIndex < sample.length; valueIndex += 1) {
      if (!isInteger(sample[valueIndex])) {
        return `${sensor}[${sampleIndex}][${valueIndex}] must be an integer`;
      }
    }
  }

  return null;
}

export function validateSchemaV1Packet(value: unknown): PacketValidationResult {
  if (!isRecord(value)) {
    return { valid: false, reason: "packet must be an object" };
  }

  if (value.schema !== 1) {
    return { valid: false, reason: "schema must equal 1" };
  }

  if (typeof value.session_id !== "string" || value.session_id.trim().length === 0) {
    return { valid: false, reason: "session_id must be a non-empty string" };
  }

  if (!isInteger(value.seq) || value.seq < 0 || value.seq > MAX_SEQUENCE) {
    return { valid: false, reason: "seq must be an integer from 0 to 4294967295" };
  }

  if (value.timebase !== "esp_timer_us") {
    return { valid: false, reason: "timebase must equal esp_timer_us" };
  }

  if (
    !isNonNegativeSafeInteger(value.created_us) ||
    !isNonNegativeSafeInteger(value.t0_us) ||
    !isNonNegativeSafeInteger(value.t1_us)
  ) {
    return { valid: false, reason: "packet timestamps must be non-negative safe integers" };
  }

  if (value.t0_us > value.t1_us || value.t1_us > value.created_us) {
    return { valid: false, reason: "timestamps must satisfy t0_us <= t1_us <= created_us" };
  }

  const packetSpanUs = value.t1_us - value.t0_us;
  if (packetSpanUs > MAX_PACKET_SPAN_US) {
    return { valid: false, reason: "packet span exceeds 150000 us" };
  }

  if (value.truncated !== 0 && value.truncated !== 1) {
    return { valid: false, reason: "truncated must equal 0 or 1" };
  }

  if (!Array.isArray(value.n) || value.n.length !== 5) {
    return { valid: false, reason: "n must be an array with five entries" };
  }

  for (const [index, key] of SENSOR_KEYS.entries()) {
    const samples = value[key];
    if (!Array.isArray(samples)) {
      return { valid: false, reason: `${key} must be an array` };
    }

    if (value.n[index] !== samples.length) {
      return { valid: false, reason: `n[${index}] must equal ${key}.length` };
    }

    if (samples.length > SENSOR_MAXIMA[index]) {
      return { valid: false, reason: `${key} exceeds its firmware batch maximum` };
    }

    const sampleError = validateSamples(key, samples, packetSpanUs);
    if (sampleError !== null) {
      return { valid: false, reason: sampleError };
    }
  }

  return { valid: true, packet: value as unknown as SchemaV1Packet };
}
