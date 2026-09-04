import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getMyProfile } from "@/lib/db/profiles";
import { PixelButton } from "@/components/ui/PixelButton";
import { DataFreshness } from "@/components/DataFreshness";

/**
 * Authenticated app shell. Every route under src/app/(app)/ renders inside
 * this layout: requires a session (redirects to /login otherwise), loads
 * the signed-in user's profile, and renders the retro top nav + the loud
 * staleness banner above {children}. Feature agents building draft/
 * my-roster/standings/history/commish pages get this shell for free —
 * don't duplicate nav/auth-guard logic in those pages.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const profile = await getMyProfile();
  const displayName = profile?.display_name ?? user.email ?? "Manager";

  const navLinks = [
    { href: "/draft", label: "Draft" },
    { href: "/my-roster", label: "My Roster" },
    { href: "/standings", label: "Standings" },
    { href: "/history", label: "History" },
  ];

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-field-dark border-b-4 border-retro-offwhite">
        <div className="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <Link href="/" className="font-pixel text-xs sm:text-sm text-retro-yellow leading-relaxed">
            TD&apos;s Only
          </Link>

          <nav className="flex flex-wrap items-center gap-2 sm:gap-3 font-pixel text-[10px] sm:text-xs uppercase">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="px-2 py-2 border-2 border-transparent text-retro-offwhite hover:border-retro-offwhite hover:text-retro-yellow transition-colors"
              >
                {link.label}
              </Link>
            ))}
            {profile?.is_commissioner ? (
              <Link
                href="/commish"
                className="px-2 py-2 border-2 border-retro-yellow text-retro-yellow hover:bg-retro-yellow hover:text-field transition-colors"
              >
                Commish
              </Link>
            ) : null}
          </nav>

          <div className="flex items-center gap-3">
            <Link
              href="/settings"
              className="font-mono text-base text-retro-offwhite hover:text-retro-yellow underline decoration-transparent hover:decoration-current hidden sm:inline"
              title="Settings — change your display name"
            >
              {displayName}
            </Link>
            <form action="/auth/sign-out" method="post">
              <PixelButton variant="secondary" type="submit" className="!px-3 !py-2 text-[10px]">
                Sign Out
              </PixelButton>
            </form>
          </div>
        </div>
      </header>

      <DataFreshness />

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
