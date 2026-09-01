"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { PixelButton } from "@/components/ui/PixelButton";
import { PixelPanel } from "@/components/ui/PixelPanel";

/**
 * Sole sign-in page. Auth is Google OAuth via Supabase — no passwords are
 * stored anywhere, and there's no email-confirmation step to get wrong.
 * Clicking the button hands off to Google; Supabase brings the manager
 * back to /auth/callback (see src/app/auth/callback/route.ts), which
 * exchanges the code for a session and redirects into the app.
 *
 * Signup and login are the same action with OAuth: the first time a
 * manager authorizes with Google, the on_auth_user_created DB trigger
 * creates their profile row and (for the first 8) assigns a manager seat.
 */
function LoginForm() {
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(
    searchParams.get("error") ? "Sign-in failed. Please try again." : null,
  );
  const [loading, setLoading] = useState(false);

  async function signInWithGoogle() {
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        // Send Google back to our server callback on whatever host the app
        // is currently running on (localhost in dev, the Vercel domain in
        // prod). This must also be listed in Supabase's Redirect URLs.
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    // On success the browser is already navigating to Google, so we only
    // reach here (with loading still true) on an immediate failure.
    if (oauthError) {
      setError(oauthError.message);
      setLoading(false);
    }
  }

  return (
    <PixelPanel raised className="w-full max-w-sm flex flex-col gap-6">
      <h1 className="font-pixel text-lg text-retro-yellow">Sign In</h1>

      <p className="font-mono text-lg text-retro-offwhite">
        TD&apos;s Only is invite-only for the league&apos;s 8 managers. Sign in
        with your Google account to get your seat.
      </p>

      {error ? (
        <p className="font-mono text-retro-red text-base">{error}</p>
      ) : null}

      <PixelButton type="button" onClick={signInWithGoogle} disabled={loading}>
        {loading ? "Redirecting..." : "Sign in with Google"}
      </PixelButton>
    </PixelPanel>
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-16">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
