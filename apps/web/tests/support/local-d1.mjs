/**
 * A D1Database-shaped wrapper over Node's built-in node:sqlite, for tests that need a
 * real database rather than mocks. D1 *is* SQLite, and the store layer only ever
 * touches prepare().bind().first()/all()/run() and batch() (see LOCAL_MODE_ARCHITECTURE.md
 * §5.1, which sketched this same shim for a different purpose: running the app outside
 * Workers). Here it exists purely to let domain logic in lib/store.ts run against a
 * real, disposable, in-memory database inside `node --test`, without spinning up
 * Miniflare or a dev server.
 */
import { DatabaseSync } from "node:sqlite";

function isSelectLike(sql) {
  return /^\s*(SELECT|WITH)/i.test(sql);
}

class LocalStatement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...values) {
    return new LocalStatement(this.db, this.sql, values);
  }
  async first(column) {
    const row = this.db.prepare(this.sql).get(...this.params) ?? null;
    if (!row) return null;
    return column ? (row[column] ?? null) : row;
  }
  async all() {
    if (isSelectLike(this.sql)) {
      const results = this.db.prepare(this.sql).all(...this.params);
      return { results, success: true, meta: {} };
    }
    const info = this.db.prepare(this.sql).run(...this.params);
    return { results: [], success: true, meta: { changes: info.changes, lastRowId: info.lastInsertRowid } };
  }
  async run() {
    return this.all();
  }
  async raw() {
    const { results } = await this.all();
    return results.map((row) => Object.values(row));
  }
}

export class LocalD1 {
  constructor(sqliteDb) {
    this.db = sqliteDb;
  }
  prepare(sql) {
    return new LocalStatement(this.db, sql);
  }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = [];
      for (const statement of statements) out.push(await statement.all());
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async exec(sql) {
    this.db.exec(sql);
    return { results: [], success: true, meta: {} };
  }
}

/** Fresh in-memory database with the production schema, bypassing ensureSchema's process-wide singleton guard. */
export async function createTestDb() {
  const { SCHEMA_STATEMENTS, MIGRATION_STATEMENTS } = await import("../../db/setup.ts");
  const sqliteDb = new DatabaseSync(":memory:");
  sqliteDb.exec("PRAGMA foreign_keys = OFF;");
  for (const statement of SCHEMA_STATEMENTS) sqliteDb.exec(statement);
  for (const statement of MIGRATION_STATEMENTS) { try { sqliteDb.exec(statement); } catch { /* already applied in this schema version */ } }
  return new LocalD1(sqliteDb);
}
