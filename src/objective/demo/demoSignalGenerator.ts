import type { AcceptedObjectivePacket } from "../acceptedPacketBus.js";
import type {
  EcgSample,
  GsrSample,
  ImuSample,
  PpgSample,
  SchemaV1Packet,
  TempSample,
} from "../packetValidator.js";
import { validateSchemaV1Packet } from "../packetValidator.js";
import type { DemoScenarioDefinition } from "./demoTypes.js";
import {
  DEMO_BASELINE_DURATION_MS,
  DEMO_DEVICE_ID,
  DEMO_PACKET_PERIOD_MS,
} from "./demoTypes.js";

export interface DemoPacketContext {
  session_id: string;
  boot_id: string;
  epoch_id: string;
  wall_start_ms: number;
}

const ECG_RATE_HZ = 250;
const PPG_RATE_HZ = 100;
const GSR_RATE_HZ = 128;
const IMU_RATE_HZ = 100;
const TEMPERATURE_RATE_HZ = 2;

function sampleOffsets(startUs: number, endUs: number, rateHz: number): number[] {
  const offsets: number[] = [];
  let sampleIndex = Math.ceil((startUs * rateHz) / 1_000_000);
  while (true) {
    const sampleUs = Math.floor((sampleIndex * 1_000_000) / rateHz);
    if (sampleUs >= endUs) {
      break;
    }
    if (sampleUs >= startUs) {
      offsets.push(sampleUs - startUs);
    }
    sampleIndex += 1;
  }
  return offsets;
}

function periodicValue(values: readonly number[], index: number): number {
  return values[((index % values.length) + values.length) % values.length];
}

function ecgBeatCenters(internalMs: number, changed: boolean, changeStartMs: number): number[] {
  const period = changed ? 668 : 800;
  const first = changed ? changeStartMs + 200 : 200;
  const start = Math.max(0, Math.floor((internalMs - 240 - first) / period) - 1);
  const end = Math.ceil((internalMs + 240 - first) / period) + 1;
  const centers: number[] = [];
  for (let index = start; index <= end; index += 1) {
    const center = first + index * period;
    if (center >= internalMs - 240 && center <= internalMs + 240) {
      centers.push(center);
    }
  }
  return centers;
}

function ppgPulseCenters(internalMs: number, changed: boolean, changeStartMs: number): number[] {
  const period = changed ? 670 : 800;
  const first = changed ? changeStartMs + 200 : 2_000;
  const start = Math.max(0, Math.floor((internalMs - 30 - first) / period) - 1);
  const end = Math.ceil((internalMs + 30 - first) / period) + 1;
  const centers: number[] = [];
  for (let index = start; index <= end; index += 1) {
    const center = first + index * period;
    if (center >= internalMs - 30 && center <= internalMs + 30) {
      centers.push(center);
    }
  }
  return centers;
}

function ecgValueAt(internalMs: number, changed: boolean, changeStartMs: number): number {
  let value = 1_000;
  for (const center of ecgBeatCenters(internalMs, changed, changeStartMs)) {
    const offset = internalMs - center;
    value = offset === -20 ? 1_005
      : offset === -16 ? 1_025
        : offset === -12 ? 1_060
          : offset === -8 ? 1_100
            : offset === -4 ? 1_050
              : offset === 0 ? 1_000
                : value;
  }
  return value;
}

function ppgValueAt(internalMs: number, changed: boolean, changeStartMs: number): number {
  let value = 1_000;
  for (const center of ppgPulseCenters(internalMs, changed, changeStartMs)) {
    const offset = internalMs - center;
    value = offset === -10 ? 1_100
      : offset === 0 ? 1_300
        : offset === 10 ? 1_100
          : value;
  }
  return value;
}

function isChangedModality(
  scenario: DemoScenarioDefinition,
  modality: "cardiovascular" | "electrodermal" | "temperature",
  internalMs: number,
  changeStartMs: number,
): boolean {
  if (internalMs < changeStartMs) {
    return false;
  }
  switch (scenario.id) {
    case "isolated_cardiovascular_change":
      return modality === "cardiovascular";
    case "isolated_electrodermal_change":
      return modality === "electrodermal";
    case "isolated_temperature_change":
      return modality === "temperature";
    case "corroborated_multimodal_change":
      return modality === "cardiovascular" || modality === "electrodermal";
    case "stable_baseline":
      return false;
  }
}

function makeEcgSamples(
  startUs: number,
  endUs: number,
  scenario: DemoScenarioDefinition,
  changeStartMs: number,
): EcgSample[] {
  const changed = isChangedModality(scenario, "cardiovascular", startUs / 1_000, changeStartMs);
  return sampleOffsets(startUs, endUs, ECG_RATE_HZ).map((dtUs) => {
    const absoluteMs = (startUs + dtUs) / 1_000;
    return [dtUs, ecgValueAt(absoluteMs, changed, changeStartMs), 0, 0];
  });
}

function makePpgSamples(
  startUs: number,
  endUs: number,
  scenario: DemoScenarioDefinition,
  changeStartMs: number,
): PpgSample[] {
  const changed = isChangedModality(scenario, "cardiovascular", startUs / 1_000, changeStartMs);
  return sampleOffsets(startUs, endUs, PPG_RATE_HZ).map((dtUs) => {
    const absoluteMs = (startUs + dtUs) / 1_000;
    const ir = ppgValueAt(absoluteMs, changed, changeStartMs);
    return [dtUs, 900, ir];
  });
}

