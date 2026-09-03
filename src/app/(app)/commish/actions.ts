"use server";

/**
 * Commissioner server actions. Every action re-checks is_commissioner on
 * the caller's own profile before doing anything — RLS also enforces this
 * on the underlying writes (see docs/ARCHITECTURE.md "Roles model"), but
 * we check up front too so we can return a friendly error instead of a
 * raw Postgres RLS-denial message.
 */
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  getMyProfile,
  getStages,
  getStageById,
  getManagers,
  getDraftOrder,
  getRosterPicks,
} from "@/lib/db";
import { generateDraftOrder, type StandingsSeed } from "@/lib/draftOrder";
import { computeStandings } from "@/lib/standings";
import type { PlayerStageStats } from "@/lib/types";
import type {
  ActionResult,
  ManualRosterEditInput,
  ManagerAdminUpdate,
  SyncSourceTrigger,
} from "./types";

async function requireCommissioner() {
  const profile = await getMyProfile();
  if (!profile?.is_commissioner) {
    return null;
  }
  return profile;
}

function friendlyDbError(message: string): string {
  if (message.includes("Roster limit exceeded")) return message;
  if (message.includes("roster_picks_stage_player_unique")) {
    return "That player is already on a roster for this stage.";
  }
  if (message.includes("manager_slot")) {
    return "That manager slot is already taken.";
  }
  return message;
}

async function writeDraftOrderRows(
  stageId: number,
  picks: string[],
): Promise<string | null> {
  const supabase = await createClient();

  const { error: deleteError } = await supabase
    .from("draft_order")
    .delete()
    .eq("stage_id", stageId);
  if (deleteError) return deleteError.message;

  const rows = picks.map((managerId, i) => ({
    stage_id: stageId,
    pick_number: i + 1,
    manager_id: managerId,
  }));

  const { error: insertError } = await supabase.from("draft_order").insert(rows);
  if (insertError) return insertError.message;

  return null;
}

/**
 * Opens the season: generates a random round-1 order for the lowest-
 * ordinal stage (Week 1) and writes its 48-row draft_order, then flips
 * that stage to draft_open. Refuses if that stage already has a draft
 * order (already opened) or if fewer than 8 managers are seated.
 */
export async function openSeasonAction(): Promise<ActionResult> {
  const commish = await requireCommissioner();
  if (!commish) return { success: false, message: "Commissioner access required." };

  const stages = await getStages();
  const firstStage = [...stages].sort((a, b) => a.ordinal - b.ordinal)[0];
  if (!firstStage) return { success: false, message: "No stages exist yet." };

  const existingOrder = await getDraftOrder(firstStage.id);
  if (existingOrder.some((r) => r.manager_id)) {
    return {
      success: false,
      message: `${firstStage.name} already has a draft order — season already opened.`,
    };
  }

  const managers = await getManagers();
  if (managers.length < 1) {
    return {
      success: false,
      message: "Need at least 1 seated manager to open the draft. Assign a manager_slot first.",
    };
  }

  const managerIds = managers.map((m) => m.id);
  const picks = generateDraftOrder(managerIds, null);

  const writeError = await writeDraftOrderRows(firstStage.id, picks);
  if (writeError) return { success: false, message: friendlyDbError(writeError) };

  const supabase = await createClient();
  const { error: statusError } = await supabase
    .from("stages")
    .update({ status: "draft_open" })
    .eq("id", firstStage.id);
  if (statusError) return { success: false, message: friendlyDbError(statusError.message) };

  revalidatePath("/commish");
  revalidatePath("/draft");
  revalidatePath("/");
  const warning = managers.length < 8
    ? ` (${managers.length}/8 managers seated — fine for testing, but you'll want all 8 for the real thing)`
    : "";
  return { success: true, message: `${firstStage.name} draft opened — order randomized.${warning}`, data: undefined };
}

/**
 * The core weekly-redraft loop: computes and finalizes standings for
 * `stageId`, then opens the next stage (by ordinal) with its draft order
 * seeded by those standings (last place picks first). If there is no
 * next stage, the season is over — this just finalizes.
 */
