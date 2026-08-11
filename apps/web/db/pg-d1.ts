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

  constructor(pool: PgPoolClient) {
    this.pool = pool;
  }

  prepare(sql: string): PgD1PreparedStatement {
    return new PgStatement(this.pool, sql);
  }

  /** Runs every statement on one checked-out connection inside a single transaction,
   * matching D1's all-or-nothing batch semantics (LocalD1.batch() in the old SQLite
   * test double did the same thing with BEGIN IMMEDIATE/COMMIT/ROLLBACK). */
  async batch<T = Record<string, unknown>>(statements: PgD1PreparedStatement[]): Promise<PgD1Result<T>[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out: PgD1Result<T>[] = [];
      for (const statement of statements) {
        if (!(statement instanceof PgStatement)) throw new Error("PgD1.batch() only accepts statements created by PgD1.prepare()");
        out.push((await statement.execWith(client)) as PgD1Result<T>);
      }
      await client.query("COMMIT");
      return out;
    } catch (error) {
      await client.query("ROLLBACK");
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
