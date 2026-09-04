import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { publicSupabaseEnv } from "./env";

/**
 * Refreshes the Supabase auth session on every request. Called from the
 * root middleware.ts. Follows the standard @supabase/ssr Next.js App
 * Router pattern — do not remove or the session cookie will silently
 * expire client-side.
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const { url, anonKey } = publicSupabaseEnv();
  const supabase = createServerClient(
    url,
    anonKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options: CookieOptions }[],
        ) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Refreshes the session if expired — required for Server Components,
  // which cannot write cookies themselves.
  await supabase.auth.getUser();

  return supabaseResponse;
}
