import type { Metadata } from "next";
import { AuthScreen } from "@/app/auth-screen";

export const metadata: Metadata = {
  title: "Sign in · Planbraid",
  description: "Sign in to your private Planbraid workspace.",
};

export const dynamic = "force-dynamic";

export default function SignInPage() {
  return <AuthScreen />;
}
