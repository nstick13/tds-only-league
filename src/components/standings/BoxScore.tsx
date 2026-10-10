import { PixelPanel } from "@/components/ui/PixelPanel";
import type { Position } from "@/lib/roster";

export interface BoxScorePlayerRow {
  playerId: string;
  name: string;
  position: Position;
  tds: number;
  points: number;
}

export interface ManagerBoxScore {
  managerId: string;
  managerName: string;
  rank: number | null;
  totalPoints: number;
  players: BoxScorePlayerRow[];
  /** Their SNF + MNF guess for this stage, or null if none (or still sealed). */
  guess: number | null;
  /** The real combined SNF + MNF score, once both games have synced. */
  primetimeTotal: number | null;
}

const POSITION_ORDER: Record<Position, number> = { QB: 0, RB: 1, WR: 2, TE: 3 };

/**
 * One manager's roster + per-player TD/point breakdown for a stage — the
 * "box score" drill-down on the history page.
 */
export function BoxScore({ box }: { box: ManagerBoxScore }) {
  const players = [...box.players].sort(
    (a, b) => POSITION_ORDER[a.position] - POSITION_ORDER[b.position],
  );

  return (
    <PixelPanel className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-pixel text-sm text-retro-offwhite">
          {box.rank ? `#${box.rank} ` : ""}
          {box.managerName}
        </span>
        <span className="font-pixel text-sm text-retro-yellow">{box.totalPoints.toFixed(1)} pts</span>
      </div>

      {box.guess !== null ? (
        <p className="font-mono text-sm text-retro-offwhite/70">
          SNF + MNF guess: <span className="text-retro-yellow">{box.guess}</span>
          {box.primetimeTotal !== null
            ? ` · actual ${box.primetimeTotal}, ${Math.abs(box.guess - box.primetimeTotal)} off`
            : ""}
        </p>
      ) : null}

      {players.length === 0 ? (
        <p className="font-mono text-retro-offwhite/60 text-sm">No roster drafted.</p>
      ) : (
        <table className="w-full font-mono text-sm border-collapse">
          <tbody>
            {players.map((p) => (
              <tr key={p.playerId} className="border-t border-retro-offwhite/10">
                <td className="py-1 pr-2 text-retro-offwhite/60 w-12">{p.position}</td>
                <td className="py-1 pr-2 text-retro-offwhite">{p.name}</td>
                <td className="py-1 pr-2 text-right text-retro-offwhite/70 w-16">
                  {p.tds} TD{p.tds === 1 ? "" : "s"}
                </td>
                <td className="py-1 pl-2 text-right text-retro-yellow font-pixel text-xs w-16">
                  {p.points.toFixed(1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PixelPanel>
  );
}
