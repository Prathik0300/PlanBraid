import { authFor, type AuthEnvironment } from "@/lib/auth";
import { ensureSchema } from "@/db/setup";
import type { Principal } from "@/lib/store";

type AuthSession = Awaited<ReturnType<ReturnType<typeof authFor>["api"]["getSession"]>>;

function authenticationRequired() {
  return Object.assign(new Error("Sign in to your Planbraid account"), {
    code: "AUTHENTICATION_REQUIRED",
    status: 401,
  });
}

async function canonicalUserId(db: D1Database, request: Request, session: NonNullable<AuthSession>) {
  const existing = await db.prepare("SELECT canonical_user_id FROM auth_principal_links WHERE auth_user_id = ?")
    .bind(session.user.id).first<{ canonical_user_id: string }>();
  if (existing) return existing.canonical_user_id;

  let candidate = session.user.id;
  const legacyUserId = request.headers.get("oai-authenticated-user-id");
  if (legacyUserId) {
    const legacyWorkspace = await db.prepare("SELECT id FROM organizations WHERE owner_user_id = ?")
      .bind(legacyUserId).first<{ id: string }>();
    if (legacyWorkspace) candidate = legacyUserId;
  }

  await db.prepare("INSERT OR IGNORE INTO auth_principal_links (auth_user_id, canonical_user_id) VALUES (?, ?)")
    .bind(session.user.id, candidate).run();
  let link = await db.prepare("SELECT canonical_user_id FROM auth_principal_links WHERE auth_user_id = ?")
    .bind(session.user.id).first<{ canonical_user_id: string }>();
  if (!link) {
    await db.prepare("INSERT OR IGNORE INTO auth_principal_links (auth_user_id, canonical_user_id) VALUES (?, ?)")
      .bind(session.user.id, session.user.id).run();
    link = await db.prepare("SELECT canonical_user_id FROM auth_principal_links WHERE auth_user_id = ?")
      .bind(session.user.id).first<{ canonical_user_id: string }>();
  }
  return link?.canonical_user_id ?? session.user.id;
}

export async function principalFromRequest(runtime: AuthEnvironment, request: Request): Promise<Principal> {
  await ensureSchema(runtime.DB);
  const session = await authFor(runtime).api.getSession({ headers: request.headers });
  if (!session) throw authenticationRequired();
  return {
    userId: await canonicalUserId(runtime.DB, request, session),
    email: session.user.email,
    displayName: session.user.name || session.user.email.split("@")[0] || "You",
    authentication: "browser",
  };
}
