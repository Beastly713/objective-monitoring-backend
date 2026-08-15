export interface SchemaV1Packet {
  schema: 1;
  session_id: string;
  seq: number;
  created_us: number;
  t0_us: number;
  t1_us: number;
  n: [number, number, number, number, number];
  ecg: unknown[];
  ppg: unknown[];
  gsr: unknown[];
  imu: unknown[];
  temp: unknown[];
  [key: string]: unknown;
}

export type PacketValidationResult =
  | { valid: true; packet: SchemaV1Packet }
  | { valid: false; reason: string };

const MAX_PACKET_SPAN_US = 150_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateSchemaV1Packet(value: unknown): PacketValidationResult {
  if (!isRecord(value)) {
    return { valid: false, reason: "packet must be an object" };
  }

  if (value.schema !== 1) {
    return { valid: false, reason: "schema must equal 1" };
  }

  if (typeof value.session_id !== "string") {
    return { valid: false, reason: "session_id must be a string" };
  }

  if (!Number.isInteger(value.seq)) {
    return { valid: false, reason: "seq must be an integer" };
  }

  if (!isFiniteNumber(value.created_us) || !isFiniteNumber(value.t0_us) || !isFiniteNumber(value.t1_us)) {
    return { valid: false, reason: "packet timestamps must be finite numbers" };
  }

  if (value.t0_us > value.t1_us || value.t1_us > value.created_us) {
    return { valid: false, reason: "timestamps must satisfy t0_us <= t1_us <= created_us" };
  }

  if (value.t1_us - value.t0_us > MAX_PACKET_SPAN_US) {
    return { valid: false, reason: "packet span exceeds 150000 us" };
  }

  if (!Array.isArray(value.n) || value.n.length !== 5) {
    return { valid: false, reason: "n must be an array with five entries" };
  }

  const sensorKeys = ["ecg", "ppg", "gsr", "imu", "temp"] as const;

  for (const [index, key] of sensorKeys.entries()) {
    if (!Array.isArray(value[key])) {
      return { valid: false, reason: `${key} must be an array` };
    }

    if (value.n[index] !== value[key].length) {
      return { valid: false, reason: `n[${index}] must equal ${key}.length` };
    }
  }

  return { valid: true, packet: value as SchemaV1Packet };
}
