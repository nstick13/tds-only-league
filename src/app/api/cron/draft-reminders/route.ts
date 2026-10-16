import { NextResponse, type NextRequest } from "next/server";
import { sendDueDraftReminders } from "@/lib/push/reminders";

/**
 * Hourly "still your pick" reminders. Called every 15 minutes by pg_cron
 * (0016_draft_reminders.sql) with `Authorization: Bearer <CRON_SECRET>`.
 * Idempotent: calling it more often never sends more reminders.
 */

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not set." }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const results = await sendDueDraftReminders();
    return NextResponse.json({ ok: true, results });
  } catch (err) {
    console.error("draft reminders failed", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
