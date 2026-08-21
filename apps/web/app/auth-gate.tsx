"use client";

import { useEffect } from "react";
import { authClient } from "@/lib/auth-client";
import { PlanbraidQueryProvider } from "@/lib/query-cache";
import { PlanbraidApp } from "@/app/planbraid-app";

export function AuthGate() {
  const { data: session, isPending } = authClient.useSession();
  useEffect(() => {
    if (!isPending && !session) window.location.replace("/sign-in");
  }, [isPending, session]);
  if (isPending || !session) return <div className="loading-screen"><div className="brand-mark graphic" aria-hidden="true" /><div><strong>Planbraid</strong><span>Securing your workspace…</span></div></div>;
  return <PlanbraidQueryProvider key={session.user.id}><PlanbraidApp /></PlanbraidQueryProvider>;
}
