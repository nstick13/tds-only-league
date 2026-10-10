import { createClient } from "@/lib/supabase/server";
import type { DraftGuess } from "@/lib/types";

/**
 * Every SNF + MNF guess for a stage that the caller is allowed to see. RLS
 * seals other managers' guesses until kickoff, so before then a manager gets
 * back only their own row; a commissioner always gets all of them.
 */
export async function getDraftGuesses(stageId: number): Promise<DraftGuess[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("draft_guesses")
    .select("*")
    .eq("stage_id", stageId);

  if (error) throw new Error(`getDraftGuesses: ${error.message}`);
  return data as DraftGuess[];
}
