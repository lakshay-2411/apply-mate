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

export interface ScheduledRecipient {
  email: string;
  name?: string;
  company: string;
  role: string;
}

interface ScheduledCampaign {
  id: string;
  user_email: string;
  subject_template: string;
  body_template: string;
  resume_path: string | null;
  resume_name: string | null;
  resume_mime: string | null;
  recipients: ScheduledRecipient[] | null;
  delay_ms: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** How many due campaigns a single processor run will handle. */
const BATCH_LIMIT = 5;

async function sendCampaign(campaign: ScheduledCampaign): Promise<void> {
  const recipients = campaign.recipients ?? [];
  if (recipients.length === 0) throw new Error("Campaign has no recipients");

  const refreshToken = await getRefreshToken(campaign.user_email);
  if (!refreshToken) {
    throw new Error(`No Gmail authorization stored for ${campaign.user_email}`);
  }

  let attachment: Attachment | undefined;
  if (campaign.resume_path) {
    const { data, error } = await supabaseAdmin.storage
      .from(RESUME_BUCKET)
      .download(campaign.resume_path);
    if (error || !data) {
      throw new Error(`Could not load resume: ${error?.message ?? "unknown"}`);
    }
    const buf = Buffer.from(await data.arrayBuffer());
    attachment = {
      filename: campaign.resume_name ?? "resume.pdf",
      mimeType: campaign.resume_mime ?? "application/pdf",
      contentBase64: buf.toString("base64"),
    };
  }

  const gmail = gmailClientFromRefreshToken(refreshToken);
  const delayMs = Math.max(0, campaign.delay_ms ?? 1500);

  let sentCount = 0;
  let firstError: string | undefined;

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const vars = {
      company: r.company ?? "",
      role: r.role ?? "",
      name: r.name ?? "",
      email: r.email ?? "",
    };
    const subject = render(campaign.subject_template, vars);
    const html = textToHtml(render(campaign.body_template, vars));

    let status: "sent" | "failed";
    let errorMsg: string | undefined;
    let messageId: string | undefined;

    if (!EMAIL_RE.test(r.email ?? "")) {
      status = "failed";
      errorMsg = "Invalid email address";
    } else {
      const result = await sendMessage(gmail, {
        from: campaign.user_email,
        to: r.email,
        subject,
        html,
        attachment,
      });
      status = result.ok ? "sent" : "failed";
      errorMsg = result.error;
      messageId = result.messageId;
    }

    if (status === "sent") sentCount++;
    else firstError = firstError ?? errorMsg;

    await supabaseAdmin.from("sends").insert({
      campaign_id: campaign.id,
      user_email: campaign.user_email,
      to_email: r.email,
      company: r.company,
      role: r.role,
      subject,
      status,
      error: errorMsg ?? null,
      message_id: messageId ?? null,
      sent_at: status === "sent" ? new Date().toISOString() : null,
    });

    if (i < recipients.length - 1 && delayMs > 0) {
      await sleep(delayMs + Math.floor(Math.random() * delayMs));
    }
  }

  // Nothing went out — mark the whole campaign failed with the reason so
  // it's visible in the Scheduled sends list instead of a silent "sent".
  if (sentCount === 0) {
    throw new Error(
      `All ${recipients.length} send(s) failed${firstError ? `: ${firstError}` : ""}`
    );
  }
}

/**
 * Send every scheduled campaign whose time has come. Campaigns are claimed
 * atomically (scheduled -> sending), so overlapping runs — the local poller
 * and an external cron, or two cron ticks — never double-send.
 *
 * A campaign missed while the server was down is sent on the next run
 * ("as soon as possible" semantics, like Gmail's schedule send).
 */
export async function processDueCampaigns(): Promise<{
  processed: number;
  failed: number;
}> {
  const { data: due, error } = await supabaseAdmin
    .from("campaigns")
    .select("id")
    .eq("status", "scheduled")
    .lte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) throw new Error(`Could not query due campaigns: ${error.message}`);
  if (!due || due.length === 0) return { processed: 0, failed: 0 };

  let processed = 0;
  let failed = 0;

  for (const { id } of due) {
    // Atomic claim: only one runner can flip scheduled -> sending.
    const { data: claimed } = await supabaseAdmin
      .from("campaigns")
      .update({ status: "sending" })
      .eq("id", id)
      .eq("status", "scheduled")
      .select(
        "id, user_email, subject_template, body_template, resume_path, resume_name, resume_mime, recipients, delay_ms"
      )
      .maybeSingle();

    if (!claimed) continue; // another runner got it first

    try {
      await sendCampaign(claimed as ScheduledCampaign);
      await supabaseAdmin
        .from("campaigns")
        .update({ status: "sent", error: null })
        .eq("id", id);
      processed++;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown scheduling error";
      console.error(`[scheduler] campaign ${id} failed:`, message);
      await supabaseAdmin
        .from("campaigns")
        .update({ status: "failed", error: message })
        .eq("id", id);
      failed++;
    }
  }

  return { processed, failed };
}
