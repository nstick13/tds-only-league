import { PixelPanel } from "@/components/ui/PixelPanel";
import { createClient } from "@/lib/supabase/server";
import {
  getCurrentStage,
  getDraftOrder,
  getManagers,
  getMyProfile,
  getPlayers,
  getRosterPicks,
} from "@/lib/db";
import { DraftBoard } from "@/app/(app)/draft/DraftBoard";
import { TeamRosters } from "@/components/draft/TeamRosters";

/**
 * /draft — the live draft room. Interactive only while the current stage's
 * status is 'draft_open'; otherwise a read-only state (with the roster
 * snapshot once picks exist, e.g. while locked).
 */
export default async function DraftPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const stage = await getCurrentStage();

  if (!stage) {
    return (
      <PixelPanel raised className="flex flex-col gap-3 items-center text-center py-12">
        <h1 className="font-pixel text-lg text-retro-yellow">Draft</h1>
        <p className="font-mono text-lg text-retro-offwhite/80">
          The season is over — no active stage.
        </p>
      </PixelPanel>
    );
  }

  const [managers, picks] = await Promise.all([getManagers(), getRosterPicks(stage.id)]);

  if (stage.status !== "draft_open") {
    const players = picks.length > 0 ? await getPlayers() : [];
    const playersById = new Map(players.map((p) => [p.id, p]));

    return (
      <div className="flex flex-col gap-4">
        <PixelPanel raised className="flex flex-col gap-2 items-center text-center py-8">
          <h1 className="font-pixel text-lg text-retro-yellow">Draft — {stage.name}</h1>
          <p className="font-mono text-lg text-retro-offwhite/80 uppercase">
            {stage.status === "locked"
              ? "Rosters locked for this stage."
              : "Draft is not open yet."}
          </p>
        </PixelPanel>

        {picks.length > 0 ? (
          <TeamRosters
            managers={managers}
            picks={picks}
            playersById={playersById}
            currentUserId={user?.id ?? null}
          />
        ) : null}
      </div>
    );
  }

  const [draftOrder, players, profile] = await Promise.all([
    getDraftOrder(stage.id),
    getPlayers(),
    getMyProfile(),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-pixel text-lg text-retro-yellow text-center">
        Draft — {stage.name}
      </h1>
      <DraftBoard
        stageId={stage.id}
        initialDraftOrder={draftOrder}
        initialPicks={picks}
        managers={managers}
        allPlayers={players}
        currentUserId={user?.id ?? null}
        isCommissioner={profile?.is_commissioner ?? false}
      />
    </div>
  );
}
