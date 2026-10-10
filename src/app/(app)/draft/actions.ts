"use server";

import { revalidatePath } from "next/cache";
import { notifyOnTheClock } from "@/lib/push/notify";
import { createClient } from "@/lib/supabase/server";
import { getStageById } from "@/lib/db/stages";
import { getDraftOrder } from "@/lib/db/draftOrder";
import { getRosterPicks } from "@/lib/db/roster";
import { getMyProfile } from "@/lib/db/profiles";
import { ROSTER_SIZE } from "@/lib/roster";
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

  // League rule: your SNF + MNF guess has to be in before your final pick.
  // A commissioner drafting for someone is exempt — they may be covering for
  // a manager who isn't around to guess (that manager then picks last next
  // week; see seedRoundOneFromGuesses).
  const isFinalPick =
    picks.filter((p) => p.manager_id === pickForManagerId).length === ROSTER_SIZE - 1;
  if (isFinalPick && !commissionerOverride) {
    const { data: guess, error: guessError } = await supabase
      .from("draft_guesses")
      .select("guess")
      .eq("stage_id", stageId)
      .eq("manager_id", pickForManagerId)
      .maybeSingle();
    if (guessError) {
      return { ok: false, error: `Could not check your guess: ${guessError.message}` };
    }
    if (!guess) {
      return {
        ok: false,
        error: "Enter your SNF + MNF total guess before making your final pick.",
      };
    }
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

  // Tell whoever is up next. The pick is already committed, so a push
  // failure must not surface as a failed draft — notifyOnTheClock swallows
  // its own errors, and this is awaited only to keep it inside the request.
  const next = computeCurrentPick(draftOrder, picks.length + 1);
  if (next.managerId) {
    await notifyOnTheClock(next.managerId, stage.name, next.pickNumber!);
  }

  revalidatePath("/draft");
  revalidatePath("/");
  return { ok: true };
}

/** Highest guess accepted — well above any real SNF + MNF combined score. */
const MAX_GUESS = 300;

/**
 * Saves the signed-in manager's guess at this stage's combined Sunday Night
 * + Monday Night final score. Can be changed freely until kickoff; RLS
 * (0015_primetime_guesses.sql) enforces that window and keeps the guess
 * hidden from other managers until then.
 */
export async function saveGuess(
  stageId: number,
  guess: number,
): Promise<DraftActionResult> {
  if (!Number.isInteger(guess) || guess < 0 || guess > MAX_GUESS) {
    return { ok: false, error: `Guess must be a whole number from 0 to ${MAX_GUESS}.` };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "You must be signed in to guess." };
  }

  const stage = await getStageById(stageId);
  if (!stage) {
    return { ok: false, error: "Stage not found." };
  }
  if (stage.status !== "draft_open") {
    return { ok: false, error: "Guesses are locked for this stage." };
  }

  const { error } = await supabase.from("draft_guesses").upsert(
    {
      stage_id: stageId,
      manager_id: user.id,
      guess,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "stage_id,manager_id" },
  );
  if (error) {
    // The RLS window check is the authority on kickoff; a rejection here
    // almost always means the games have started.
    return {
      ok: false,
      error: error.message.includes("row-level security")
        ? "Guesses are locked — kickoff has passed."
        : `Could not save guess: ${error.message}`,
    };
  }

  revalidatePath("/draft");
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
  revalidatePath("/");
  return { ok: true };
}

function friendlyInsertError(message: string): string {
  if (message.includes("roster_picks_stage_player_unique")) {
    return "That player was just taken.";
  }
  if (message.includes("Roster limit exceeded")) {
    // Match on the wording, not the number — the roster total is a league
    // setting (see ROSTER_SIZE) and this string quietly stopped matching
    // when it changed from 6 to 7.
    return /already holds \d+ players/.test(message)
      ? "Roster is already full."
      : "That position slot is already full.";
  }
  return `Could not draft player: ${message}`;
}
