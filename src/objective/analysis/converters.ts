import type { AcceptedObjectivePacket } from "../acceptedPacketBus.js";
import type {
  AnalysisEcgSample,
  AnalysisGsrSample,
  AnalysisImuSample,
  AnalysisPpgSample,
  AnalysisTempSample,
  ExpandedAnalysisSamples,
} from "./types.js";

function sampleBase(
  packet: AcceptedObjectivePacket,
  dtUs: number,
): {
  sessionId: string;
  bootId: string;
  epochId: string;
  packetSeq: number;
  sampleTimeUs: number;
  sampleTimeMs: number;
} {
  return {
    sessionId: packet.session_id,
    bootId: packet.boot_id,
    epochId: packet.epoch_id,
    packetSeq: packet.raw_packet.seq,
    sampleTimeUs: packet.raw_packet.t0_us + dtUs,
    sampleTimeMs: packet.plot_t0_ms + dtUs / 1_000,
  };
}
export function convertEcgSample(
  packet: AcceptedObjectivePacket,
  sample: readonly [number, number, 0 | 1, 0 | 1],
): AnalysisEcgSample {
  const [dtUs, adc, loPlus, loMinus] = sample;
  return { ...sampleBase(packet, dtUs), modality: "ecg", adc, loPlus, loMinus };
}

export function convertPpgSample(
  packet: AcceptedObjectivePacket,
  sample: readonly [number, number, number],
): AnalysisPpgSample {
  const [dtUs, red, ir] = sample;
  return { ...sampleBase(packet, dtUs), modality: "ppg", red, ir };
}

export function convertGsrSample(
  packet: AcceptedObjectivePacket,
  sample: readonly [number, number],
): AnalysisGsrSample {
  const [dtUs, raw] = sample;
  return { ...sampleBase(packet, dtUs), modality: "gsr", raw };
}

export function convertImuSample(
  packet: AcceptedObjectivePacket,
  sample: readonly [number, number, number, number, number, number, number],
): AnalysisImuSample {
  const [dtUs, ax, ay, az, gx, gy, gz] = sample;
  return {
    ...sampleBase(packet, dtUs),
    modality: "imu",
    axG: ax / 16_384,
    ayG: ay / 16_384,
    azG: az / 16_384,
    gxDps: gx / 131,
    gyDps: gy / 131,
    gzDps: gz / 131,
  };
}

export function convertTemperatureSample(
  packet: AcceptedObjectivePacket,
  sample: readonly [number, number],
): AnalysisTempSample {
  const [dtUs, raw] = sample;
  return {
    ...sampleBase(packet, dtUs),
    modality: "temperature",
    temperatureC: raw * 0.0078125,
  };
}

export function expandAcceptedPacket(packet: AcceptedObjectivePacket): ExpandedAnalysisSamples {
  return {
    ecg: packet.raw_packet.ecg.map((sample) => convertEcgSample(packet, sample)),
    ppg: packet.raw_packet.ppg.map((sample) => convertPpgSample(packet, sample)),
    gsr: packet.raw_packet.gsr.map((sample) => convertGsrSample(packet, sample)),
    imu: packet.raw_packet.imu.map((sample) => convertImuSample(packet, sample)),
    temperature: packet.raw_packet.temp.map((sample) => convertTemperatureSample(packet, sample)),
  };
}
