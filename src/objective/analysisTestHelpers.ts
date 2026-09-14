import type { AcceptedObjectivePacket } from "./acceptedPacketBus.js";
import type { SchemaV1Packet } from "./packetValidator.js";

export interface TestPacketOptions {
  seq?: number;
  t0Us?: number;
  plotT0Ms?: number;
  sequenceStatus?: AcceptedObjectivePacket["sequence_status"];
  gapBefore?: number;
  epochId?: string;
  ecg?: SchemaV1Packet["ecg"];
  ppg?: SchemaV1Packet["ppg"];
  gsr?: SchemaV1Packet["gsr"];
  imu?: SchemaV1Packet["imu"];
  temp?: SchemaV1Packet["temp"];
}
export function acceptedPacket(options: TestPacketOptions = {}): AcceptedObjectivePacket {
  const t0Us = options.t0Us ?? 1_000_000;
  const t1Us = t0Us + 100_000;
  const rawPacket: SchemaV1Packet = {
    schema: 1,
    session_id: "00000000-0000-4000-8000-000000000001",
    seq: options.seq ?? 1,
    timebase: "esp_timer_us",
    created_us: t1Us,
    t0_us: t0Us,
    t1_us: t1Us,
    truncated: 0,
    n: [
      options.ecg?.length ?? 0,
      options.ppg?.length ?? 0,
      options.gsr?.length ?? 0,
      options.imu?.length ?? 0,
      options.temp?.length ?? 0,
    ],
    ecg: options.ecg ?? [],
    ppg: options.ppg ?? [],
    gsr: options.gsr ?? [],
    imu: options.imu ?? [],
    temp: options.temp ?? [],
  };
  return {
    device_id: "device-a",
    boot_id: "boot-a",
    session_id: rawPacket.session_id,
    received_at_ms: 5_000,
    sequence_status: options.sequenceStatus ?? "normal",
    gap_before: options.gapBefore ?? 0,
    epoch_id: options.epochId ?? "00000000-0000-4000-8000-000000000002",
    esp_anchor_us: 1_000_000,
    backend_anchor_ms: 5_000,
    plot_t0_ms: options.plotT0Ms ?? 0,
    raw_packet: rawPacket,
  };
}
