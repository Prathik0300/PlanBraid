import type { Metadata } from "next";
import { AuthGate } from "./auth-gate";

export const metadata: Metadata = {
  title: "Planbraid - One plan across every agent",
  description: "Unified, source-aware project work planned and completed across Codex, Claude, Gemini, Copilot, and more.",
};

export const dynamic = "force-dynamic";

export default function Home() {
  return <AuthGate />;
}
