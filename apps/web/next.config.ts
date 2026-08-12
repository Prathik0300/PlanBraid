import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(import.meta.dirname),
  },
  // Next.js's default 308 redirect for a trailing slash (e.g. POST /token/ -> /token)
  // happens before the route handler runs at all, and not every OAuth client's HTTP
  // library correctly re-sends a POST body through a 308. The OAuth/MCP endpoints
  // (/register, /authorize, /token, /revoke, /mcp, the .well-known metadata routes)
  // need to accept both forms directly rather than depend on every client's redirect
  // handling being correct — there's no legitimate reason to reject either form here.
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
