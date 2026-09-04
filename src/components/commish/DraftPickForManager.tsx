"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PixelPanel } from "@/components/ui/PixelPanel";
import { PixelButton } from "@/components/ui/PixelButton";
import { Badge } from "@/components/ui/Badge";
import { createClient } from "@/lib/supabase/client";
import { subscribeToDraft } from "@/lib/realtime";
import { draftPlayer, undoPick } from "@/app/(app)/draft/actions";
import { computeCurrentPick } from "@/components/draft/draftLogic";
import { POSITIONS, ROSTER_SHAPE, type Position } from "@/lib/roster";
import type { Stage, Profile, DraftOrderRow, RosterPick, Player } from "@/lib/types";

interface DraftPickForManagerProps {
  currentStage: Stage;
  managers: Profile[];
}

export function DraftPickForManager({ currentStage, managers }: DraftPickForManagerProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const [draftOrder, setDraftOrder] = useState<DraftOrderRow[]>([]);
  const [picks, setPicks] = useState<RosterPick[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);

  const [positionFilter, setPositionFilter] = useState<Position | "ALL">("ALL");
  const [search, setSearch] = useState("");
  const [selectedPlayerId, setSelectedPlayerId] = useState("");

  const loadDraftState = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const [orderRes, picksRes, playersRes] = await Promise.all([
      supabase
        .from("draft_order")
        .select("*")
        .eq("stage_id", currentStage.id)
        .order("pick_number", { ascending: true }),
      supabase
        .from("roster_picks")
        .select("*")
        .eq("stage_id", currentStage.id)
        .order("pick_number", { ascending: true }),
      supabase.from("players").select("*").order("name", { ascending: true }),
    ]);
    if (!orderRes.error && orderRes.data) setDraftOrder(orderRes.data as DraftOrderRow[]);
    if (!picksRes.error && picksRes.data) setPicks(picksRes.data as RosterPick[]);
    if (!playersRes.error && playersRes.data) setPlayers(playersRes.data as Player[]);
    setLoading(false);
  }, [currentStage.id]);

  useEffect(() => {
    loadDraftState();
  }, [loadDraftState]);

  // Live updates: this panel is open on the commissioner's screen for the
  // length of a draft, so a pick made anywhere else — a manager in the draft
  // room, another commissioner here — has to land without a reload, or the
  // commissioner picks against a stale board and picks for the wrong person.
  useEffect(() => {
    const unsubscribe = subscribeToDraft(currentStage.id, {
      onRosterPickChange: () => {
        loadDraftState();
      },
      onDraftOrderChange: () => {
        loadDraftState();
      },
    });
    return unsubscribe;
  }, [currentStage.id, loadDraftState]);

  const { pickNumber, managerId: onTheClockId } = useMemo(
    () => computeCurrentPick(draftOrder, picks.length),
    [draftOrder, picks.length],
  );

  const onTheClockManager = managers.find((m) => m.id === onTheClockId);

  const takenIds = useMemo(() => new Set(picks.map((p) => p.player_id)), [picks]);
  const pool = useMemo(
    () => players.filter((p) => !takenIds.has(p.id)),
    [players, takenIds],
  );

  const onTheClockPicks = useMemo(
    () => picks.filter((p) => p.manager_id === onTheClockId),
    [picks, onTheClockId],
  );

  const filtered = useMemo(() => {
    return pool.filter((p) => {
      if (positionFilter !== "ALL" && p.position !== positionFilter) return false;
      if (search.trim() && !p.name.toLowerCase().includes(search.trim().toLowerCase()))
        return false;
      if (p.on_bye) return false;
      const s = p.status.toUpperCase();
      if (s === "OUT" || s === "IR" || s === "PUP") return false;
      return true;
    });
  }, [pool, positionFilter, search]);

  const selectedPlayer = players.find((p) => p.id === selectedPlayerId);

  const slotFull =
    selectedPlayer && onTheClockId
      ? (onTheClockPicks.filter((p) => p.slot_position === selectedPlayer.position).length >=
          ROSTER_SHAPE[selectedPlayer.position])
      : false;

  function handlePick() {
    if (!selectedPlayer || pickNumber === null) return;
    setMessage(null);
    startTransition(async () => {
      const result = await draftPlayer({
        stageId: currentStage.id,
        playerId: selectedPlayer.id,
        slotPosition: selectedPlayer.position,
        commissionerOverride: true,
      });
      if (result.ok) {
        setMessage({ text: `Drafted ${selectedPlayer.name} for ${onTheClockManager?.display_name ?? "manager"}.`, ok: true });
        setSelectedPlayerId("");
        router.refresh();
        loadDraftState();
      } else {
        setMessage({ text: result.error ?? "Could not draft player.", ok: false });
      }
    });
  }

  function handleUndo() {
    setMessage(null);
    startTransition(async () => {
      const result = await undoPick(currentStage.id, true);
      if (result.ok) {
        setMessage({ text: "Last pick undone.", ok: true });
        router.refresh();
        loadDraftState();
      } else {
        setMessage({ text: result.error ?? "Could not undo pick.", ok: false });
      }
    });
  }

  if (loading) {
    return (
      <PixelPanel raised className="flex flex-col gap-3">
        <h2 className="font-pixel text-sm text-retro-yellow">Draft Pick for Manager</h2>
        <p className="font-mono text-sm text-retro-offwhite/60">Loading draft state...</p>
      </PixelPanel>
    );
  }

  if (pickNumber === null) {
    return (
      <PixelPanel raised className="flex flex-col gap-3">
        <h2 className="font-pixel text-sm text-retro-yellow">Draft Pick for Manager</h2>
        <p className="font-mono text-sm text-retro-offwhite/70">
          Draft is complete for {currentStage.name} — all picks made.
        </p>
      </PixelPanel>
    );
  }

  return (
    <PixelPanel raised className="flex flex-col gap-4">
      <h2 className="font-pixel text-sm text-retro-yellow">Draft Pick for Manager</h2>
      <p className="font-mono text-sm text-retro-offwhite/70">
        Make a draft pick on behalf of a manager. This counts as their real pick and
        advances the draft order.
      </p>

      <div className="flex flex-wrap items-center gap-3 font-mono text-base text-retro-offwhite">
        <span>Pick #{pickNumber}:</span>
        <Badge status="Active" className="!bg-retro-yellow !text-field !border-black">
          {onTheClockManager?.display_name ?? "Unknown"}
        </Badge>
        <span className="text-retro-offwhite/60">
          ({onTheClockPicks.length}/6 slots filled)
        </span>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setSelectedPlayerId(""); }}
          placeholder="Search players..."
          className="font-mono text-base flex-1 bg-field border-2 border-retro-offwhite px-3 py-1 text-retro-offwhite placeholder:text-retro-offwhite/40 focus:outline-none focus:border-retro-yellow"
        />
        <div className="flex gap-1 flex-wrap">
          {(["ALL", ...POSITIONS] as const).map((pos) => (
            <button
              key={pos}
              onClick={() => { setPositionFilter(pos); setSelectedPlayerId(""); }}
              className={[
                "font-pixel text-[10px] uppercase px-2 py-2 border-2",
                positionFilter === pos
                  ? "bg-retro-yellow text-field border-black"
                  : "bg-field text-retro-offwhite border-retro-offwhite hover:border-retro-yellow",
              ].join(" ")}
            >
              {pos}
            </button>
          ))}
        </div>
      </div>

      <select
        className="font-mono text-base bg-field border-2 border-retro-offwhite text-retro-offwhite px-2 py-2"
        value={selectedPlayerId}
        onChange={(e) => setSelectedPlayerId(e.target.value)}
      >
        <option value="">— select a player —</option>
        {filtered.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} — {p.position} — {p.nfl_team ?? "FA"}
            {p.status !== "Active" ? ` (${p.status})` : ""}
          </option>
        ))}
      </select>

      {slotFull && selectedPlayer ? (
        <p className="font-mono text-sm text-retro-red">
          {selectedPlayer.position} slot is already full for {onTheClockManager?.display_name ?? "this manager"}.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <PixelButton
          onClick={handlePick}
          disabled={isPending || !selectedPlayerId || slotFull}
        >
          {selectedPlayer
            ? `Draft ${selectedPlayer.name}`
            : "Draft Player"}
        </PixelButton>
        {picks.length > 0 ? (
          <PixelButton
            variant="secondary"
            onClick={handleUndo}
            disabled={isPending}
          >
            Undo Last Pick
          </PixelButton>
        ) : null}
      </div>

      {message ? (
        <p
          className={["font-mono text-sm", message.ok ? "text-retro-green" : "text-retro-red"].join(
            " ",
          )}
        >
          {message.text}
        </p>
      ) : null}
    </PixelPanel>
  );
}
