import { redirect } from "next/navigation";

/**
 * There's no separate signup with Google OAuth — the first authorization
 * creates the account (and, for the first 8 managers, assigns a seat via
 * the on_auth_user_created DB trigger). Keep this route as a redirect so
 * any old /signup links or bookmarks still land somewhere sensible.
 */
export default function SignupPage() {
  redirect("/login");
}
