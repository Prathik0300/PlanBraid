/**
 * A D1Database-shaped wrapper over Postgres, so the rest of the app (lib/store.ts,
 * lib/oauth.ts, lib/app-principal.ts, etc. — ~140 call sites in total) keeps using the
 * exact same `.prepare(sql).bind(...).first()/.all()/.run()` and `.batch([...])` API it
 * always has, unchanged. Only what's underneath this interface moved from Cloudflare D1
 * to Postgres. Generic over any client exposing `pg`'s `query(sql, params)` shape, so
 * the same class backs a real `pg.Pool` in production and `@electric-sql/pglite` in
 * tests (tests/support/local-pg.mjs), mirroring the old node:sqlite test double.
 */

export interface PgQueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

export interface PgClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>>;
}

export interface PgPoolClient extends PgClient {
  connect(): Promise<PgClient & { release(): void }>;
}

export interface PgD1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

export interface PgD1PreparedStatement {
  bind(...values: unknown[]): PgD1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<PgD1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<PgD1Result<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}

/** "PLAN" as int32, namespacing this app's advisory locks. */
const LOCK_NAMESPACE = 0x504c414e;

function isSelectLike(sql: string) {
  return /^\s*(SELECT|WITH)/i.test(sql);
}

/** Converts D1/SQLite-style `?` positional placeholders to Postgres `$1, $2, ...`. */
function toPgSql(sql: string) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

/** Postgres returns TIMESTAMPTZ columns as JS Date objects; every call site in the app
 * still expects the ISO-string shape D1/SQLite always returned, so normalize here once
 * rather than touching every read site. */
function normalizeRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = value instanceof Date ? value.toISOString() : value;
  return out as T;
}

async function execWith(client: PgClient, sql: string, params: unknown[]): Promise<PgD1Result> {
  const result = await client.query(toPgSql(sql), params);
  const results = result.rows.map((row) => normalizeRow<Record<string, unknown>>(row));
  if (isSelectLike(sql)) return { results, success: true, meta: {} };
  return { results, success: true, meta: { changes: result.rowCount ?? 0 } };
}

class PgStatement implements PgD1PreparedStatement {
  private readonly client: PgClient;
  private readonly sql: string;
  private readonly params: unknown[];

  constructor(client: PgClient, sql: string, params: unknown[] = []) {
    this.client = client;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): PgD1PreparedStatement {
    return new PgStatement(this.client, this.sql, values);
  }

  /** Internal: runs against an arbitrary client (used by PgD1.batch() to share one
   * transactional connection instead of this statement's default pool). */
  async execWith(client: PgClient): Promise<PgD1Result> {
    return execWith(client, this.sql, this.params);
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const { results } = await this.execWith(this.client);
    const row = results[0];
    if (!row) return null;
    return (column ? row[column] ?? null : row) as T;
  }

  async all<T = Record<string, unknown>>(): Promise<PgD1Result<T>> {
    return this.execWith(this.client) as Promise<PgD1Result<T>>;
  }

  async run<T = Record<string, unknown>>(): Promise<PgD1Result<T>> {
    return this.execWith(this.client) as Promise<PgD1Result<T>>;
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const { results } = await this.execWith(this.client);
    return results.map((row) => Object.values(row)) as T[];
  }
}

export class PgD1 {
  /** The underlying pool, exposed so better-auth's Kysely adapter (which needs a raw
   * `pg`-compatible pool with `.connect()`, not this D1-shaped wrapper) can share the
   * same connection pool instead of opening a second one. */
  readonly pool: PgPoolClient;
  /** True for the handle handed to transaction()'s callback: everything it issues is
   * already inside one transaction, so batch() must not open a nested one. */
  private readonly inTransaction: boolean;

  constructor(pool: PgPoolClient, inTransaction = false) {
    this.pool = pool;
    this.inTransaction = inTransaction;
  }

  prepare(sql: string): PgD1PreparedStatement {
    return new PgStatement(this.pool, sql);
  }

  /**
   * Runs reads and writes together on one connection inside one transaction, so a
   * decision made from a read still holds when the write lands. batch() cannot express
   * this: it takes a fixed list of statements with no room to branch in between, which
   * is exactly what check-then-insert needs.
   */
  async transaction<T>(run: (tx: PgD1) => Promise<T>): Promise<T> {
    if (this.inTransaction) return run(this);
    const client = await this.pool.connect();
    const scoped: PgPoolClient = {
      query: (sql, params) => client.query(sql, params),
      // Anything reaching for a connection inside the transaction must get *this* one,
      // or its statements would land outside the transaction on a different connection.
      connect: async () => Object.assign(client, { release: () => {} }),
    };
    try {
      await client.query("BEGIN");
      const result = await run(new PgD1(scoped, true));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Serializes a section against other writers holding the same key, for the whole
   * surrounding transaction. Postgres releases it automatically on commit or rollback,
   * so a crash mid-way cannot strand the lock the way a manually held one could.
   */
  async lock(key: string) {
    if (!this.inTransaction) throw new Error("PgD1.lock() must be called inside transaction()");
    // pg_advisory_xact_lock(int4, int4): a fixed namespace in the first slot keeps these
    // from colliding with any other advisory lock in the database, and two 32-bit keys
    // avoid BigInt entirely.
    let hash = 0;
    for (let index = 0; index < key.length; index += 1) hash = (Math.imul(hash, 31) + key.charCodeAt(index)) | 0;
    await this.pool.query("SELECT pg_advisory_xact_lock($1, $2)", [LOCK_NAMESPACE, hash]);
  }

  /** Runs every statement on one checked-out connection inside a single transaction,
   * matching D1's all-or-nothing batch semantics (LocalD1.batch() in the old SQLite
   * test double did the same thing with BEGIN IMMEDIATE/COMMIT/ROLLBACK). */
  async batch<T = Record<string, unknown>>(statements: PgD1PreparedStatement[]): Promise<PgD1Result<T>[]> {
    const client = await this.pool.connect();
    try {
      if (!this.inTransaction) await client.query("BEGIN");
      const out: PgD1Result<T>[] = [];
      for (const statement of statements) {
        if (!(statement instanceof PgStatement)) throw new Error("PgD1.batch() only accepts statements created by PgD1.prepare()");
        out.push((await statement.execWith(client)) as PgD1Result<T>);
      }
      if (!this.inTransaction) await client.query("COMMIT");
      return out;
    } catch (error) {
      // Inside an outer transaction the caller owns the rollback; issuing one here
      // would abort their whole transaction on a failure they may intend to handle.
      if (!this.inTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async exec(sql: string): Promise<PgD1Result> {
    await this.pool.query(sql);
    return { results: [], success: true, meta: {} };
  }
}
