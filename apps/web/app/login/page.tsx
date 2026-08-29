"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabase";
import { SentinelMark } from "../../components/marketing/SiteHeader";
import { ui } from "../../lib/theme";
import { Button } from "../../components/ui/Button";

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
    router.push("/console");
  }

  return (
    <div className={`flex min-h-screen flex-col ${ui.canvas}`}>
      <div className={`${ui.page} flex items-center py-6`}>
        <Link href="/" className="flex items-center gap-2">
          <SentinelMark />
          <span className="text-[14px] font-medium text-obsidian">IT Sentinel</span>
        </Link>
      </div>

      <main className="flex flex-1 items-center justify-center px-6 pb-24">
        <form onSubmit={handleSubmit} className="w-full max-w-sm">
          <p className={ui.eyebrow}>Sentinel Global</p>
          <h1 className={`mt-3 ${ui.headingSm}`}>Sign in</h1>
          <p className={`mt-2 ${ui.muted}`}>
            An operator sees exactly what their site access grants. Nothing else loads.
          </p>

          <div className={`mt-8 ${ui.card}`}>
            <label htmlFor="email" className={ui.caption}>
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`${ui.input} mb-4 mt-1.5 border-cloud`}
              autoComplete="username"
            />

            <label htmlFor="password" className={ui.caption}>
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`${ui.input} mb-5 mt-1.5 border-cloud`}
              autoComplete="current-password"
            />

            {error && (
              <div role="alert" className={`mb-4 ${ui.caption} text-iron`}>
                {error}
              </div>
            )}

            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </div>

          <p className={`mt-6 ${ui.caption}`}>
            <Link href="/" className="underline underline-offset-4 hover:text-obsidian">
              Back to the overview
            </Link>
          </p>
        </form>
      </main>
    </div>
  );
}
