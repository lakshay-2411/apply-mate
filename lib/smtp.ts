import net from "node:net";

/**
 * Minimal SMTP mailbox probe. Opens one connection to a domain's mail
 * server and asks (via RCPT TO) whether addresses are accepted — without
 * ever sending a message (we QUIT before DATA).
 *
 * Reliability caveats, all handled by the caller:
 *   - Port 25 outbound is blocked on most cloud hosts (e.g. Render) →
 *     `reachable: false`, treat as "unknown".
 *   - Catch-all domains accept every address → detected via a random-address
 *     probe so the caller can avoid false "valid".
 *   - Greylisting / rate-limiting shows up as 4xx → "unknown".
 */

export interface SmtpProbeResult {
  /** True if we completed an SMTP handshake with the server. */
  reachable: boolean;
  /** recipient (lowercased) -> SMTP reply code for its RCPT TO. */
  codes: Map<string, number>;
  /** True if the server accepted a random, almost-certainly-nonexistent address. */
  catchAll: boolean;
  error?: string;
}

function isAccept(code: number | undefined): boolean {
  return code !== undefined && code >= 200 && code < 300;
}

function randomLocalPart(): string {
  return (
    "no-reply-check-" +
    Math.random().toString(36).slice(2, 12) +
    Math.random().toString(36).slice(2, 6)
  );
}

/**
 * Probe a single domain's mail server for a set of recipients (all on that
 * same domain). Also probes a random address first to detect catch-alls.
 */
export function smtpProbeDomain(opts: {
  mxHost: string;
  domain: string;
  recipients: string[];
  heloHost: string;
  fromAddress: string;
  timeoutMs?: number;
}): Promise<SmtpProbeResult> {
  const {
    mxHost,
    domain,
    recipients,
    heloHost,
    fromAddress,
    timeoutMs = 12_000,
  } = opts;

  return new Promise((resolve) => {
    const codes = new Map<string, number>();
    const catchAllAddr = `${randomLocalPart()}@${domain}`;

    // Command sequence. HELO (not EHLO) keeps replies single-line.
    const steps: Array<{ cmd: string; tag?: string }> = [
      { cmd: `HELO ${heloHost}` },
      { cmd: `MAIL FROM:<${fromAddress}>` },
      { cmd: `RCPT TO:<${catchAllAddr}>`, tag: catchAllAddr },
      ...recipients.map((r) => ({ cmd: `RCPT TO:<${r}>`, tag: r })),
      { cmd: "QUIT" },
    ];

    let idx = -1; // -1 = awaiting the greeting banner
    let buf = "";
    let settled = false;

    const socket = net.createConnection({ host: mxHost, port: 25 });
    socket.setTimeout(timeoutMs);

    const done = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        reachable: true,
        codes,
        catchAll: isAccept(codes.get(catchAllAddr)),
      });
    };

    const fail = (error: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reachable: false, codes, catchAll: false, error });
    };

    const sendNext = () => {
      idx++;
      if (idx >= steps.length) return done();
      socket.write(steps[idx].cmd + "\r\n");
    };

    const handleResponse = (code: number) => {
      if (idx === -1) {
        // Server greeting.
        if (code === 220) sendNext();
        else fail(`Unexpected greeting ${code}`);
        return;
      }
      const step = steps[idx];
      if (step.tag) codes.set(step.tag, code); // record RCPT result
      if (idx === 0 && !isAccept(code)) {
        return fail(`HELO rejected (${code})`);
      }
      if (idx === 1 && !isAccept(code)) {
        return fail(`MAIL FROM rejected (${code})`);
      }
      sendNext();
    };

    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      // A reply is complete once a line reads "NNN <text>" (space after the
      // code); "NNN-<text>" lines are continuations.
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl === -1) break;
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        const m = /^(\d{3})([ -]?)/.exec(line);
        if (m && m[2] !== "-") {
          handleResponse(Number(m[1]));
        }
      }
    });

    socket.on("timeout", () => fail("timeout"));
    socket.on("error", (e) =>
      fail((e as NodeJS.ErrnoException).code ?? e.message)
    );
    socket.on("close", () => {
      // Server hung up before we finished — resolve with whatever we have.
      if (!settled) {
        settled = true;
        resolve({
          reachable: codes.size > 0 || idx >= 1,
          codes,
          catchAll: isAccept(codes.get(catchAllAddr)),
        });
      }
    });
  });
}
