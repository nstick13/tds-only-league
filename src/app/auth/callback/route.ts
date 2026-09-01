import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * OAuth / PKCE callback. Supabase redirects the browser here after a
 * successful "Sign in with Google" (the `redirectTo` set in the login page
 * points at this route). We exchange the one-time `?code=` for a real
 * session — this is what writes the auth cookies server-side — then send
 * the manager on to the app.
 *
 * IMPORTANT: the redirect is built from the *incoming request's* host, not
 * a hard-coded URL, so it works identically in local dev and on Vercel. On
 * Vercel the real host arrives in `x-forwarded-host`; behind that proxy
 * `origin` can be the internal address, so prefer the forwarded host in
 * production. This is the piece that was missing when confirmation links
 * bounced everyone back to localhost.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // Where to land after auth; only allow app-relative paths.
  const nextParam = searchParams.get("next");
  const next = nextParam && nextParam.startsWith("/") ? nextParam : "/";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // First-time sign-ins land on settings to pick a display name. We
      // detect "new" by a freshly-created profile row (the DB trigger
      // creates it on first auth); returning managers go straight to `next`.
      let dest = next;
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) {
          const { data: profile } = await supabase
            .from("profiles")
            .select("created_at")
            .eq("id", user.id)
            .maybeSingle();
          if (
            profile?.created_at &&
            Date.now() - new Date(profile.created_at).getTime() < 120_000
          ) {
            dest = "/settings?welcome=1";
          }
        }
      } catch {
        // Non-fatal — fall back to the default destination.
      }

      const forwardedHost = request.headers.get("x-forwarded-host");
      const isLocalEnv = process.env.NODE_ENV === "development";

      if (!isLocalEnv && forwardedHost) {
        return NextResponse.redirect(`https://${forwardedHost}${dest}`);
      }
      return NextResponse.redirect(`${origin}${dest}`);
    }
  }

  // No code, or the exchange failed — bounce back to the sign-in page with
  // a flag the page can surface to the user.
  return NextResponse.redirect(`${origin}/login?error=auth`);
}
