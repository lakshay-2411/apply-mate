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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  const session = await auth();
  const userEmail = session?.user?.email;
  const userName = session?.user?.name ?? "";
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
  const delayMs = Math.max(0, body.delayMs ?? 1500);

  const results: Array<{
    email: string;
    company: string;
    role: string;
    subject: string;
    status: "sent" | "failed";
    error?: string;
  }> = [];

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const vars = {
      company: r.company ?? "",
      role: r.role ?? "",
      name: userName,
      email: r.email ?? "",
    };
    const subject = render(subjectTemplate, vars);
    const html = textToHtml(render(bodyTemplate, vars));

    if (!EMAIL_RE.test(r.email ?? "")) {
      results.push({
        email: r.email,
        company: r.company,
        role: r.role,
        subject,
        status: "failed",
        error: "Invalid email address",
      });
      continue;
    }

    const result = await sendMessage(gmail, {
      from: userEmail,
      to: r.email,
      subject,
      html,
      attachment,
    });

    const status = result.ok ? "sent" : "failed";
    results.push({
      email: r.email,
      company: r.company,
      role: r.role,
      subject,
      status,
      error: result.error,
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
        error: result.error ?? null,
        message_id: result.messageId ?? null,
        sent_at: result.ok ? new Date().toISOString() : null,
      });
    }

    // Randomized delay between sends (skip after the last one).
    if (i < recipients.length - 1 && delayMs > 0) {
      await sleep(delayMs + Math.floor(Math.random() * delayMs));
    }
  }

  const sent = results.filter((r) => r.status === "sent").length;
  const failed = results.length - sent;

  return NextResponse.json({ sent, failed, results });
}
