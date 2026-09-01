import { redirect } from "next/navigation";
import { getMyProfile } from "@/lib/db/profiles";
import { DisplayNameForm } from "./DisplayNameForm";

/**
 * Manager settings. Currently just the display name — the app shell links
 * here from the signed-in user's name in the top nav, and first-time
 * sign-ins are routed here (?welcome=1) by the OAuth callback so they can
 * pick a name before diving in.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: { welcome?: string };
}) {
  const profile = await getMyProfile();
  if (!profile) redirect("/login");

  return (
    <div className="max-w-md mx-auto w-full">
      <DisplayNameForm
        initialName={profile.display_name ?? ""}
        welcome={searchParams.welcome === "1"}
      />
    </div>
  );
}
