/**
 * Env-var access for the Supabase clients.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Every client factory used to read `process.env.NEXT_PUBLIC_SUPABASE_URL!`.
 * The `!` satisfies TypeScript and does nothing at runtime, so a missing or
 * MISNAMED variable sailed through to @supabase/ssr, which throws:
 *
 *   Your project's URL and Key are required to create a Supabase client!
 *
 * That message names neither the variable nor which of the two is missing —
 * and because these clients are built in middleware and in every server
 * component, one absent variable takes down every route at once. Diagnosing
 * it from that error alone cost a production outage.
 *
 * So: check here, and say exactly which variable is not set.
 *
 * NOTE ON INLINING — do not "simplify" these into a lookup like
 * process.env[name]. Next.js replaces NEXT_PUBLIC_* references with their
 * literal values at BUILD time, and that substitution only happens for
 * statically analyzable member expressions. A dynamic lookup silently
 * evaluates to undefined in the browser bundle.
 */

/** Thrown for a missing variable, so the first log line names the fix. */
function missing(name: string): never {
  throw new Error(
    `${name} is not set. Add it to .env.local for local dev, or to the ` +
      `project's environment variables in your host (Vercel: Settings > ` +
      `Environment Variables, ticked for every environment you deploy). ` +
      `NEXT_PUBLIC_* values are compiled in at build time, so redeploy — ` +
      `saving the value alone does not update a build that already ran. ` +
      `Check the variable's NAME as carefully as its value: a typo there ` +
      `reads exactly like a missing variable.`,
  );
}

/**
 * URL + anon key for the browser and server SSR clients. Safe to expose —
 * the anon key is protected by RLS, not by secrecy.
 */
export function publicSupabaseEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!url) missing("NEXT_PUBLIC_SUPABASE_URL");
  if (!anonKey) missing("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  return { url, anonKey };
}

/**
 * Service-role key for privileged server-only work. NEVER import into a
 * client component. The value is not returned anywhere it could be logged
 * by accident — callers pass it straight to a Supabase client.
 */
export function serviceRoleEnv(): { url: string; serviceKey: string } {
  const { url } = publicSupabaseEnv();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!serviceKey) missing("SUPABASE_SERVICE_ROLE_KEY");

  return { url, serviceKey };
}
