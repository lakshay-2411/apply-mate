import { promises as dns } from "node:dns";
import { smtpProbeDomain } from "@/lib/smtp";

/**
 * Email verification without mailbox probing (no SMTP, no third-party API):
 *   1. Syntax validation
 *   2. Domain existence + MX lookup (with an in-memory, per-domain cache)
 *   3. Disposable-domain detection and common-typo suggestions
 *
 * "valid" here means "a mail server accepts mail for this domain" — whether
 * the exact inbox exists can't be known without a mailbox-level check.
 */

export type VerifyStatus = "valid" | "risky" | "invalid";

/** Mailbox-level outcome, only set when a deep (SMTP) check runs. */
export type MailboxState =
  | "exists"
  | "not_found"
  | "catch_all"
  | "unknown";

export interface VerifyResult {
  email: string;
  status: VerifyStatus;
  reason: string;
  /** Corrected address when the domain looks like a typo. */
  suggestion?: string;
  /** Primary MX host, when found. */
  mx?: string;
  /** Present only when a deep check ran for this address. */
  mailbox?: MailboxState;
}

const SYNTAX_RE =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

/** Widely used mail providers — targets for typo suggestions. */
const POPULAR_DOMAINS = [
  "gmail.com",
  "yahoo.com",
  "yahoo.co.in",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "zoho.com",
  "rediffmail.com",
  "yandex.com",
  "gmx.com",
  "mail.com",
  "msn.com",
];

/** Common disposable / temporary mail domains. */
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "10minutemail.com",
  "10minutemail.net",
  "temp-mail.org",
  "tempmail.com",
  "tempmail.dev",
  "throwawaymail.com",
  "yopmail.com",
  "yopmail.net",
  "getnada.com",
  "nada.email",
  "maildrop.cc",
  "dispostable.com",
  "trashmail.com",
  "trashmail.de",
  "fakeinbox.com",
  "mytemp.email",
  "mohmal.com",
  "sharklasers.com",
  "spamgourmet.com",
  "mailnesia.com",
  "mintemail.com",
  "tempinbox.com",
  "emailondeck.com",
  "burnermail.io",
  "mail-temp.com",
  "moakt.com",
  "tmpmail.org",
  "tmpmail.net",
  "disposablemail.com",
  "instantemailaddress.com",
  "mailcatch.com",
  "spambog.com",
  "mailexpire.com",
  "33mail.com",
  "anonaddy.me",
  "temporarymail.com",
  "crazymailing.com",
]);

/** Role inboxes — deliverable, but usually not a person. */
const ROLE_LOCALS = new Set([
  "info",
  "admin",
  "contact",
  "support",
  "sales",
  "office",
  "mail",
  "team",
  "hello",
  "noreply",
  "no-reply",
  "donotreply",
  "webmaster",
  "postmaster",
]);

/**
 * Damerau-Levenshtein (optimal string alignment): like Levenshtein but an
 * adjacent transposition ("gmial" -> "gmail") counts as one edit, since
 * that's the most common real-world typo.
 */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3; // cheap early exit
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array<number>(b.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= b.length; j++) d[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** Suggest a popular domain when the given one is a near-miss typo. */
function suggestDomain(domain: string): string | undefined {
  if (POPULAR_DOMAINS.includes(domain)) return undefined;
  for (const candidate of POPULAR_DOMAINS) {
    if (editDistance(domain, candidate) === 1) return candidate;
  }
  return undefined;
}

// ---- Domain lookups, cached in-process ----

interface DomainInfo {
  exists: boolean;
  mx: string | null;
  timedOut: boolean;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const LOOKUP_TIMEOUT_MS = 5_000;
const domainCache = new Map<string, { info: DomainInfo; at: number }>();

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), LOOKUP_TIMEOUT_MS)
    ),
  ]);
}

async function lookupDomain(domain: string): Promise<DomainInfo> {
  const cached = domainCache.get(domain);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.info;

  let info: DomainInfo;
  try {
    const records = await withTimeout(dns.resolveMx(domain));
    const best = records
      .filter((r) => r.exchange)
      .sort((a, b) => a.priority - b.priority)[0];
    info = best
      ? { exists: true, mx: best.exchange, timedOut: false }
      : { exists: true, mx: null, timedOut: false };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    const timedOut = err instanceof Error && err.message === "timeout";
    if (timedOut) {
      info = { exists: false, mx: null, timedOut: true };
    } else if (code === "ENOTFOUND") {
      info = { exists: false, mx: null, timedOut: false };
    } else {
      // ENODATA & friends: the domain exists but has no MX records.
      // RFC 5321 falls back to an A/AAAA record for delivery.
      let hasAddress = false;
      try {
        const a = await withTimeout(dns.resolve4(domain));
        hasAddress = a.length > 0;
      } catch {
        try {
          const aaaa = await withTimeout(dns.resolve6(domain));
          hasAddress = aaaa.length > 0;
        } catch {
          /* no address records either */
        }
      }
      info = { exists: hasAddress, mx: null, timedOut: false };
    }
  }

  domainCache.set(domain, { info, at: Date.now() });
  return info;
}

// ---- Verification ----

