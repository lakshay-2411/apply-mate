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
}): string {
  const { from, to, subject, html, attachment } = opts;
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
  ];

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
  }
): Promise<SendResult> {
  try {
    const raw = Buffer.from(buildRawMessage(opts), "utf-8").toString(
      "base64url"
    );
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });
    return { ok: true, messageId: res.data.id ?? undefined };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown Gmail send error";
    return { ok: false, error: message };
  }
}