export async function finalizeAndAdvanceAction(stageId: number): Promise<ActionResult> {
  const commish = await requireCommissioner();
  if (!commish) return { success: false, message: "Commissioner access required." };

  const stage = await getStageById(stageId);
  if (!stage) return { success: false, message: "Stage not found." };
  if (stage.status === "finalized") {
    return { success: false, message: `${stage.name} is already finalized.` };
  }

  const [rosterPicks, managers] = await Promise.all([getRosterPicks(stageId), getManagers()]);
  const managerIds = managers.map((m) => m.id);

  const supabase = await createClient();
  const { data: statsData, error: statsError } = await supabase
    .from("player_stage_stats")
    .select("*")
    .eq("stage_id", stageId);
  if (statsError) return { success: false, message: friendlyDbError(statsError.message) };

  const standings = computeStandings(
    rosterPicks,
    (statsData ?? []) as PlayerStageStats[],
    managerIds,
  );

  const resultRows = standings.map((s) => ({
    stage_id: stageId,
    manager_id: s.manager_id,
    total_tds: s.total_tds,
    total_points: s.total_points,
    qb_points: s.qb_points,
    rb_points: s.rb_points,
    wr_points: s.wr_points,
    te_points: s.te_points,
    rank: s.rank,
    finalized_at: new Date().toISOString(),
  }));

  const { error: upsertError } = await supabase
    .from("weekly_results")
    .upsert(resultRows, { onConflict: "stage_id,manager_id" });
  if (upsertError) return { success: false, message: friendlyDbError(upsertError.message) };

  const { error: finalizeError } = await supabase
    .from("stages")
    .update({ status: "finalized" })
    .eq("id", stageId);
  if (finalizeError) return { success: false, message: friendlyDbError(finalizeError.message) };

  const stages = await getStages();
  const nextStage = stages
    .filter((s) => s.ordinal > stage.ordinal)
    .sort((a, b) => a.ordinal - b.ordinal)[0];

  if (!nextStage) {
    revalidatePath("/commish");
    revalidatePath("/standings");
    revalidatePath("/history");
    revalidatePath("/");
    return {
      success: true,
      message: `${stage.name} finalized. That was the last stage — season complete!`,
      data: undefined,
    };
  }

  const nextExistingOrder = await getDraftOrder(nextStage.id);
  if (nextExistingOrder.some((r) => r.manager_id)) {
    revalidatePath("/commish");
    revalidatePath("/standings");
    revalidatePath("/history");
    return {
      success: true,
      message: `${stage.name} finalized, but ${nextStage.name} already had a draft order — left as-is.`,
      data: undefined,
    };
  }

  const seed: StandingsSeed[] = standings.map((s) => ({ manager_id: s.manager_id, rank: s.rank }));
  const nextPicks = generateDraftOrder(managerIds, seed);

  const writeError = await writeDraftOrderRows(nextStage.id, nextPicks);
  if (writeError) return { success: false, message: friendlyDbError(writeError) };

  const { error: openError } = await supabase
    .from("stages")
    .update({ status: "draft_open" })
    .eq("id", nextStage.id);
  if (openError) return { success: false, message: friendlyDbError(openError.message) };

  revalidatePath("/commish");
  revalidatePath("/standings");
  revalidatePath("/history");
  revalidatePath("/draft");
  revalidatePath("/");
  return {
    success: true,
    message: `${stage.name} finalized. ${nextStage.name} draft opened, seeded by standings (last place picks first).`,
    data: undefined,
  };
}

/**
 * Overwrites a stage's draft order: re-snakes the 48 picks from a new
 * round-1 seed order (a permutation of the 8 seated managers). Refuses
 * if the stage already has picks made (roster_picks rows) to avoid
 * invalidating an in-progress draft board.
 */
export async function updateDraftOrderAction(
  stageId: number,
  roundOneOrder: string[],
): Promise<ActionResult> {
  const commish = await requireCommissioner();
  if (!commish) return { success: false, message: "Commissioner access required." };

  const stage = await getStageById(stageId);
  if (!stage) return { success: false, message: "Stage not found." };

  const managers = await getManagers();
  const managerIds = managers.map((m) => m.id);

  const isPermutation =
    roundOneOrder.length === managerIds.length &&
    new Set(roundOneOrder).size === managerIds.length &&
    roundOneOrder.every((id) => managerIds.includes(id));
  if (!isPermutation) {
    return {
      success: false,
      message: "Round-1 order must include every seated manager exactly once.",
    };
  }

  const existingPicks = await getRosterPicks(stageId);
  if (existingPicks.length > 0) {
    return {
      success: false,
      message: "Can't edit the draft order — picks have already been made this stage.",
    };
  }

  // Re-seed by manufacturing a rank list that sorts (via
  // seedRoundOneFromStandings' rank-descending sort inside
  // generateDraftOrder) back into exactly roundOneOrder: give the first
  // manager the highest rank number so it sorts first, and so on down.
  const seed: StandingsSeed[] = roundOneOrder.map((managerId, i) => ({
    manager_id: managerId,
    rank: roundOneOrder.length - i,
  }));
  const picks = generateDraftOrder(managerIds, seed);

  const writeError = await writeDraftOrderRows(stageId, picks);
  if (writeError) return { success: false, message: friendlyDbError(writeError) };

  revalidatePath("/commish");
  revalidatePath("/draft");
  return { success: true, message: `${stage.name} draft order updated.`, data: undefined };
}

