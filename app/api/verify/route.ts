import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { verifyEmails, MAX_EMAILS_PER_REQUEST } from "@/lib/verifier";

export const runtime = "nodejs";
// DNS lookups — and optional SMTP probes — for a large batch take a while.
export const maxDuration = 300;

/**
 * Verify a batch of email addresses (syntax + domain/MX + heuristics).
 * Body: { emails: string[], deep?: boolean } — up to 500 per request.
 * `deep` adds a mailbox-level SMTP probe (only works where port 25 is open).
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = (await req.json()) as { emails?: unknown; deep?: unknown };
  const emails = Array.isArray(body.emails)
    ? body.emails.filter((e): e is string => typeof e === "string")
    : [];
  const deep = body.deep === true;

  if (emails.length === 0) {
    return NextResponse.json(
      { error: "Provide at least one email to verify" },
      { status: 400 }
    );
  }
  if (emails.length > MAX_EMAILS_PER_REQUEST) {
    return NextResponse.json(
      { error: `Too many emails — max ${MAX_EMAILS_PER_REQUEST} per run` },
      { status: 400 }
    );
  }

  const results = await verifyEmails(emails, deep);
  return NextResponse.json({ results });
}
