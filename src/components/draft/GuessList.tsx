import { PixelPanel } from "@/components/ui/PixelPanel";
import type { DraftGuess, Profile } from "@/lib/types";

interface GuessListProps {
  guesses: DraftGuess[];
  managers: Profile[];
}

/**
 * Everyone's SNF + MNF guess for a locked stage, lowest to highest, so the
 * league can watch the primetime games knowing who needs what. Only rendered
 * once guesses are unsealed (RLS hides them until kickoff anyway).
 */
export function GuessList({ guesses, managers }: GuessListProps) {
  const nameById = new Map(managers.map((m) => [m.id, m.display_name ?? "Manager"]));
  const guessByManager = new Map(guesses.map((g) => [g.manager_id, g.guess]));

  const rows = managers
    .map((m) => ({ id: m.id, name: nameById.get(m.id)!, guess: guessByManager.get(m.id) ?? null }))
    .sort((a, b) => (a.guess ?? Infinity) - (b.guess ?? Infinity));

  return (
    <PixelPanel className="flex flex-col gap-3">
      <h2 className="font-pixel text-xs text-retro-yellow">SNF + MNF Guesses</h2>
      <p className="font-mono text-base text-retro-offwhite/80">
        Closest to the combined final score picks first next week.
      </p>
      <ul className="flex flex-col gap-1 font-mono text-lg">
        {rows.map((row) => (
          <li key={row.id} className="flex justify-between gap-4">
            <span className="text-retro-offwhite">{row.name}</span>
            <span className={row.guess === null ? "text-retro-offwhite/50" : "text-retro-yellow"}>
              {row.guess ?? "no guess"}
            </span>
          </li>
        ))}
      </ul>
    </PixelPanel>
  );
}
