"use client";

import { useEffect } from "react";
import { authClient } from "@/lib/auth-client";
import { PlanbraidQueryProvider } from "@/lib/query-cache";
import { PlanbraidApp } from "@/app/planbraid-app";

export function AuthGate() {
  const { data: session, isPending } = authClient.useSession();
  useEffect(() => {
    // A better-auth anonymous session (guest sandbox) is still a session - only a fully
    // signed-out visitor gets sent to /sign-in. See auth-screen.tsx's isAnonymousSession
    // for the other half of this: that screen must not treat this same session as
    // "already signed in" and bounce it straight back here.
    if (!isPending && !session) window.location.replace("/sign-in");
  }, [isPending, session]);
  if (isPending || !session) return <div className="loading-screen"><div className="brand-mark graphic" aria-hidden="true" /><div><strong>Planbraid</strong><span>Securing your workspace…</span></div></div>;
  const isGuest = Boolean((session.user as { isAnonymous?: boolean | null }).isAnonymous);
  return <PlanbraidQueryProvider key={session.user.id}>
    {isGuest && <GuestBanner />}
    <PlanbraidApp />
  </PlanbraidQueryProvider>;
}

/** Plain inline styling deliberately: this banner is the one guest-only affordance in
 * the authenticated app, and using the shared CSS variables (theme-aware already) keeps
 * it in step with light/dark without adding a new class to globals.css for one banner. */
function GuestBanner() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: "10px", padding: "8px 16px", background: "var(--accent-bg)", color: "var(--text)", borderBottom: "1px solid var(--line)", fontSize: "12px", textAlign: "center" }}>
      <span>You&apos;re exploring a guest sandbox - it expires after 48 hours of inactivity.</span>
      <a href="/sign-in" style={{ color: "var(--blue)", fontWeight: 600, textDecoration: "none" }}>Sign up to keep it →</a>
    </div>
  );
}
