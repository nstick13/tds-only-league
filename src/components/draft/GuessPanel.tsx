"use client";

import { useState, useTransition } from "react";
import { PixelPanel } from "@/components/ui/PixelPanel";
import { PixelButton } from "@/components/ui/PixelButton";
import { saveGuess } from "@/app/(app)/draft/actions";

interface GuessPanelProps {
  stageId: number;
  initialGuess: number | null;
  /** True when the manager's next pick is their last — the guess is now required. */
  finalPickNext: boolean;
  /** Called with the new guess after it saves, so the roster card can update. */
  onSaved?: (guess: number) => void;
}

/**
 * The manager's guess at this week's combined Sunday Night + Monday Night
 * final score. Closest guess picks first in next week's draft. Required
 * before the final pick, editable until kickoff, and hidden from everyone
 * else until then.
 */
export function GuessPanel({ stageId, initialGuess, finalPickNext, onSaved }: GuessPanelProps) {
  const [saved, setSaved] = useState<number | null>(initialGuess);
  const [value, setValue] = useState(initialGuess === null ? "" : String(initialGuess));
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [isPending, startTransition] = useTransition();

  const mustGuess = saved === null && finalPickNext;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    const guess = Number(value);
    startTransition(async () => {
      const result = await saveGuess(stageId, guess);
      if (result.ok) {
        setSaved(guess);
        onSaved?.(guess);
        setMessage({ text: "Guess saved.", ok: true });
      } else {
        setMessage({ text: result.error ?? "Could not save guess.", ok: false });
      }
    });
  }

  return (
    <PixelPanel
      className={["flex flex-col gap-3", mustGuess ? "!border-retro-yellow" : ""].join(" ")}
    >
      <h2 className="font-pixel text-xs text-retro-yellow">SNF + MNF Total</h2>
      <p className="font-mono text-base text-retro-offwhite/80">
        Guess the combined final score of Sunday Night and Monday Night Football.
        Closest guess picks first next week. Hidden from everyone else until kickoff.
      </p>
      {mustGuess ? (
        <p className="font-mono text-base text-retro-yellow">
          Your next pick is your last — enter your guess first.
        </p>
      ) : null}

      <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-3">
        <input
          type="number"
          inputMode="numeric"
          required
          min={0}
          max={300}
          step={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Combined SNF and MNF score guess"
          className="w-28 bg-field border-2 border-retro-offwhite px-3 py-2 font-mono text-lg text-retro-offwhite"
        />
        <PixelButton
          type="submit"
          className="!px-3 !py-2 !text-[10px]"
          disabled={isPending || value === "" || Number(value) === saved}
        >
          {isPending ? "Saving..." : saved === null ? "Save Guess" : "Update Guess"}
        </PixelButton>
        {saved !== null && !message ? (
          <span className="font-mono text-base text-retro-offwhite/70">
            Your guess: {saved}
          </span>
        ) : null}
      </form>

      {message ? (
        <p
          className={[
            "font-mono text-base",
            message.ok ? "text-retro-green" : "text-retro-red",
          ].join(" ")}
        >
          {message.text}
        </p>
      ) : null}
    </PixelPanel>
  );
}
