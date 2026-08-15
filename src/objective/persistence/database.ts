import { Pool, type PoolConfig } from "pg";

export const REQUIRED_OBJECTIVE_MIGRATION = "001_objective_persistence.sql";

export function readDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment.DATABASE_URL;
  if (value === undefined || value.trim().length === 0) {
    throw new Error("DATABASE_URL must be configured with a non-empty value");
  }
  return value;
}

export function createDatabasePool(databaseUrl: string): Pool {
  const configuration: PoolConfig = {
    connectionString: databaseUrl,
    max: 10,
  };
  return new Pool(configuration);
}

export async function verifyObjectivePersistenceSchema(pool: Pool): Promise<void> {
  await pool.query("SELECT 1");

  const migration = await pool.query<{ applied: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM objective_schema_migrations
       WHERE migration_name = $1
     ) AS applied`,
    [REQUIRED_OBJECTIVE_MIGRATION],
  );
  if (migration.rows[0]?.applied !== true) {
    throw new Error(
      `required database migration ${REQUIRED_OBJECTIVE_MIGRATION} is not applied; run npm run db:migrate`,
    );
  }

  const relations = await pool.query<{ relation_name: string; relation: string | null }>(
    `SELECT relation_name, to_regclass(relation_name) AS relation
     FROM unnest($1::text[]) AS required_relations(relation_name)`,
    [[
      "objective_sessions",
      "objective_sessions_one_non_completed_per_device",
      "objective_packets",
      "objective_packets_pkey",
      "objective_packets_session_received_order",
    ]],
  );
  const missingRelations = relations.rows
    .filter((row) => row.relation === null)
    .map((row) => row.relation_name);
  if (missingRelations.length > 0) {
    throw new Error(`required objective persistence schema objects are missing: ${missingRelations.join(", ")}`);
  }

  await pool.query(
    `SELECT
       session_id, device_id, status, created_at_ms, updated_at_ms, completed_at_ms
     FROM objective_sessions
     LIMIT 0`,
  );
  await pool.query(
    `SELECT
       session_id, boot_id, seq, received_at_ms, sequence_status, gap_before,
       epoch_id, esp_anchor_us, backend_anchor_ms, plot_t0_ms, raw_packet
     FROM objective_packets
     LIMIT 0`,
  );
}
