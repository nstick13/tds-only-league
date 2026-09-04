"use client";

import { createBrowserClient } from "@supabase/ssr";
import { publicSupabaseEnv } from "./env";

/**
 * Browser (client-component) Supabase client.
 * Use this inside "use client" components. For server components / route
 * handlers / server actions, use src/lib/supabase/server.ts instead.
 */
export function createClient() {
  const { url, anonKey } = publicSupabaseEnv();
  return createBrowserClient(url, anonKey);
}
