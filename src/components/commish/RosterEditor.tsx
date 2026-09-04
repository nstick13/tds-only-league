"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PixelPanel } from "@/components/ui/PixelPanel";
import { PixelButton } from "@/components/ui/PixelButton";
import { Badge } from "@/components/ui/Badge";
import { createClient } from "@/lib/supabase/client";
import {
  manualRosterEditAction,
  replaceRosterPickAction,
} from "@/app/(app)/commish/actions";
import { POSITIONS, type Position } from "@/lib/roster";
import type { Stage, Profile, RosterPick, Player } from "@/lib/types";

interface RosterEditorProps {
  stages: Stage[];
  managers: Profile[];
}

/** The three things a commissioner actually does to a roster. */
type Mode = "replace" | "add" | "remove";

const MODE_LABEL: Record<Mode, string> = {
  replace: "Replace",
  add: "Add",
  remove: "Remove",
};

const MODE_HELP: Record<Mode, string> = {
  replace:
    "Swap a drafted player for another. The replacement inherits the slot and pick number, so the draft record stays intact — the usual fix for a misclick or a player ruled out.",
  add: "Put a player into an empty slot. Use this when a roster is short, not to swap.",
  remove: "Take a player off a roster and leave the slot empty.",
};

/**
 * Roster corrections — add, remove, or swap a player on any manager's
 * roster, in any stage. Works after the draft locks (commissioner RLS
 * allows it), which is the point: this is the injury/misclick path.
 *
 * Replace is its own mode rather than "remove one and add another in the
 * same save" because those are not the same operation. A swap goes through
 * replace_roster_pick (0009_replace_roster_pick.sql), which is atomic and
 * carries the original slot and pick_number over to the replacement. The
 * old remove+add path did neither: a rejected insert left the manager a
 * player short, and the replacement landed with a NULL pick_number.
 */
