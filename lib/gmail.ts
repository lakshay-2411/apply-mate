import { google, gmail_v1 } from "googleapis";

export interface Attachment {
  filename: string;
  mimeType: string;
  /** Base64-encoded file contents. */
  contentBase64: string;
}

/**
 * Build an authenticated Gmail client from a stored refresh token.
 * The refresh token is exchanged for a fresh access token automatically.
 */
export function gmailClientFromRefreshToken(
  refreshToken: string
): gmail_v1.Gmail {
  const oauth2 = new google.auth.OAuth2(
    process.env.AUTH_GOOGLE_ID,
    process.env.AUTH_GOOGLE_SECRET
  );
  oauth2.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: "v1", auth: oauth2 });
}

/** RFC 2047 encode a header value so non-ASCII subjects survive. */
function encodeHeader(value: string): string {
  // Only encode when needed.
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

function buildRawMessage(opts: {
  from: string;
  to: string;
  subject: string;
  html: string;
  attachment?: Attachment;
  /** RFC 822 Message-ID of the mail being replied to (threads the reply). */
  inReplyTo?: string;
}): string {
  const { from, to, subject, html, attachment, inReplyTo } = opts;
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
  ];
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`);
  }

  let body: string;

  if (attachment) {
    const boundary = "mixed_boundary_hnsend_2026";
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    // Blank line (\r\n\r\n) separates the headers from the MIME body.
    body =
      `\r\n\r\n--${boundary}\r\n` +
      `Content-Type: text/html; charset="UTF-8"\r\n` +
      `Content-Transfer-Encoding: 7bit\r\n\r\n` +
      `${html}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${attachment.mimeType}; name="${attachment.filename}"\r\n` +
      `Content-Disposition: attachment; filename="${attachment.filename}"\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n` +
      `${attachment.contentBase64}\r\n` +
      `--${boundary}--`;
  } else {
    headers.push(`Content-Type: text/html; charset="UTF-8"`);
    // Blank line (\r\n\r\n) separates the headers from the body.
    body = `\r\n\r\n${html}`;
  }

  return headers.join("\r\n") + body;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/** Send a single message through the Gmail API. */
export async function sendMessage(
  gmail: gmail_v1.Gmail,
  opts: {
    from: string;
    to: string;
    subject: string;
    html: string;
    attachment?: Attachment;
    /** RFC 822 Message-ID of the mail being replied to. */
    inReplyTo?: string;
    /** Gmail thread to attach the message to (keeps it in the conversation). */
    threadId?: string;
  }
): Promise<SendResult> {
  try {
    const raw = Buffer.from(buildRawMessage(opts), "utf-8").toString(
      "base64url"
    );
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId: opts.threadId },
    });
    return { ok: true, messageId: res.data.id ?? undefined };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown Gmail send error";
    return { ok: false, error: message };
  }
}

export interface SentThread {
  threadId: string;
  /** Number of mails the user sent in this thread (original + follow-ups). */
  count: number;
  /** "To" header of the latest sent mail (may be `Name <email>`). */
  to: string;
  /** Subject of the first sent mail (the original, without "Re:"). */
  subject: string;
  /** Date header of the latest sent mail. */
  date: string;
  /** Snippet of the latest sent mail. */
  snippet: string;
  /** RFC 822 Message-ID of the latest sent mail — the reply target. */
  rfcMessageId: string;
  /** True when the thread contains a received mail (they replied). */
  hasReply: boolean;
}

function header(msg: gmail_v1.Schema$Message, name: string): string {
  return (
    msg.payload?.headers?.find(
      (h) => h.name?.toLowerCase() === name.toLowerCase()
    )?.value ?? ""
  );
}

/**
 * List the user's sent conversations (Gmail threads containing sent mail,
 * optionally after a date), newest first. Grouping happens at the Gmail
 * level, so a thread's count is complete regardless of pagination.
 * Requires the gmail.readonly scope.
 */
export async function listSentThreads(
  gmail: gmail_v1.Gmail,
  opts: { after?: string; pageToken?: string; maxResults?: number }
): Promise<{ threads: SentThread[]; nextPageToken?: string }> {
  // `after:` accepts YYYY/MM/DD in Gmail search syntax.
  const q = opts.after
    ? `in:sent after:${opts.after.replace(/-/g, "/")}`
    : "in:sent";

  const list = await gmail.users.threads.list({
    userId: "me",
    q,
    maxResults: opts.maxResults ?? 50,
    pageToken: opts.pageToken,
  });

  const ids = (list.data.threads ?? []).map((t) => t.id!).filter(Boolean);

  // Fetch each thread's message headers, a few threads at a time.
  const threads: SentThread[] = [];
  const CHUNK = 10;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = await Promise.all(
      ids.slice(i, i + CHUNK).map((id) =>
        gmail.users.threads.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["To", "Subject", "Date", "Message-ID"],
        })
      )
    );
    for (const res of chunk) {
      const msgs = res.data.messages ?? []; // oldest first
      const isSent = (m: gmail_v1.Schema$Message) =>
        m.labelIds?.includes("SENT") ?? false;
      const isDraft = (m: gmail_v1.Schema$Message) =>
        m.labelIds?.includes("DRAFT") ?? false;
      const sent = msgs.filter(isSent);
      if (sent.length === 0) continue; // defensive: the query implies sent mail
      const latest = sent[sent.length - 1];
      threads.push({
        threadId: res.data.id ?? "",
        count: sent.length,
        to: header(latest, "To"),
        subject: header(sent[0], "Subject"),
        date: header(latest, "Date"),
        snippet: latest.snippet ?? "",
        rfcMessageId: header(latest, "Message-ID"),
        hasReply: msgs.some((m) => !isSent(m) && !isDraft(m)),
      });
    }
  }

  return {
    threads,
    nextPageToken: list.data.nextPageToken ?? undefined,
  };
}
