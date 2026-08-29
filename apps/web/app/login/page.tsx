"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabase";
import { SentinelMark } from "../../components/marketing/SiteHeader";
import { ThemeToggle } from "../../components/ThemeToggle";

/**
 * Supabase Auth email/password sign-in. MFA enrollment/challenge for
 * privileged roles is a follow-on (the plan calls for phishing-resistant
 * MFA on privileged access) — this is the baseline session entry point
 * every other screen's RLS-scoped data depends on.
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setSubmitting(false);
    if (signInError) {
      setError(signInError.message);
      return;
    }
    // "/" is the public landing page now; the console is the post-sign-in destination.
    router.push("/console");
  }

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-6 lg:px-8">
        <Link href="/" className="flex items-center gap-2.5">
          <SentinelMark />
          <span className="text-sm font-semibold tracking-tight text-ink">IT Sentinel</span>
        </Link>
        {/*
          The switch belongs here too. Sign-in is where an operator lands from
          a link on someone else's machine, which is exactly when the theme is
          most likely to be wrong for the room they are standing in.
        */}
        <ThemeToggle />
      </div>

      <main className="flex flex-1 items-center justify-center px-6 pb-24">
        <form onSubmit={handleSubmit} className="w-full max-w-sm">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-healthy-ink">
            Sentinel Global
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink">Sign in</h1>
          <p className="mt-2 text-sm text-muted">
            An operator sees exactly what their site access grants. Nothing else loads.
          </p>

          <div className="mt-8 rounded-xl border border-line bg-surface p-6">
            <label htmlFor="email" className="block text-xs font-medium text-ink-soft">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mb-4 mt-1.5 w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-muted"
              autoComplete="username"
            />

            <label htmlFor="password" className="block text-xs font-medium text-ink-soft">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mb-5 mt-1.5 w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-muted"
              autoComplete="current-password"
            />

            {/*
              role="alert" so a screen reader hears a rejected sign-in; the
              message is otherwise only distinguishable by its colour.
            */}
            {error && (
              <div role="alert" className="mb-4 rounded-md border border-critical/40 bg-critical/10 px-2.5 py-2 text-xs leading-5 text-critical-ink">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="ui-button ui-button-primary ui-button-block"
            >
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </div>

          <p className="mt-6 text-xs text-muted">
            <Link href="/" className="underline underline-offset-4 hover:text-ink">
              Back to the overview
            </Link>
          </p>
        </form>
      </main>
    </div>
  );
}