/**
 * Manual roster correction (the deliberate post-lock injury-swap path).
 * Commissioner RLS permits roster_picks writes in any stage status.
 * Remove and/or add a player for one manager in one stage; to swap,
 * pass both removePlayerId and addPlayerId in the same call.
 */
export async function manualRosterEditAction(
  input: ManualRosterEditInput,
): Promise<ActionResult> {
  const commish = await requireCommissioner();
  if (!commish) return { success: false, message: "Commissioner access required." };

  if (!input.removePlayerId && !input.addPlayerId) {
    return { success: false, message: "Nothing to do — pick a player to remove and/or add." };
  }
  if (input.addPlayerId && !input.slotPosition) {
    return { success: false, message: "Choose a roster slot for the player being added." };
  }

  const supabase = await createClient();

  if (input.removePlayerId) {
    const { error } = await supabase
      .from("roster_picks")
      .delete()
      .eq("stage_id", input.stageId)
      .eq("manager_id", input.managerId)
      .eq("player_id", input.removePlayerId);
    if (error) return { success: false, message: friendlyDbError(error.message) };
  }

  if (input.addPlayerId && input.slotPosition) {
    const { error } = await supabase.from("roster_picks").insert({
      stage_id: input.stageId,
      manager_id: input.managerId,
      player_id: input.addPlayerId,
      slot_position: input.slotPosition,
      pick_number: null,
    });
    if (error) return { success: false, message: friendlyDbError(error.message) };
  }

  revalidatePath("/commish");
  revalidatePath("/my-roster");
  revalidatePath("/draft");
  return { success: true, message: "Roster updated.", data: undefined };
}

/**
 * Manager admin: toggle is_player/is_commissioner and assign/clear a
 * manager_slot (1..8, unique) on any profile. This is how the 8
 * self-signups get corrected and how commissioners are flagged.
 */
export async function updateManagerAction(update: ManagerAdminUpdate): Promise<ActionResult> {
  const commish = await requireCommissioner();
  if (!commish) return { success: false, message: "Commissioner access required." };

  if (
    update.manager_slot !== undefined &&
    update.manager_slot !== null &&
    (update.manager_slot < 1 || update.manager_slot > 8)
  ) {
    return { success: false, message: "manager_slot must be between 1 and 8." };
  }

  const patch: Record<string, unknown> = {};
  if (update.is_player !== undefined) patch.is_player = update.is_player;
  if (update.is_commissioner !== undefined) patch.is_commissioner = update.is_commissioner;
  if (update.manager_slot !== undefined) patch.manager_slot = update.manager_slot;

  if (Object.keys(patch).length === 0) {
    return { success: false, message: "Nothing to update." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("profiles").update(patch).eq("id", update.profileId);
  if (error) return { success: false, message: friendlyDbError(error.message) };

  revalidatePath("/commish");
  return { success: true, message: "Manager profile updated.", data: undefined };
}

/**
 * Best-effort manual trigger of an ESPN sync Edge Function. Fails
 * gracefully (returns an ActionResult error, never throws) if the
 * function isn't deployed yet or the request otherwise fails — this is
 * an "advanced" convenience button, not load-bearing for the app.
 */
export async function triggerSyncAction(source: SyncSourceTrigger): Promise<ActionResult> {
  const commish = await requireCommissioner();
  if (!commish) return { success: false, message: "Commissioner access required." };

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return {
      success: false,
      message: "Sync functions aren't configured (missing Supabase env vars).",
    };
  }

  const fnName = source === "players" ? "sync-players" : "sync-scores";
  const url = `${supabaseUrl.replace(/\/$/, "")}/functions/v1/${fnName}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      cache: "no-store",
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        success: false,
        message: `${fnName} responded with ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}.`,
      };
    }

    revalidatePath("/commish");
    revalidatePath("/");
    return { success: true, message: `${fnName} triggered successfully.`, data: undefined };
  } catch {
    return {
      success: false,
      message: `Couldn't reach ${fnName} — it may not be deployed yet. See supabase/functions/README.md.`,
    };
  }
}
