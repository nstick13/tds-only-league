import { redirect } from "next/navigation";
import {
  getMyProfile,
  getStages,
  getManagers,
  getProfiles,
  getCurrentStage,
  getSyncStatus,
  getManualSyncCooldowns,
} from "@/lib/db";
import { PixelPanel } from "@/components/ui/PixelPanel";
import { CommishSection } from "@/components/commish/CommishSection";
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
 *
 * LAYOUT
 * ---------------------------------------------------------------------------
 * Ordered by how urgently you need each tool, not by how the code is
 * organized. During a draft the pick-for-a-manager panel is the thing
 * you're reaching for in a hurry, so it sits at the top the moment a draft
 * is open and disappears when it isn't. Setup (draft order), fixes
 * (rosters), and rarely-touched admin (managers, sync) follow.
 */
export default async function CommishPage() {
  const profile = await getMyProfile();

  if (!profile?.is_commissioner) {
    redirect("/");
  }

  const [stages, managers, profiles, currentStage, syncStatus, syncCooldowns] = await Promise.all([
    getStages(),
    getManagers(),
    getProfiles(),
    getCurrentStage(),
    getSyncStatus(),
    getManualSyncCooldowns(),
  ]);

  const draftIsOpen = currentStage?.status === "draft_open";
  const stageNote = currentStage
    ? `${currentStage.name} — ${currentStage.status.replace(/_/g, " ")}`
    : "no active stage";

  return (
    <div className="flex flex-col gap-8">
      <PixelPanel raised className="flex flex-col gap-1">
        <h1 className="font-pixel text-lg text-retro-yellow">Commish Tools</h1>
        <p className="font-mono text-base text-retro-offwhite/70">
          Season control, draft order, roster corrections, manager admin, and
          data sync.
        </p>
      </PixelPanel>

      {draftIsOpen && currentStage ? (
        <CommishSection
          title="Draft In Progress"
          blurb="Pick on behalf of a manager who can't get to the app, or undo a pick that just went in wrong."
          note={stageNote}
        >
          <DraftPickForManager currentStage={currentStage} managers={managers} />
        </CommishSection>
      ) : null}

      <CommishSection
        title="Season"
        blurb="Open the season, and finalize each stage to score it and open the next one."
        note={draftIsOpen ? undefined : stageNote}
      >
        <SeasonControl stages={stages} managers={managers} currentStage={currentStage} />
      </CommishSection>

      <CommishSection
        title="Rosters"
        blurb="Fix a roster after the fact — swap an injured or mis-drafted player, or add and remove directly. Works after a stage locks."
      >
        <RosterEditor stages={stages} managers={managers} />
      </CommishSection>

      <CommishSection
        title="Draft Order"
        blurb="Inspect or hand-edit the pick order for any stage. Normally generated automatically when a stage opens."
      >
        <DraftOrderEditor stages={stages} managers={managers} />
      </CommishSection>

      <CommishSection
        title="League Admin"
        blurb="Who plays, who commishes, and which manager seat they hold. Rarely changes after setup."
      >
        <ManagerAdmin profiles={profiles} />
      </CommishSection>

      <CommishSection
        title="Data"
        blurb="Freshness of the synced player and score data, and manual re-triggers when you can't wait for the next scheduled run."
      >
        <SyncPanel syncStatus={syncStatus} cooldowns={syncCooldowns} />
      </CommishSection>
    </div>
  );
}
