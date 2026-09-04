import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { publicSupabaseEnv, serviceRoleEnv } from "./env";

/**
 * Server-side Supabase client for Server Components, Route Handlers, and
 * Server Actions. Reads/writes the auth session via Next.js cookies().
 *
 * NOTE: calling `.set()` from a Server Component (not a Route Handler or
 * Server Action) will throw — that's expected and safe to ignore as long as
 * middleware.ts is refreshing the session on every request (see
 * src/lib/supabase/middleware.ts and root middleware.ts).
 */
export async function createClient() {
  const cookieStore = await cookies();

  const { url, anonKey } = publicSupabaseEnv();

  return createServerClient(
    url,
    anonKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options: CookieOptions }[],
        ) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component — ignore, middleware handles
            // session refresh on the request/response cycle instead.
          }
        },
      },
    },
  );
}

/**
 * Admin/service-role client for privileged server-only operations
 * (e.g. Edge Functions, trusted server actions that must bypass RLS).
 * NEVER import this into client components or expose the service key
 * to the browser.
 */
export function createServiceRoleClient() {
  const { url, serviceKey } = serviceRoleEnv();

  return createSupabaseClient(url, serviceKey, {
    auth: { persistSession: false },
  });
}
