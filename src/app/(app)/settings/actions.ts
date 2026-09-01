"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface ActionResult {
  success: boolean;
  message: string;
}

/**
 * Update the signed-in manager's own display_name. RLS
 * (profiles_update_own) restricts this to the caller's own row, so no
 * extra ownership check is needed beyond confirming there's a session.
 */
export async function updateDisplayNameAction(
  formData: FormData,
): Promise<ActionResult> {
  const displayName = String(formData.get("displayName") ?? "").trim();

  if (displayName.length < 2) {
    return { success: false, message: "Display name must be at least 2 characters." };
  }
  if (displayName.length > 40) {
    return { success: false, message: "Display name must be 40 characters or fewer." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, message: "You're not signed in." };
  }

  const { error } = await supabase
    .from("profiles")
    .update({ display_name: displayName })
    .eq("id", user.id);

  if (error) {
    return { success: false, message: error.message };
  }

  // Refresh the app shell (the nav shows the display name) and settings.
  revalidatePath("/", "layout");
  return { success: true, message: "Display name saved." };
}
