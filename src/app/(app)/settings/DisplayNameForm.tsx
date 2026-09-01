"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PixelPanel } from "@/components/ui/PixelPanel";
import { PixelButton } from "@/components/ui/PixelButton";
import { updateDisplayNameAction } from "./actions";

interface DisplayNameFormProps {
  initialName: string;
  /** true right after a first-time sign-in, to show a welcome heading. */
  welcome: boolean;
}

/**
 * Lets a manager set the name shown around the league (standings, rosters,
 * draft board). Defaults to whatever came from Google on first sign-in;
 * they can change it here any time.
 */
export function DisplayNameForm({ initialName, welcome }: DisplayNameFormProps) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(
    null,
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);

    const formData = new FormData();
    formData.set("displayName", name);

    startTransition(async () => {
      const result = await updateDisplayNameAction(formData);
      setMessage({ text: result.message, ok: result.success });
      if (result.success) router.refresh();
    });
  }

  return (
    <PixelPanel raised className="flex flex-col gap-4">
      <h1 className="font-pixel text-lg text-retro-yellow">
        {welcome ? "Welcome! Pick Your Name" : "Display Name"}
      </h1>

      {welcome ? (
        <p className="font-mono text-lg text-retro-offwhite">
          You&apos;re in. This is the name the rest of the league sees on the
          draft board and standings — change it or keep it.
        </p>
      ) : null}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 font-mono text-lg">
          Display Name
          <input
            type="text"
            required
            minLength={2}
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="bg-field border-2 border-retro-offwhite px-3 py-2 font-mono text-lg text-retro-offwhite"
            autoComplete="nickname"
          />
        </label>

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

        <PixelButton type="submit" disabled={isPending}>
          {isPending ? "Saving..." : welcome ? "Save & Continue" : "Save"}
        </PixelButton>
      </form>
    </PixelPanel>
  );
}
