import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { supabaseAdmin, getRefreshToken } from "@/lib/supabase";
import type { ScheduledRecipient } from "@/lib/scheduler";

export const runtime = "nodejs";

interface ScheduleBody {
  subjectTemplate: string;
  bodyTemplate: string;
  recipients: ScheduledRecipient[];
  resumePath?: string;
  resumeName?: string;
  resumeMimeType?: string;
  delayMs?: number;
  /** ISO timestamp for when the campaign should be sent. */
  scheduledAt: string;
}

/** Minimum lead time — anything sooner should just be sent now. */
const MIN_LEAD_MS = 60 * 1000;

/** Schedule a campaign to be sent later by the cron processor. */
export async function POST(req: NextRequest) {
  const session = await auth();
  const userEmail = session?.user?.email;
  if (!userEmail) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = (await req.json()) as ScheduleBody;
  const { subjectTemplate, bodyTemplate, recipients, scheduledAt } = body;

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
  const when = new Date(scheduledAt ?? "");
  if (isNaN(when.getTime())) {
    return NextResponse.json(
      { error: "Invalid scheduled time" },
      { status: 400 }
    );
  }
  if (when.getTime() - Date.now() < MIN_LEAD_MS) {
    return NextResponse.json(
      { error: "Scheduled time must be at least a minute in the future" },
      { status: 400 }
    );
  }

  // Fail early if sending would be impossible later.
  const refreshToken = await getRefreshToken(userEmail);
  if (!refreshToken) {
    return NextResponse.json(
      { error: "No Gmail authorization found. Please sign in again." },
      { status: 400 }
    );
  }

  const { data, error } = await supabaseAdmin
    .from("campaigns")
    .insert({
      user_email: userEmail,
      subject_template: subjectTemplate,
      body_template: bodyTemplate,
      resume_path: body.resumePath ?? null,
      resume_name: body.resumeName ?? null,
      resume_mime: body.resumeMimeType ?? null,
      recipients,
      delay_ms: Math.max(0, body.delayMs ?? 1500),
      status: "scheduled",
      scheduled_at: when.toISOString(),
    })
    .select("id")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Could not save the schedule" },
      { status: 500 }
    );
  }

  return NextResponse.json({ id: data.id, scheduledAt: when.toISOString() });
}

/** List the user's pending (and recently failed) scheduled campaigns. */
export async function GET() {
  const session = await auth();
  const userEmail = session?.user?.email;
  if (!userEmail) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin
    .from("campaigns")
    .select("id, subject_template, scheduled_at, status, error, recipients")
    .eq("user_email", userEmail)
    .in("status", ["scheduled", "sending", "failed"])
    .order("scheduled_at", { ascending: true })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const campaigns = (data ?? []).map((c) => ({
    id: c.id as string,
    subjectTemplate: c.subject_template as string,
    scheduledAt: c.scheduled_at as string,
    status: c.status as string,
    error: (c.error as string | null) ?? null,
    recipientCount: Array.isArray(c.recipients) ? c.recipients.length : 0,
  }));

  return NextResponse.json({ campaigns });
}
