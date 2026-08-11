/**
 * Drop-in replacement for the old `import { env } from "cloudflare:workers"` binding —
 * every API route imported that single object and read `env.DB`/`env.VAPID_*`/etc. off
 * it, so this preserves the same shape/name, just sourced from `process.env` and a
 * pooled Postgres connection instead of a Workers binding.
 */
import { Pool } from "pg";
import { PgD1 } from "@/db/pg-d1";

declare global {
  var __planbraidPool: Pool | undefined;
}

function pool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  // Survives Next.js dev-mode module reloads so we don't open a fresh pool per HMR tick.
  if (!globalThis.__planbraidPool) globalThis.__planbraidPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  return globalThis.__planbraidPool;
}

export const env = {
  // Lazy: only opens/touches the pool on first actual access, not at module import
  // time — routes that never query the database (OAuth discovery metadata, etc.)
  // should work even before DATABASE_URL is configured, and this keeps `next build`
  // from depending on database reachability for routes it merely bundles.
  get DB() { return new PgD1(pool()); },
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
  VAPID_SUBJECT: process.env.VAPID_SUBJECT,
};