async function verifyOne(raw: string): Promise<VerifyResult> {
  const email = raw.trim();

  const at = email.lastIndexOf("@");
  const local = at > 0 ? email.slice(0, at) : "";
  const domain = at > 0 ? email.slice(at + 1).toLowerCase() : "";
  const normalized = local ? `${local}@${domain}` : email;

  if (
    !SYNTAX_RE.test(email) ||
    local.length > 64 ||
    domain.length > 253
  ) {
    return { email, status: "invalid", reason: "Invalid email format" };
  }

  const suggestedDomain = suggestDomain(domain);
  const suggestion = suggestedDomain ? `${local}@${suggestedDomain}` : undefined;

  if (DISPOSABLE_DOMAINS.has(domain)) {
    return {
      email: normalized,
      status: "risky",
      reason: "Disposable / temporary email domain",
      suggestion,
    };
  }

  const info = await lookupDomain(domain);

  if (info.timedOut) {
    return {
      email: normalized,
      status: "risky",
      reason: "Could not check the domain (DNS timeout) — try again",
      suggestion,
    };
  }
  if (!info.exists) {
    return {
      email: normalized,
      status: "invalid",
      reason: suggestion
        ? "Domain does not exist — looks like a typo"
        : "Domain does not exist",
      suggestion,
    };
  }
  if (!info.mx) {
    return {
      email: normalized,
      status: "risky",
      reason:
        "Domain exists but has no MX records — mail may not be accepted",
      suggestion,
    };
  }
  if (suggestion) {
    return {
      email: normalized,
      status: "risky",
      reason: "Deliverable domain, but it looks like a typo",
      suggestion,
      mx: info.mx,
    };
  }

  const isRole = ROLE_LOCALS.has(local.toLowerCase());
  return {
    email: normalized,
    status: "valid",
    reason: isRole
      ? "Mail server found — note: this is a role address, not a person"
      : "Mail server found for the domain",
    mx: info.mx,
  };
}

export const MAX_EMAILS_PER_REQUEST = 500;

// HELO name and MAIL FROM used for the SMTP probe. Some servers are picky;
// override via env if a domain refuses the defaults.
const HELO_HOST = process.env.EMAIL_VERIFIER_HELO || "mail.applymate.app";
const PROBE_FROM =
  process.env.EMAIL_VERIFIER_FROM || `verify@${HELO_HOST}`;

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1).toLowerCase() : "";
}

/**
 * Run a mailbox-level (SMTP) check over already-classified results, mutating
 * them in place. Only addresses with a live MX are probed; disposable and
 * invalid ones are left as-is. Recipients are grouped by domain so each mail
 * server is contacted once, and domains are probed sequentially to avoid
 * tripping rate limits.
 */
async function deepCheck(results: VerifyResult[]): Promise<void> {
  const byDomain = new Map<string, { mx: string; items: VerifyResult[] }>();
  for (const r of results) {
    if (!r.mx || r.status === "invalid") continue;
    if (/disposable/i.test(r.reason)) continue; // already risky, don't probe
    const domain = domainOf(r.email);
    if (!domain) continue;
    const group = byDomain.get(domain);
    if (group) group.items.push(r);
    else byDomain.set(domain, { mx: r.mx, items: [r] });
  }

  for (const [domain, { mx, items }] of byDomain) {
    let probe;
    try {
      probe = await smtpProbeDomain({
        mxHost: mx,
        domain,
        recipients: items.map((r) => r.email.toLowerCase()),
        heloHost: HELO_HOST,
        fromAddress: PROBE_FROM,
      });
    } catch {
      probe = null;
    }

    for (const r of items) {
      if (!probe || !probe.reachable) {
        r.mailbox = "unknown";
        r.status = "risky";
        r.reason =
          "Couldn't reach the mail server to confirm the mailbox " +
          "(port 25 may be blocked here)";
        continue;
      }
      if (probe.catchAll) {
        r.mailbox = "catch_all";
        r.status = "risky";
        r.reason =
          "Catch-all domain — it accepts every address, so this inbox " +
          "can't be confirmed";
        continue;
      }
      const code = probe.codes.get(r.email.toLowerCase());
      if (code !== undefined && code >= 200 && code < 300) {
        r.mailbox = "exists";
        r.status = "valid";
        r.reason = "Mailbox exists and accepts mail";
      } else if (code !== undefined && code >= 500) {
        r.mailbox = "not_found";
        r.status = "invalid";
        r.reason = "Mailbox does not exist (server rejected the address)";
      } else {
        r.mailbox = "unknown";
        r.status = "risky";
        r.reason =
          "Mail server didn't give a clear answer (greylisting or rate " +
          "limit) — try again later";
      }
    }
  }
}

/**
 * Verify a batch of emails. `deep` adds a mailbox-level SMTP probe on top of
 * the syntax/domain checks (slower; only works where outbound port 25 is
 * allowed). We dedupe internally.
 */
export async function verifyEmails(
  emails: string[],
  deep = false
): Promise<VerifyResult[]> {
  const unique = [...new Set(emails.map((e) => e.trim()).filter(Boolean))].slice(
    0,
    MAX_EMAILS_PER_REQUEST
  );

  const results: VerifyResult[] = [];
  const CHUNK = 10;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = await Promise.all(unique.slice(i, i + CHUNK).map(verifyOne));
    results.push(...chunk);
  }

  if (deep) await deepCheck(results);
  return results;
}