function makeGsrSamples(
  startUs: number,
  endUs: number,
  scenario: DemoScenarioDefinition,
  changeStartMs: number,
): GsrSample[] {
  const offsets = [-6, -2, 2, 6, -6, -2, 2, 6, -6, -2, 2, 6];
  return sampleOffsets(startUs, endUs, GSR_RATE_HZ).map((dtUs) => {
    const absoluteMs = (startUs + dtUs) / 1_000;
    const windowIndex = Math.floor(absoluteMs / 10_000);
    const baselineOffset = periodicValue(offsets, windowIndex);
    const sampleIndex = Math.floor((startUs + dtUs) * GSR_RATE_HZ / 1_000_000);
    const jitter = periodicValue([-3, -1, 0, 2, 3, 1, 0, -2], sampleIndex);
    const changed = isChangedModality(scenario, "electrodermal", absoluteMs, changeStartMs);
    const withinWindow = absoluteMs % 10_000;
    const risingSignal = changed ? 60 + Math.floor((withinWindow / 10_000) * 80) : 0;
    return [dtUs, 1_000 + baselineOffset + jitter + risingSignal];
  });
}

function makeImuSamples(startUs: number, endUs: number): ImuSample[] {
  return sampleOffsets(startUs, endUs, IMU_RATE_HZ).map((dtUs) => {
    const sampleIndex = Math.floor((startUs + dtUs) * IMU_RATE_HZ / 1_000_000);
    const ax = Math.round(18 * Math.sin(sampleIndex * 0.17));
    const ay = Math.round(18 * Math.cos(sampleIndex * 0.13));
    const gx = Math.round(2 * Math.sin(sampleIndex * 0.11));
    const gy = Math.round(2 * Math.cos(sampleIndex * 0.09));
    return [dtUs, ax, ay, 16_384, gx, gy, 1];
  });
}

function makeTemperatureSamples(
  startUs: number,
  endUs: number,
  scenario: DemoScenarioDefinition,
  changeStartMs: number,
): TempSample[] {
  const offsets = [-2, -1, 0, 1, 2, 1, 0, -1];
  return sampleOffsets(startUs, endUs, TEMPERATURE_RATE_HZ).map((dtUs) => {
    const absoluteMs = (startUs + dtUs) / 1_000;
    const sampleIndex = Math.floor((startUs + dtUs) * TEMPERATURE_RATE_HZ / 1_000_000);
    const changed = isChangedModality(scenario, "temperature", absoluteMs, changeStartMs);
    return [
      dtUs,
      4_224 + periodicValue(offsets, sampleIndex) + (changed ? 96 : 0),
    ];
  });
}

export function generateDemoRawPacket(
  context: DemoPacketContext,
  scenario: DemoScenarioDefinition,
  sequence: number,
  internalStartMs: number,
  visibleStartMs: number,
  changeStartMs = DEMO_BASELINE_DURATION_MS,
): SchemaV1Packet {
  const t0Us = internalStartMs * 1_000;
  const t1Us = t0Us + DEMO_PACKET_PERIOD_MS * 1_000;
  const packet: SchemaV1Packet = {
    schema: 1,
    session_id: context.session_id,
    seq: sequence,
    timebase: "esp_timer_us",
    created_us: t1Us,
    t0_us: t0Us,
    t1_us: t1Us,
    truncated: 0,
    n: [0, 0, 0, 0, 0],
    ecg: makeEcgSamples(t0Us, t1Us, scenario, changeStartMs),
    ppg: makePpgSamples(t0Us, t1Us, scenario, changeStartMs),
    gsr: makeGsrSamples(t0Us, t1Us, scenario, changeStartMs),
    imu: makeImuSamples(t0Us, t1Us),
    temp: makeTemperatureSamples(t0Us, t1Us, scenario, changeStartMs),
  };
  packet.n = [packet.ecg.length, packet.ppg.length, packet.gsr.length, packet.imu.length, packet.temp.length];
  const validation = validateSchemaV1Packet(packet);
  if (!validation.valid) {
    throw new Error(`demo packet generation produced an invalid Schema V1 packet: ${validation.reason}`);
  }
  return packet;
}

export function generateDemoAcceptedPacket(
  context: DemoPacketContext,
  scenario: DemoScenarioDefinition,
  sequence: number,
  internalStartMs: number,
  visibleStartMs: number,
  changeStartMs = DEMO_BASELINE_DURATION_MS,
): AcceptedObjectivePacket {
  const rawPacket = generateDemoRawPacket(
    context,
    scenario,
    sequence,
    internalStartMs,
    visibleStartMs,
    changeStartMs,
  );
  return {
    device_id: DEMO_DEVICE_ID,
    boot_id: context.boot_id,
    session_id: context.session_id,
    received_at_ms: context.wall_start_ms + internalStartMs,
    sequence_status: sequence === 1 ? "first" : "normal",
    gap_before: 0,
    epoch_id: context.epoch_id,
    esp_anchor_us: 0,
    backend_anchor_ms: context.wall_start_ms,
    plot_t0_ms: internalStartMs,
    raw_packet: rawPacket,
  };
}

export function sampleRates(): Record<string, number> {
  return {
    ecg_hz: ECG_RATE_HZ,
    ppg_hz: PPG_RATE_HZ,
    gsr_hz: GSR_RATE_HZ,
    imu_hz: IMU_RATE_HZ,
    temperature_hz: TEMPERATURE_RATE_HZ,
  };
}
