import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Lightweight liveness check. Point an external pinger (e.g. cron-job.org)
 * here to keep a free-tier host from spinning down — while the server is
 * up, the background poller (instrumentation.ts) sends scheduled campaigns
 * on its own. No auth, no database work: it must stay cheap to call.
 */
export async function GET() {
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
