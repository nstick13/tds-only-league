import type { ReactNode } from "react";

interface CommishSectionProps {
  title: string;
  /** One line on when you'd reach for the tools in this section. */
  blurb: string;
  /** Shown on the right of the heading — e.g. the live stage's status. */
  note?: string;
  children: ReactNode;
}

/**
 * Groups the commish tools into labelled sections.
 *
 * The page was a flat stack of six panels in no particular order, which
 * made it a scavenger hunt: the everyday during-a-draft tools sat below
 * one-off setup ones, and nothing said which panel to reach for. Sections
 * give the page a shape — what's happening now, then the draft, then
 * fixes, then rarely-touched admin.
 */
export function CommishSection({ title, blurb, note, children }: CommishSectionProps) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b-2 border-retro-offwhite/20 pb-1">
        <h2 className="font-pixel text-xs text-retro-offwhite/90">{title}</h2>
        {note ? (
          <span className="font-mono text-xs text-retro-offwhite/55">{note}</span>
        ) : null}
      </div>
      <p className="font-mono text-sm text-retro-offwhite/55 -mt-1">{blurb}</p>
      {children}
    </section>
  );
}
