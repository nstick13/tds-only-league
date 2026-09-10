import { redirect } from "next/navigation";
import { getMyProfile } from "@/lib/db/profiles";
import { DisplayNameForm } from "./DisplayNameForm";
import { NotificationToggle } from "@/components/settings/NotificationToggle";

/**
 * Manager settings: display name and per-device push notifications. The app
 * shell links here from the signed-in user's name in the top nav, and
 * first-time sign-ins are routed here (?welcome=1) by the OAuth callback so
 * they can pick a name before diving in.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: { welcome?: string };
}) {
  const profile = await getMyProfile();
  if (!profile) redirect("/login");

  // Without VAPID keys nothing can be sent, so the toggle is hidden rather
  // than offering a switch that silently does nothing.
  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() ?? "";

  return (
    <div className="max-w-md mx-auto w-full flex flex-col gap-6">
      <DisplayNameForm
        initialName={profile.display_name ?? ""}
        welcome={searchParams.welcome === "1"}
      />
      {vapidPublicKey ? (
        <NotificationToggle vapidPublicKey={vapidPublicKey} />
      ) : null}
    </div>
  );
}