export function RosterEditor({ stages, managers }: RosterEditorProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const sortedStages = useMemo(
    () => [...stages].sort((a, b) => a.ordinal - b.ordinal),
    [stages],
  );

  const [mode, setMode] = useState<Mode>("replace");
  const [stageId, setStageId] = useState<number | "">(sortedStages[0]?.id ?? "");
  const [managerId, setManagerId] = useState<string | "">(managers[0]?.id ?? "");
  const [roster, setRoster] = useState<RosterPick[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [pool, setPool] = useState<Player[]>([]);
  const [loading, setLoading] = useState(false);

  /** The roster row being replaced or removed. */
  const [selectedPickPlayerId, setSelectedPickPlayerId] = useState<string>("");
  /** The player coming in, for replace and add. */
  const [incomingPlayerId, setIncomingPlayerId] = useState<string>("");
  /** Slot to add into — only used in add mode; replace inherits the slot. */
  const [slotPosition, setSlotPosition] = useState<Position>("QB");

  const playerName = (id: string) => players.find((p) => p.id === id)?.name ?? id;
  const selectedPick = roster.find((p) => p.player_id === selectedPickPlayerId);

  useEffect(() => {
    // Full player index once, for looking up names on existing picks.
    const supabase = createClient();
    supabase
      .from("players")
      .select("*")
      .then(({ data, error }) => {
        if (!error && data) setPlayers(data as Player[]);
      });
  }, []);

  async function loadRosterAndPool(sid: number, mid: string) {
    setLoading(true);
    const supabase = createClient();

    const [myPicksRes, allPicksRes] = await Promise.all([
      supabase
        .from("roster_picks")
        .select("*")
        .eq("stage_id", sid)
        .eq("manager_id", mid)
        .order("pick_number", { ascending: true }),
      supabase.from("roster_picks").select("player_id").eq("stage_id", sid),
    ]);
    if (!myPicksRes.error && myPicksRes.data) setRoster(myPicksRes.data as RosterPick[]);

    const takenIds = (allPicksRes.data ?? []).map((p) => p.player_id as string);
    let poolQuery = supabase.from("players").select("*").order("name", { ascending: true });
    if (takenIds.length > 0) {
      poolQuery = poolQuery.not("id", "in", `(${takenIds.map((id) => `"${id}"`).join(",")})`);
    }
    const { data: poolData, error: poolError } = await poolQuery;
    if (!poolError && poolData) setPool(poolData as Player[]);
    setLoading(false);
  }

  useEffect(() => {
    if (stageId === "" || managerId === "") {
      setRoster([]);
      setPool([]);
      return;
    }
    let cancelled = false;
    loadRosterAndPool(stageId, managerId).then(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageId, managerId]);

  /**
   * Candidates for the incoming player. In replace mode the slot is fixed by
   * the pick being replaced (a QB slot takes a QB — the DB enforces this
   * too); in add mode the commissioner picks the slot.
   */
  const targetPosition: Position | null =
    mode === "replace"
      ? ((selectedPick?.slot_position as Position | undefined) ?? null)
      : slotPosition;
  const candidates = targetPosition ? pool.filter((p) => p.position === targetPosition) : [];

  function resetSelections() {
    setSelectedPickPlayerId("");
    setIncomingPlayerId("");
  }

  function run(fn: () => Promise<{ success: boolean; message: string }>) {
    const currentStageId = stageId;
    const currentManagerId = managerId;
    if (currentStageId === "" || currentManagerId === "") return;
    setMessage(null);
    startTransition(async () => {
      const result = await fn();
      setMessage({ text: result.message, ok: result.success });
      if (result.success) {
        resetSelections();
        router.refresh();
        // Refetch this component's own roster/pool immediately rather than
        // waiting on the parent server component to re-render.
        void loadRosterAndPool(currentStageId, currentManagerId);
      }
    });
  }

  function handleReplace() {
    if (stageId === "" || !selectedPickPlayerId || !incomingPlayerId) return;
    const sid = stageId;
    run(() =>
      replaceRosterPickAction({
        stageId: sid,
        outPlayerId: selectedPickPlayerId,
        inPlayerId: incomingPlayerId,
      }),
    );
  }

  function handleAdd() {
    if (stageId === "" || managerId === "" || !incomingPlayerId) return;
    const sid = stageId;
    const mid = managerId;
    run(() =>
      manualRosterEditAction({
        stageId: sid,
        managerId: mid,
        addPlayerId: incomingPlayerId,
        slotPosition,
      }),
    );
  }

  function handleRemove() {
    if (stageId === "" || managerId === "" || !selectedPickPlayerId) return;
    const sid = stageId;
    const mid = managerId;
    run(() =>
      manualRosterEditAction({
        stageId: sid,
        managerId: mid,
        removePlayerId: selectedPickPlayerId,
      }),
    );
  }

  const showRoster = mode === "replace" || mode === "remove";
  const showIncoming = mode === "replace" || mode === "add";

  const actionDisabled =
    isPending ||
    (mode === "replace" && (!selectedPickPlayerId || !incomingPlayerId)) ||
    (mode === "add" && !incomingPlayerId) ||
    (mode === "remove" && !selectedPickPlayerId);

  return (
    <PixelPanel raised className="flex flex-col gap-4">
      <h2 className="font-pixel text-sm text-retro-yellow">Roster Corrections</h2>

      <div className="flex flex-wrap gap-2">
        {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
          <PixelButton
            key={m}
            variant={mode === m ? "primary" : "secondary"}
            className="!px-3 !py-2 text-[10px]"
            onClick={() => {
              setMode(m);
              resetSelections();
              setMessage(null);
            }}
          >
            {MODE_LABEL[m]}
          </PixelButton>
        ))}
      </div>

      <p className="font-mono text-sm text-retro-offwhite/70">{MODE_HELP[mode]}</p>

      <div className="flex flex-wrap gap-3">
        <select
          className="font-mono text-base bg-field border-2 border-retro-offwhite text-retro-offwhite px-2 py-2"
          value={stageId}
          onChange={(e) => {
            setStageId(e.target.value ? Number(e.target.value) : "");
            resetSelections();
          }}
        >
          {sortedStages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          className="font-mono text-base bg-field border-2 border-retro-offwhite text-retro-offwhite px-2 py-2"
          value={managerId}
          onChange={(e) => {
            setManagerId(e.target.value);
            resetSelections();
          }}
        >
          {managers.map((m) => (
            <option key={m.id} value={m.id}>
              {m.display_name ?? m.email ?? m.id}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="font-mono text-sm text-retro-offwhite/60">Loading roster...</p>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          {showRoster ? (
            <div className="flex flex-col gap-2">
              <h3 className="font-pixel text-xs text-retro-offwhite">
                {mode === "replace" ? "Player to Replace" : "Player to Remove"}
              </h3>
              {roster.length === 0 ? (
                <p className="font-mono text-sm text-retro-offwhite/60">No picks yet.</p>
              ) : (
                roster.map((pick) => (
                  <label
                    key={pick.id}
                    className="flex items-center gap-2 font-mono text-base text-retro-offwhite"
                  >
                    <input
                      type="radio"
                      name="selectedPick"
                      checked={selectedPickPlayerId === pick.player_id}
                      onChange={() => {
                        setSelectedPickPlayerId(pick.player_id);
                        // The slot changes with the selection, so any
                        // replacement chosen for the previous slot is stale.
                        setIncomingPlayerId("");
                      }}
                    />
                    <Badge
                      status="Active"
                      className="!bg-field !text-retro-offwhite !border-retro-offwhite"
                    >
                      {pick.slot_position}
                    </Badge>
                    {playerName(pick.player_id)}
                    {pick.pick_number != null ? (
                      <span className="text-retro-offwhite/50 text-sm">#{pick.pick_number}</span>
                    ) : null}
                  </label>
                ))
              )}
            </div>
          ) : null}

          {showIncoming ? (
            <div className="flex flex-col gap-2">
              <h3 className="font-pixel text-xs text-retro-offwhite">
                {mode === "replace" ? "Replacement" : "Player to Add"}
              </h3>

              {mode === "add" ? (
                <div className="flex gap-2">
                  {POSITIONS.map((pos) => (
                    <PixelButton
                      key={pos}
                      variant={slotPosition === pos ? "primary" : "secondary"}
                      className="!px-2 !py-1 text-[10px]"
                      onClick={() => {
                        setSlotPosition(pos);
                        setIncomingPlayerId("");
                      }}
                    >
                      {pos}
                    </PixelButton>
                  ))}
                </div>
              ) : null}

              {mode === "replace" && !selectedPick ? (
                <p className="font-mono text-sm text-retro-offwhite/60">
                  Choose the player being replaced first — the slot decides who can come in.
                </p>
              ) : (
                <>
                  {mode === "replace" ? (
                    <p className="font-mono text-sm text-retro-offwhite/60">
                      {selectedPick?.slot_position} slot
                      {selectedPick?.pick_number != null
                        ? `, pick #${selectedPick.pick_number} — both carried over`
                        : ""}
                    </p>
                  ) : null}
                  <select
                    className="font-mono text-base bg-field border-2 border-retro-offwhite text-retro-offwhite px-2 py-2"
                    value={incomingPlayerId}
                    onChange={(e) => setIncomingPlayerId(e.target.value)}
                  >
                    <option value="">— none —</option>
                    {candidates.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.nfl_team ?? "FA"})
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
          ) : null}
        </div>
      )}

      <PixelButton
        onClick={
          mode === "replace" ? handleReplace : mode === "add" ? handleAdd : handleRemove
        }
        disabled={actionDisabled}
        variant={mode === "remove" ? "danger" : "primary"}
        className="w-fit"
      >
        {mode === "replace"
          ? "Replace Player"
          : mode === "add"
            ? "Add Player"
            : "Remove Player"}
      </PixelButton>

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
