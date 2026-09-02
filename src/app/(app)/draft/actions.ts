"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getStageById } from "@/lib/db/stages";
import { getDraftOrder } from "@/lib/db/draftOrder";
import { getRosterPicks } from "@/lib/db/roster";
import { getMyProfile } from "@/lib/db/profiles";
import type { Player, Position } from "@/lib/types";
import {
  computeCurrentPick,
  isPlayerDraftable,
  isSlotFull,
  reasonPlayerBlocked,
} from "@/components/draft/draftLogic";

export interface DraftActionResult {
  ok: boolean;
  error?: string;
}

export interface DraftPlayerInput {
  stageId: number;
  playerId: string;
  slotPosition: Position;
  commissionerOverride?: boolean;
}

/**
 * Drafts a player onto a manager's roster for a stage.
 *
 * Normally the pick is attributed to the signed-in user and it must be
 * their turn. When `commissionerOverride` is true the caller must be a
 * commissioner, and the pick is attributed to whoever is on the clock —
 * this lets a commissioner solo-test a draft without 8 real people.
 */
export async function draftPlayer(
  input: DraftPlayerInput,
): Promise<DraftActionResult> {
  const { stageId, playerId, slotPosition, commissionerOverride } = input;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "You must be signed in to draft." };
  }

  if (commissionerOverride) {
    const profile = await getMyProfile();
    if (!profile?.is_commissioner) {
      return { ok: false, error: "Commissioner access required for override." };
    }
  }

  const stage = await getStageById(stageId);
  if (!stage) {
    return { ok: false, error: "Stage not found." };
  }
  if (stage.status !== "draft_open") {
    return { ok: false, error: "The draft is not open for this stage." };
  }

  const [draftOrder, picks] = await Promise.all([
    getDraftOrder(stageId),
    getRosterPicks(stageId),
  ]);

  const { pickNumber, managerId: onTheClockId } = computeCurrentPick(
    draftOrder,
    picks.length,
  );

  if (pickNumber === null) {
    return { ok: false, error: "The draft is already complete for this stage." };
  }

  const pickForManagerId = commissionerOverride ? onTheClockId! : user.id;

  if (!commissionerOverride && onTheClockId !== user.id) {
    return { ok: false, error: "It is not your turn to pick." };
  }

  const { data: player, error: playerError } = await supabase
    .from("players")
    .select("*")
    .eq("id", playerId)
    .maybeSingle();

  if (playerError) {
    return { ok: false, error: `Could not load player: ${playerError.message}` };
  }
  if (!player) {
    return { ok: false, error: "Player not found." };
  }

  const typedPlayer = player as Player;

  if (typedPlayer.position !== slotPosition) {
    return { ok: false, error: "Slot position must match the player's position." };
  }

  const blockedReason = reasonPlayerBlocked(typedPlayer);
  if (!isPlayerDraftable(typedPlayer) && blockedReason) {
    return { ok: false, error: blockedReason };
  }

  if (picks.some((p) => p.player_id === playerId)) {
    return { ok: false, error: "That player was just taken." };
  }

  if (isSlotFull(picks, pickForManagerId, slotPosition)) {
    return { ok: false, error: `${slotPosition} slot is already full for that manager.` };
  }

  const { error: insertError } = await supabase.from("roster_picks").insert({
    stage_id: stageId,
    manager_id: pickForManagerId,
    player_id: playerId,
    slot_position: slotPosition,
    pick_number: pickNumber,
  });

  if (insertError) {
    return { ok: false, error: friendlyInsertError(insertError.message) };
  }

  revalidatePath("/draft");
  revalidatePath("/my-roster");
  return { ok: true };
}

/**
 * Removes the most recent pick in a stage. Non-commissioners can only
 * undo their own picks while the draft is open; commissioners can undo
 * any manager's last pick (for test-draft cleanup).
 */
export async function undoPick(
  stageId: number,
  commissionerOverride?: boolean,
): Promise<DraftActionResult> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "You must be signed in." };
  }

  if (commissionerOverride) {
    const profile = await getMyProfile();
    if (!profile?.is_commissioner) {
      return { ok: false, error: "Commissioner access required for override." };
    }
  }

  const stage = await getStageById(stageId);
  if (!stage) {
    return { ok: false, error: "Stage not found." };
  }
  if (stage.status !== "draft_open") {
    return { ok: false, error: "The draft is not open for this stage." };
  }

  let query = supabase
    .from("roster_picks")
    .select("*")
    .eq("stage_id", stageId)
    .order("pick_number", { ascending: false })
    .limit(1);

  if (!commissionerOverride) {
    query = query.eq("manager_id", user.id);
  }

  const { data: targetPicks, error: picksError } = await query;

  if (picksError) {
    return { ok: false, error: picksError.message };
  }
  if (!targetPicks || targetPicks.length === 0) {
    return { ok: false, error: "No picks to undo." };
  }

  const { error: deleteError } = await supabase
    .from("roster_picks")
    .delete()
    .eq("id", targetPicks[0].id);

  if (deleteError) {
    return { ok: false, error: deleteError.message };
  }

  revalidatePath("/draft");
  revalidatePath("/my-roster");
  return { ok: true };
}

function friendlyInsertError(message: string): string {
  if (message.includes("roster_picks_stage_player_unique")) {
    return "That player was just taken.";
  }
  if (message.includes("Roster limit exceeded")) {
    return message.includes("already holds 6 players")
      ? "Roster is already full."
      : "That position slot is already full.";
  }
  return `Could not draft player: ${message}`;
}
