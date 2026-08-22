import { betterAuth } from "better-auth";
import { anonymous } from "better-auth/plugins";
import type { PgD1 } from "@/db/pg-d1";
import { claimGuestOrganization } from "@/lib/guest";

const LOCAL_SECRET = "planbraid-local-development-secret-change-before-hosting";
const LOCAL_ORIGIN = "http://localhost:3000";

export type AuthEnvironment = {
  DB: PgD1;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};

function configuredOrigin(runtime: AuthEnvironment) {
  return runtime.BETTER_AUTH_URL?.replace(/\/$/, "") || LOCAL_ORIGIN;
}

function googleProvider(runtime: AuthEnvironment) {
  if (!runtime.GOOGLE_CLIENT_ID || !runtime.GOOGLE_CLIENT_SECRET) return {};
  return {
    google: {
      clientId: runtime.GOOGLE_CLIENT_ID,
      clientSecret: runtime.GOOGLE_CLIENT_SECRET,
      prompt: "select_account" as const,
    },
  };
}

export function authFor(runtime: AuthEnvironment) {
 return betterAuth({
  // better-auth's Kysely adapter detects the Postgres dialect by checking for a
  // `.connect()` method on this object, so it needs the raw pg.Pool, not the PgD1
  // wrapper — they share the same underlying pool/connection budget either way.
  database: runtime.DB.pool,
  secret: runtime.BETTER_AUTH_SECRET || LOCAL_SECRET,
  baseURL: configuredOrigin(runtime),
  basePath: "/api/auth",
  trustedOrigins: [configuredOrigin(runtime), LOCAL_ORIGIN],
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    autoSignIn: true,
  },
  socialProviders: googleProvider(runtime),
  account: {
    encryptOAuthTokens: true,
    accountLinking: {
      enabled: true,
      disableImplicitLinking: false,
      requireLocalEmailVerified: false,
      trustedProviders: [],
      allowDifferentEmails: false,
      allowUnlinkingAll: false,
      updateUserInfoOnLink: false,
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  rateLimit: {
    enabled: true,
    storage: "database",
  },
  plugins: [
    // Lets a Product Hunt / cold-traffic visitor land straight in a working sandbox
    // (see lib/guest.ts) instead of a sign-up wall. onLinkAccount fires when that same
    // browser later signs up or signs in for real, while the anonymous session cookie is
    // still live — better-auth swaps the session for the new account automatically; this
    // hook is only responsible for handing the sandbox's data over with it.
    anonymous({
      emailDomainName: "guest.planbraid.app",
      onLinkAccount: async ({ anonymousUser, newUser }) => {
        await claimGuestOrganization(runtime.DB, anonymousUser.user.id, newUser.user.id);
      },
    }),
  ],
 });
}

export function googleAuthEnabled(runtime: AuthEnvironment) {
  return Boolean(runtime.GOOGLE_CLIENT_ID && runtime.GOOGLE_CLIENT_SECRET);
}

export function hostedAuthConfigured(runtime: AuthEnvironment, request: Request) {
  const hostname = new URL(request.url).hostname;
  const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  return local || Boolean(runtime.BETTER_AUTH_SECRET && runtime.BETTER_AUTH_SECRET.length >= 32);
}
