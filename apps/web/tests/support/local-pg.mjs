/**
 * A pg-compatible wrapper over @electric-sql/pglite (embedded WASM Postgres), for tests
 * that need a real database rather than mocks — the closest in-memory, no-external-
 * process equivalent to the old node:sqlite harness, now that the app talks to real
 * Postgres. Reuses db/pg-d1.ts's PgD1 shim directly rather than reimplementing
 * prepare/bind/batch semantics a second time.
 */
import { PGlite } from "@electric-sql/pglite";
import { PgD1 } from "../../db/pg-d1.ts";

/** Adapts pglite's single embedded connection to the PgPoolClient shape PgD1 expects
 * (a real pg.Pool in production). pglite has no connection pool to check out — it's
 * already one connection — so `.connect()` just hands back a wrapper around the same
 * instance with a no-op `release()`. */
class PgliteAdapter {
  constructor(pglite) {
    this.pglite = pglite;
  }
  async query(sql, params = []) {
    const result = await this.pglite.query(sql, params);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }
  async connect() {
    return { query: (sql, params) => this.query(sql, params), release: () => {} };
  }
}

/** Fresh in-memory database with the production schema, bypassing ensureSchema's process-wide singleton guard. */
export async function createTestDb() {
  const { SCHEMA_STATEMENTS, MIGRATION_STATEMENTS } = await import("../../db/setup.ts");
  const pglite = new PGlite();
  for (const statement of SCHEMA_STATEMENTS) await pglite.query(statement);
  for (const statement of MIGRATION_STATEMENTS) { try { await pglite.query(statement); } catch { /* already applied in this schema version */ } }
  return new PgD1(new PgliteAdapter(pglite));
}
