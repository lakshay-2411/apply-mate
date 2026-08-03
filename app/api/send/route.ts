import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  supabaseAdmin,
  getRefreshToken,
  RESUME_BUCKET,
} from "@/lib/supabase";
import {
  gmailClientFromRefreshToken,
  sendMessage,
  type Attachment,
} from "@/lib/gmail";
import { render, textToHtml } from "@/lib/template";

export const runtime = "nodejs";
// Sequential sending with delays can run long; allow up to 5 minutes.
export const maxDuration = 300;

interface Recipient {
  email: string;
  name?: string;
  company: string;
  role: string;
}

interface SendBody {
  subjectTemplate: string;
  bodyTemplate: string;
  recipients: Recipient[];
  resumePath?: string;
  resumeName?: string;
  resumeMimeType?: string;
  delayMs?: number; // base delay between sends
}

/**
 * Streamed NDJSON events, one per line:
 *   { type: "start", total }
 *   { type: "result", email, company, role, subject, status, error? }
 *   { type: "done", sent, failed }
 */
export type SendEvent =
  | { type: "start"; total: number }
  | {
      type: "result";
      email: string;
      company: string;
      role: string;
      subject: string;
      status: "sent" | "failed";
      error?: string;
    }
  | { type: "done"; sent: number; failed: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  const session = await auth();
  const userEmail = session?.user?.email;
  if (!userEmail) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = (await req.json()) as SendBody;
  const { subjectTemplate, bodyTemplate, recipients } = body;

  if (!subjectTemplate?.trim() || !bodyTemplate?.trim()) {
    return NextResponse.json(
      { error: "Subject and body templates are required" },
      { status: 400 }
    );
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return NextResponse.json(
      { error: "Add at least one recipient" },
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

  // Load the resume once if one was uploaded.
  let attachment: Attachment | undefined;
  if (body.resumePath) {
    const { data, error } = await supabaseAdmin.storage
      .from(RESUME_BUCKET)
      .download(body.resumePath);
    if (error || !data) {
      return NextResponse.json(
        { error: `Could not load resume: ${error?.message ?? "unknown"}` },
        { status: 500 }
      );
    }
    const buf = Buffer.from(await data.arrayBuffer());
    attachment = {
      filename: body.resumeName ?? "resume.pdf",
      mimeType: body.resumeMimeType ?? "application/pdf",
      contentBase64: buf.toString("base64"),
    };
  }

  const gmail = gmailClientFromRefreshToken(refreshToken);
  const delayMs = Math.max(0, body.delayMs ?? 1500);
  const encoder = new TextEncoder();

  // Stream one NDJSON event per send so the client can show live progress.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (event: SendEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));

      try {
        write({ type: "start", total: recipients.length });

        // Record the campaign for history.
        const { data: campaign } = await supabaseAdmin
          .from("campaigns")
          .insert({
            user_email: userEmail,
            subject_template: subjectTemplate,
            body_template: bodyTemplate,
            resume_path: body.resumePath ?? null,
            resume_name: body.resumeName ?? null,
          })
          .select("id")
          .single();
        const campaignId = campaign?.id ?? null;

        let sent = 0;
        let failed = 0;

        for (let i = 0; i < recipients.length; i++) {
          const r = recipients[i];
          const vars = {
            company: r.company ?? "",
            role: r.role ?? "",
            name: r.name ?? "",
            email: r.email ?? "",
          };
          const subject = render(subjectTemplate, vars);
          const html = textToHtml(render(bodyTemplate, vars));

          let status: "sent" | "failed";
          let errorMsg: string | undefined;
          let messageId: string | undefined;

          if (!EMAIL_RE.test(r.email ?? "")) {
            status = "failed";
            errorMsg = "Invalid email address";
          } else {
            const result = await sendMessage(gmail, {
              from: userEmail,
              to: r.email,
              subject,
              html,
              attachment,
            });
            status = result.ok ? "sent" : "failed";
            errorMsg = result.error;
            messageId = result.messageId;
          }

          if (status === "sent") sent++;
          else failed++;

          write({
            type: "result",
            email: r.email,
            company: r.company,
            role: r.role,
            subject,
            status,
            error: errorMsg,
          });

          if (campaignId) {
            await supabaseAdmin.from("sends").insert({
              campaign_id: campaignId,
              user_email: userEmail,
              to_email: r.email,
              company: r.company,
              role: r.role,
              subject,
              status,
              error: errorMsg ?? null,
              message_id: messageId ?? null,
              sent_at: status === "sent" ? new Date().toISOString() : null,
            });
          }

          // Randomized delay between sends (skip after the last one).
          if (i < recipients.length - 1 && delayMs > 0) {
            await sleep(delayMs + Math.floor(Math.random() * delayMs));
          }
        }

        write({ type: "done", sent, failed });
      } catch (err) {
        // Surface unexpected failures as a final failed result.
        const message =
          err instanceof Error ? err.message : "Unexpected send error";
        write({
          type: "result",
          email: "",
          company: "",
          role: "",
          subject: "",
          status: "failed",
          error: message,
        });
        write({ type: "done", sent: 0, failed: recipients.length });
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
