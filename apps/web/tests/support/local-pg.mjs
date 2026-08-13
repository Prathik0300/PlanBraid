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

/**
 * One PGlite per test process, reused across every createTestDb() call.
 *
 * Each PGlite is a WASM instance with its own multi-megabyte heap, and nothing closes
 * them — so creating one per test leaked an instance per test, and with node:test running
 * files in parallel the process eventually died with a V8 fatal error. The symptom was a
 * suite that failed on a *different* file each run, which reads like flaky product code
 * and is not.
 *
 * Reusing the instance and recreating the schema keeps memory flat. Top-level tests within
 * a file run sequentially under node:test, so one test's reset can never land in the
 * middle of another's queries.
 */
let shared;

/** Fresh database state with the production schema, bypassing ensureSchema's process-wide singleton guard. */
export async function createTestDb() {
  const { SCHEMA_STATEMENTS, MIGRATION_STATEMENTS } = await import("../../db/setup.ts");
  shared ??= new PGlite();
  // Dropping and recreating `public` is what makes this a *fresh* database rather than a
  // reused one: every table, sequence and index in it goes, so no test can see another's
  // rows or leftover identity counters.
  await shared.query("DROP SCHEMA IF EXISTS public CASCADE");
  await shared.query("CREATE SCHEMA public");
  for (const statement of SCHEMA_STATEMENTS) await shared.query(statement);
  for (const statement of MIGRATION_STATEMENTS) { try { await shared.query(statement); } catch { /* already applied in this schema version */ } }
  return new PgD1(new PgliteAdapter(shared));
}
