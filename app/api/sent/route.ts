import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getRefreshToken } from "@/lib/supabase";
import { gmailClientFromRefreshToken, listSentThreads } from "@/lib/gmail";

export const runtime = "nodejs";

/** Default window start: only show mail sent on/after this date. */
const DEFAULT_AFTER = "2026-07-01";

/**
 * Lists the user's sent Gmail conversations (all of them, not just ones
 * sent through this app), one entry per thread. Query params:
 *   - after:     YYYY-MM-DD (defaults to 2026-07-01)
 *   - pageToken: Gmail page token for loading more
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  const userEmail = session?.user?.email;
  if (!userEmail) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const refreshToken = await getRefreshToken(userEmail);
  if (!refreshToken) {
    return NextResponse.json(
      { error: "No Gmail authorization found. Please sign in again." },
      { status: 400 }
    );
  }

  const after = req.nextUrl.searchParams.get("after") || DEFAULT_AFTER;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(after)) {
    return NextResponse.json(
      { error: "Invalid 'after' date — expected YYYY-MM-DD" },
      { status: 400 }
    );
  }
  const pageToken = req.nextUrl.searchParams.get("pageToken") ?? undefined;

  const gmail = gmailClientFromRefreshToken(refreshToken);
  try {
    const { threads, nextPageToken } = await listSentThreads(gmail, {
      after,
      pageToken,
      maxResults: 50,
    });
    return NextResponse.json({ threads, nextPageToken: nextPageToken ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Gmail request failed";
    // The stored refresh token may predate the gmail.readonly scope.
    if (/insufficient|scope|forbidden|403/i.test(message)) {
      return NextResponse.json(
        {
          error:
            "Gmail read permission is missing. Sign out and sign in again to grant it.",
          needsReauth: true,
        },
        { status: 403 }
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
