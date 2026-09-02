import { redirect } from "next/navigation";
import {
  getMyProfile,
  getStages,
  getManagers,
  getProfiles,
  getCurrentStage,
  getSyncStatus,
} from "@/lib/db";
import { PixelPanel } from "@/components/ui/PixelPanel";
import { SeasonControl } from "@/components/commish/SeasonControl";
import { DraftPickForManager } from "@/components/commish/DraftPickForManager";
import { DraftOrderEditor } from "@/components/commish/DraftOrderEditor";
import { RosterEditor } from "@/components/commish/RosterEditor";
import { ManagerAdmin } from "@/components/commish/ManagerAdmin";
import { SyncPanel } from "@/components/commish/SyncPanel";

/**
 * Commissioner tools. Server-guarded (redirects non-commissioners even
 * though the nav only links here for them — see src/app/(app)/layout.tsx)
 * and every write below is re-guarded server-side again in actions.ts,
 * which RLS also enforces via is_commissioner(uid) (0002_functions.sql /
 * 0003_rls.sql). See docs/ARCHITECTURE.md "Roles model".
 */
export default async function CommishPage() {
  const profile = await getMyProfile();

  if (!profile?.is_commissioner) {
    redirect("/");
  }

  const [stages, managers, profiles, currentStage, syncStatus] = await Promise.all([
    getStages(),
    getManagers(),
    getProfiles(),
    getCurrentStage(),
    getSyncStatus(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PixelPanel raised className="flex flex-col gap-1">
        <h1 className="font-pixel text-lg text-retro-yellow">Commish Tools</h1>
        <p className="font-mono text-base text-retro-offwhite/70">
          Season control, draft order, roster corrections, and manager admin.
        </p>
      </PixelPanel>

      <SeasonControl stages={stages} managers={managers} currentStage={currentStage} />

      {currentStage?.status === "draft_open" ? (
        <DraftPickForManager currentStage={currentStage} managers={managers} />
      ) : null}

      <DraftOrderEditor stages={stages} managers={managers} />

      <RosterEditor stages={stages} managers={managers} />

      <ManagerAdmin profiles={profiles} />

      <SyncPanel syncStatus={syncStatus} />
    </div>
  );
}
