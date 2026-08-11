import { betterAuth } from "better-auth";

const LOCAL_SECRET = "planbraid-local-development-secret-change-before-hosting";
const LOCAL_ORIGIN = "http://localhost:3000";

export type AuthEnvironment = {
  DB: D1Database;
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
  database: runtime.DB as never,
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
