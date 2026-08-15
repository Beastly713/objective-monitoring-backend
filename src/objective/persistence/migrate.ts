import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabasePool, readDatabaseUrl } from "./database.js";

const MIGRATION_FILE_PATTERN = /^\d+_[a-z0-9_]+\.sql$/;

function migrationDirectory(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDirectory, "../../../db/migrations");
}

async function migrate(): Promise<void> {
  const pool = createDatabasePool(readDatabaseUrl());

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS objective_schema_migrations (
        migration_name TEXT PRIMARY KEY,
        applied_at_ms BIGINT NOT NULL
      )
    `);

    const directory = migrationDirectory();
    const migrationNames = (await readdir(directory))
      .filter((name) => MIGRATION_FILE_PATTERN.test(name))
      .sort((left, right) => left.localeCompare(right));

    for (const migrationName of migrationNames) {
      const alreadyApplied = await pool.query(
        "SELECT 1 FROM objective_schema_migrations WHERE migration_name = $1",
        [migrationName],
      );
      if ((alreadyApplied.rowCount ?? 0) > 0) {
        continue;
      }

      const sql = await readFile(path.join(directory, migrationName), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO objective_schema_migrations (migration_name, applied_at_ms) VALUES ($1, $2)",
          [migrationName, Date.now()],
        );
        await client.query("COMMIT");
        console.info(`[objective-storage] applied migration=${migrationName}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

migrate().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown migration error";
  console.error(`[objective-storage] migration failed message=${message}`);
  process.exitCode = 1;
});
