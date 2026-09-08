import { createClient } from "@/lib/supabase/server";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import type { DraftOrderRow } from "@/lib/types";

/** Overall snake-draft pick order for a stage (8 managers x ROSTER_SIZE rounds), ordered by pick_number. */
export async function getDraftOrder(stageId: number): Promise<DraftOrderRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("draft_order")
    .select("*")
    .eq("stage_id", stageId)
    .order("pick_number", { ascending: true });

  if (error) throw new Error(`getDraftOrder: ${error.message}`);
  return data as DraftOrderRow[];
}

/** Client-component variant of getDraftOrder — re-call after a realtime draft_order event to refresh the board. */
export async function getDraftOrderClient(stageId: number): Promise<DraftOrderRow[]> {
  const supabase = createBrowserClient();
  const { data, error } = await supabase
    .from("draft_order")
    .select("*")
    .eq("stage_id", stageId)
    .order("pick_number", { ascending: true });

  if (error) throw new Error(`getDraftOrderClient: ${error.message}`);
  return data as DraftOrderRow[];
}
