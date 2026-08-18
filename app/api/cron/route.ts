import { NextRequest, NextResponse } from "next/server";
import { processDueCampaigns } from "@/lib/scheduler";

export const runtime = "nodejs";
// Sending several campaigns sequentially can run long.
export const maxDuration = 300;

/**
 * Cron entry point: sends every scheduled campaign whose time has come.
 * Protected by CRON_SECRET — callers must send
 * `Authorization: Bearer <CRON_SECRET>` (Vercel Cron does this automatically
 * when the CRON_SECRET env var is set; other schedulers can set the header).
 */
async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured" },
      { status: 500 }
    );
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await processDueCampaigns();
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Cron run failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export { handle as GET, handle as POST };
