import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { supabaseAdmin, getRefreshToken } from "@/lib/supabase";
import { gmailClientFromRefreshToken, sendMessage } from "@/lib/gmail";
import { textToHtml } from "@/lib/template";

export const runtime = "nodejs";
// Sequential sending with delays can run long; allow up to 5 minutes.
export const maxDuration = 300;

interface FollowUpTarget {
  /** Gmail thread the original mail belongs to. */
  threadId: string;
  /** RFC 822 Message-ID header of the original mail. */
  rfcMessageId: string;
  /** Original "To" header (may be `Name <email>`). */
  to: string;
  /** Original subject — the reply becomes `Re: <subject>`. */
  subject: string;
}

interface FollowUpBody {
  message: string;
  targets: FollowUpTarget[];
  delayMs?: number;
}

/** Streamed NDJSON events, one per line (same shape as /api/send). */
export type FollowUpEvent =
  | { type: "start"; total: number }
  | {
      type: "result";
      to: string;
      subject: string;
      status: "sent" | "failed";
      error?: string;
    }
  | { type: "done"; sent: number; failed: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pull the bare address out of a `Name <email>` header for logging. */
function bareEmail(to: string): string {
  const match = to.match(/<([^>]+)>/);
  return (match?.[1] ?? to).trim();
}

function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

/**
 * Sends one follow-up message as a reply to each selected sent mail.
 * Replies carry In-Reply-To/References headers and the original threadId,
 * so they land in the same conversation for both sides.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  const userEmail = session?.user?.email;
  if (!userEmail) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = (await req.json()) as FollowUpBody;
  const { message, targets } = body;

  if (!message?.trim()) {
    return NextResponse.json(
      { error: "Follow-up message is required" },
      { status: 400 }
    );
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    return NextResponse.json(
      { error: "Select at least one mail to follow up on" },
      { status: 400 }
    );
  }

  const refreshToken = await getRefreshToken(userEmail);
  if (!refreshToken) {
    return NextResponse.json(
      { error: "No Gmail authorization found. Please sign in again." },
      { status: 400 }
    );
  }

  const gmail = gmailClientFromRefreshToken(refreshToken);
  const html = textToHtml(message);
  const delayMs = Math.max(0, body.delayMs ?? 1500);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (event: FollowUpEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));

      try {
        write({ type: "start", total: targets.length });

        let sent = 0;
        let failed = 0;

        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          const subject = replySubject(t.subject ?? "");

          let status: "sent" | "failed";
          let errorMsg: string | undefined;
          let messageId: string | undefined;

          if (!t.to?.trim() || !t.threadId || !t.rfcMessageId) {
            status = "failed";
            errorMsg = "Missing reply metadata for this mail";
          } else {
            const result = await sendMessage(gmail, {
              from: userEmail,
              to: t.to,
              subject,
              html,
              inReplyTo: t.rfcMessageId,
              threadId: t.threadId,
            });
            status = result.ok ? "sent" : "failed";
            errorMsg = result.error;
            messageId = result.messageId;
          }

          if (status === "sent") sent++;
          else failed++;

          write({ type: "result", to: t.to ?? "", subject, status, error: errorMsg });

          // Log follow-ups alongside regular sends (no campaign).
          await supabaseAdmin.from("sends").insert({
            campaign_id: null,
            user_email: userEmail,
            to_email: bareEmail(t.to ?? ""),
            subject,
            status,
            error: errorMsg ?? null,
            message_id: messageId ?? null,
            sent_at: status === "sent" ? new Date().toISOString() : null,
          });

          // Randomized delay between sends (skip after the last one).
          if (i < targets.length - 1 && delayMs > 0) {
            await sleep(delayMs + Math.floor(Math.random() * delayMs));
          }
        }

        write({ type: "done", sent, failed });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unexpected send error";
        write({
          type: "result",
          to: "",
          subject: "",
          status: "failed",
          error: message,
        });
        write({ type: "done", sent: 0, failed: targets.length });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
