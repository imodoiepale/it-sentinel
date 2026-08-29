"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabase";
import { SentinelMark } from "../../components/marketing/SiteHeader";

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
    <div className="flex min-h-screen flex-col bg-[#0b0f14]">
      <div className="mx-auto flex w-full max-w-6xl items-center px-6 py-6 lg:px-8">
        <Link href="/" className="flex items-center gap-2.5">
          <SentinelMark />
          <span className="text-sm font-semibold tracking-tight text-white">IT Sentinel</span>
        </Link>
      </div>

      <main className="flex flex-1 items-center justify-center px-6 pb-24">
        <form onSubmit={handleSubmit} className="w-full max-w-sm">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-healthy-ink">
            Sentinel Global
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-white">Sign in</h1>
          <p className="mt-2 text-sm text-muted">
            An operator sees exactly what their site access grants. Nothing else loads.
          </p>

          <div className="mt-8 rounded-xl border border-white/[0.09] bg-white/[0.02] p-6">
            <label htmlFor="email" className="block text-xs font-medium text-gray-400">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mb-4 mt-1.5 w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-muted"
              autoComplete="username"
            />

            <label htmlFor="password" className="block text-xs font-medium text-gray-400">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mb-5 mt-1.5 w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-muted"
              autoComplete="current-password"
            />

            {/*
              role="alert" so a screen reader hears a rejected sign-in; the
              message is otherwise only distinguishable by its colour.
            */}
            {error && (
              <div role="alert" className="mb-4 text-xs leading-5 text-critical-ink">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-healthy py-2.5 text-sm font-semibold text-black transition-colors hover:bg-healthy-ink disabled:opacity-50"
            >
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </div>

          <p className="mt-6 text-xs text-muted">
            <Link href="/" className="underline underline-offset-4 hover:text-gray-300">
              Back to the overview
            </Link>
          </p>
        </form>
      </main>
    </div>
  );
}
