"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import type { DraftOrderRow, Player, Profile, RosterPick } from "@/lib/types";
import { subscribeToDraft } from "@/lib/realtime";
import { createClient } from "@/lib/supabase/client";
import { computeCurrentPick } from "@/components/draft/draftLogic";
import { DraftOrderStrip } from "@/components/draft/DraftOrderStrip";
import { PlayerPool } from "@/components/draft/PlayerPool";
import { TeamRosters } from "@/components/draft/TeamRosters";
import { draftPlayer, undoPick } from "@/app/(app)/draft/actions";
import { PixelButton } from "@/components/ui/PixelButton";

export interface DraftBoardProps {
  stageId: number;
  initialDraftOrder: DraftOrderRow[];
  initialPicks: RosterPick[];
  managers: Profile[];
  allPlayers: Player[];
  currentUserId: string | null;
  isCommissioner?: boolean;
}

export function DraftBoard({
  stageId,
  initialDraftOrder,
  initialPicks,
  managers,
  allPlayers,
  currentUserId,
  isCommissioner = false,
}: DraftBoardProps) {
  const [draftOrder, setDraftOrder] = useState(initialDraftOrder);
  const [picks, setPicks] = useState(initialPicks);
  const [error, setError] = useState<string | null>(null);
  const [draftingPlayerId, setDraftingPlayerId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const refreshPicks = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("roster_picks")
        .select("*")
        .eq("stage_id", stageId)
        .order("pick_number", { ascending: true });
      if (error) throw error;
      setPicks((data ?? []) as RosterPick[]);
    } catch {
      // Best-effort
    }
  }, [stageId]);

  const refreshDraftOrder = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("draft_order")
        .select("*")
        .eq("stage_id", stageId)
        .order("pick_number", { ascending: true });
      if (error) throw error;
      setDraftOrder((data ?? []) as DraftOrderRow[]);
    } catch {
      // Best-effort
    }
  }, [stageId]);

  useEffect(() => {
    const unsubscribe = subscribeToDraft(stageId, {
      onRosterPickChange: () => {
        refreshPicks();
      },
      onDraftOrderChange: () => {
        refreshDraftOrder();
      },
    });
    return unsubscribe;
  }, [stageId, refreshPicks, refreshDraftOrder]);

  const playersById = useMemo(() => {
    const map = new Map<string, Player>();
    for (const p of allPlayers) map.set(p.id, p);
    return map;
  }, [allPlayers]);

  const takenIds = useMemo(() => new Set(picks.map((p) => p.player_id)), [picks]);
  const pool = useMemo(
    () => allPlayers.filter((p) => !takenIds.has(p.id)),
    [allPlayers, takenIds],
  );

  const { pickNumber: currentPickNumber, managerId: onTheClockId } = useMemo(
    () => computeCurrentPick(draftOrder, picks.length),
    [draftOrder, picks.length],
  );

  // In commissioner override mode, the commissioner can always pick
  // (for whoever is on the clock). Otherwise, only when it's their turn.
  const useOverride = isCommissioner && onTheClockId !== currentUserId;
  const isMyTurn = currentUserId !== null && (onTheClockId === currentUserId || useOverride);

  // For slot-full checks: use the on-the-clock manager's picks when
  // commissioner is overriding, otherwise the current user's own picks.
  const activeManagerId = useOverride ? onTheClockId : currentUserId;

  const activePicks = useMemo(
    () => picks.filter((p) => p.manager_id === activeManagerId),
    [picks, activeManagerId],
  );

  const handleDraft = useCallback(
    (player: Player) => {
      setError(null);
      setDraftingPlayerId(player.id);
      startTransition(async () => {
        const result = await draftPlayer({
          stageId,
          playerId: player.id,
          slotPosition: player.position,
          commissionerOverride: useOverride,
        });
        setDraftingPlayerId(null);
        if (!result.ok) {
          setError(result.error ?? "Could not draft that player.");
        } else {
          refreshPicks();
        }
      });
    },
    [stageId, refreshPicks, useOverride],
  );

  const handleUndo = useCallback(() => {
    setError(null);
    startTransition(async () => {
      const result = await undoPick(stageId, useOverride || isCommissioner);
      if (!result.ok) {
        setError(result.error ?? "Could not undo pick.");
      } else {
        refreshPicks();
      }
    });
  }, [stageId, refreshPicks, useOverride, isCommissioner]);

  return (
    <div className="flex flex-col gap-4">
      {isCommissioner && useOverride ? (
        <div className="border-2 border-retro-yellow bg-field-light px-3 py-2 font-mono text-base text-retro-yellow text-center">
          Commissioner mode — picking for {managers.find((m) => m.id === onTheClockId)?.display_name ?? "manager"}
        </div>
      ) : null}

      <DraftOrderStrip
        draftOrder={draftOrder}
        managers={managers}
        currentPickNumber={currentPickNumber}
        currentUserId={currentUserId}
      />

      {error ? (
        <div className="border-2 border-retro-red bg-field-light px-3 py-2 font-mono text-lg text-retro-red">
          {error}
        </div>
      ) : null}

      {picks.length > 0 && isCommissioner ? (
        <div className="flex justify-end">
          <PixelButton
            variant="secondary"
            className="!px-3 !py-2 !text-[10px]"
            onClick={handleUndo}
            disabled={isPending}
          >
            Undo Last Pick
          </PixelButton>
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <PlayerPool
          players={pool}
          isMyTurn={isMyTurn && !isPending}
          myPicks={activePicks}
          myManagerId={activeManagerId}
          onDraft={handleDraft}
          draftingPlayerId={draftingPlayerId}
        />
        <TeamRosters
          managers={managers}
          picks={picks}
          playersById={playersById}
          currentUserId={currentUserId}
        />
      </div>
    </div>
  );
}
