"use client";

import { FormEvent, useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { emailSignInSchema, emailSignUpSchema } from "@/lib/auth-validation";
import { GoogleIcon } from "@/app/google-icon";

type Mode = "sign-in" | "sign-up";
type FieldErrors = { name?: string; email?: string; password?: string };

function safeReturnTo() {
  const value = new URLSearchParams(window.location.search).get("returnTo") || "/";
  return value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export function AuthScreen() {
  const { data: session } = authClient.useSession();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const saved = window.localStorage.getItem("planbraid-theme");
      setTheme(saved === "dark" || saved === "light" ? saved : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.size === 1 && params.get("returnTo") === "/") window.history.replaceState(null, "", "/sign-in");
  }, []);

  useEffect(() => {
    if (session) { window.location.replace(safeReturnTo()); return; }
    void fetch("/api/auth-config", { cache: "no-store" }).then((response) => response.json()).then((body: { data?: { googleEnabled?: boolean } }) => setGoogleEnabled(Boolean(body.data?.googleEnabled))).catch(() => undefined);
  }, [session]);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem("planbraid-theme", next);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setFieldErrors({});
    setBusy(true);
    try {
      let result;
      if (mode === "sign-up") {
        const parsed = emailSignUpSchema.safeParse({ name, email, password });
        if (!parsed.success) {
          const errors = parsed.error.flatten().fieldErrors;
          setFieldErrors({ name: errors.name?.[0], email: errors.email?.[0], password: errors.password?.[0] });
          setMessage("Check the highlighted fields and try again.");
          return;
        }
        result = await authClient.signUp.email({ ...parsed.data, callbackURL: safeReturnTo() });
      } else {
        const parsed = emailSignInSchema.safeParse({ email, password });
        if (!parsed.success) {
          const errors = parsed.error.flatten().fieldErrors;
          setFieldErrors({ email: errors.email?.[0], password: errors.password?.[0] });
          setMessage("Check the highlighted fields and try again.");
          return;
        }
        result = await authClient.signIn.email({ ...parsed.data, callbackURL: safeReturnTo() });
      }
      if (result.error) throw new Error(result.error.message || "Authentication failed");
      window.location.assign(safeReturnTo());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  async function continueWithGoogle() {
    if (!googleEnabled) return;
    setBusy(true);
    setMessage(null);
    const result = await authClient.signIn.social({ provider: "google", callbackURL: safeReturnTo() });
    if (result?.error) {
      setMessage(result.error.message || "Google sign-in could not start");
      setBusy(false);
    }
  }

  return <main className="auth-page">
    <button className={`theme-switch auth-theme-switch ${theme}`} role="switch" aria-checked={theme === "light"} onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}><span className="theme-switch-thumb" aria-hidden="true"><span className="theme-switch-icon moon">☾</span><span className="theme-switch-icon sun">☼</span></span></button>
    <section className="auth-story" aria-label="About Planbraid">
      <div className="auth-brand"><span className="planbraid-logo" aria-hidden="true" /><strong>Planbraid</strong></div>
      <div className="auth-story-copy"><span className="eyebrow">ONE PLAN · EVERY AGENT</span><h1>Never lose the thread of your project again.</h1><p>Choose any AI model and move between them without losing progress. Planbraid keeps plans, tasks, blockers, and verified results in one place, so every agent stays aligned and no work is planned or completed twice.</p></div>
      <div className="auth-weave" aria-hidden="true"><i /><i /><i /><i /></div>
      <p className="auth-privacy"><span>⌁</span><strong>Built for minimal data.</strong> Planbraid stores project and task state - not your chat transcripts.</p>
    </section>
    <section className="auth-panel">
      <div className="auth-card">
        <header><span className="auth-mobile-brand"><span className="planbraid-logo" aria-hidden="true" />Planbraid</span><h2>{mode === "sign-in" ? "Welcome back" : "Create your account"}</h2><p>{mode === "sign-in" ? "Sign in to open your unified workspace." : "Start a private workspace for all your agents."}</p></header>
        <button className="google-auth" type="button" disabled={!googleEnabled || busy} onClick={() => void continueWithGoogle()}>
          <GoogleIcon /> Continue with Google
        </button>
        {!googleEnabled && <p className="oauth-unavailable">Google sign-in is ready in the app but needs the deployment&apos;s Google OAuth credentials.</p>}
        <div className="auth-divider"><span>or use email</span></div>
        <form className="auth-form" onSubmit={submit} noValidate>
          {mode === "sign-up" && <label><span>Name</span><input autoComplete="name" value={name} onChange={(event) => { setName(event.target.value); setFieldErrors((current) => ({ ...current, name: undefined })); }} required minLength={2} maxLength={80} placeholder="Your name" aria-invalid={Boolean(fieldErrors.name)} aria-describedby={fieldErrors.name ? "name-error" : undefined} />{fieldErrors.name && <small className="field-error" id="name-error">{fieldErrors.name}</small>}</label>}
          <label><span>Email address</span><input type="email" autoComplete="email" value={email} onChange={(event) => { setEmail(event.target.value); setFieldErrors((current) => ({ ...current, email: undefined })); }} required maxLength={254} placeholder="you@example.com" aria-invalid={Boolean(fieldErrors.email)} aria-describedby={fieldErrors.email ? "email-error" : undefined} />{fieldErrors.email && <small className="field-error" id="email-error">{fieldErrors.email}</small>}</label>
          <label><span>Password</span><input type="password" autoComplete={mode === "sign-in" ? "current-password" : "new-password"} value={password} onChange={(event) => { setPassword(event.target.value); setFieldErrors((current) => ({ ...current, password: undefined })); }} required minLength={mode === "sign-up" ? 10 : 1} maxLength={128} placeholder={mode === "sign-up" ? "Create a strong password" : "Enter your password"} aria-invalid={Boolean(fieldErrors.password)} aria-describedby={fieldErrors.password ? "password-error" : mode === "sign-up" ? "password-requirements" : undefined} />{mode === "sign-up" && <small className="field-hint" id="password-requirements">Use 10 or more characters with uppercase, lowercase, a number, and a special character.</small>}{fieldErrors.password && <small className="field-error" id="password-error">{fieldErrors.password}</small>}</label>
          {message && <div className="auth-error" role="alert">{message}</div>}
          <button className="auth-submit" type="submit" disabled={busy}>{busy ? "Please wait…" : mode === "sign-in" ? "Sign in" : "Create account"}</button>
        </form>
        <p className="auth-switch">{mode === "sign-in" ? "New to Planbraid?" : "Already have an account?"} <button onClick={() => { setMode(mode === "sign-in" ? "sign-up" : "sign-in"); setMessage(null); setFieldErrors({}); }}>{mode === "sign-in" ? "Create an account" : "Sign in"}</button></p>
        <footer>By continuing, you agree to keep your account credentials secure.</footer>
      </div>
    </section>
  </main>;
}
