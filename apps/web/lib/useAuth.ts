"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

/**
 * Thin wrapper over Supabase Auth session state. There is no "logged in as
 * admin, sees everything" shortcut anywhere in this app — every screen
 * renders strictly what RLS permits for whichever operator this session
 * resolves to. Logging out simply drops the session; it does not need to
 * revoke anything server-side beyond what Supabase Auth already handles.
 */
export function useAuth() {
  const [session, setSession] = useState<Session | null | undefined>(undefined); // undefined = not yet resolved

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  return {
    session,
    loading: session === undefined,
    operatorId: session?.user.id ?? null,
    signOut: () => supabase.auth.signOut(),
  };
}
