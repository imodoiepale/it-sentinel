"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabase";

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
    router.push("/");
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0b0f14]">
      <form onSubmit={handleSubmit} className="w-full max-w-sm p-6 border border-white/10 rounded-lg bg-black/20">
        <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">Sentinel Global</div>
        <h1 className="text-lg font-semibold mb-6">IT Sentinel</h1>

        <label className="block text-xs text-gray-400 mb-1">Email</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full mb-4 px-3 py-2 rounded bg-white/5 border border-white/10 text-sm"
          autoComplete="username"
        />

        <label className="block text-xs text-gray-400 mb-1">Password</label>
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full mb-4 px-3 py-2 rounded bg-white/5 border border-white/10 text-sm"
          autoComplete="current-password"
        />

        {error && <div className="text-critical text-xs mb-4">{error}</div>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full py-2 rounded bg-healthy/90 hover:bg-healthy text-black text-sm font-medium disabled:opacity-50"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
