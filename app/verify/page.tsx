"use client";

import { useRef, useState } from "react";
import { useSession, signIn } from "next-auth/react";
import AppHeader from "../components/AppHeader";
import { ToastStack, useToasts } from "../components/toasts";

type VerifyStatus = "valid" | "risky" | "invalid";

type MailboxState = "exists" | "not_found" | "catch_all" | "unknown";

interface VerifyResult {
  email: string;
  status: VerifyStatus;
  reason: string;
  suggestion?: string;
  mx?: string;
  mailbox?: MailboxState;
}

const MAX_EMAILS = 500;
/** Loose extractor — pulls email-looking tokens out of any pasted text/CSV. */
const EXTRACT_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function extractEmails(text: string): string[] {
  return [...new Set(text.match(EXTRACT_RE) ?? [])];
}

const STATUS_STYLE: Record<VerifyStatus, string> = {
  valid:
    "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400",
  risky: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
  invalid: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
};

function Spinner() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 animate-spin" aria-hidden>
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="4"
      />
      <path
        d="M22 12a10 10 0 0 0-10-10"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function VerifyPage() {
  const { status } = useSession();
  const { toasts, push } = useToasts();
  const fileRef = useRef<HTMLInputElement>(null);

  const [input, setInput] = useState("");
  const [deep, setDeep] = useState(false);
  const [checking, setChecking] = useState(false);
  const [results, setResults] = useState<VerifyResult[] | null>(null);
  const [filter, setFilter] = useState<VerifyStatus | "all">("all");

  const signedIn = status === "authenticated";
  const pendingCount = extractEmails(input).length;

  const onCsvFile = async (file: File) => {
    const text = await file.text();
    const found = extractEmails(text);
    if (found.length === 0) {
      push("error", "No email addresses found in that file");
      return;
    }
    setInput((prev) => {
      const existing = extractEmails(prev);
      const merged = [...new Set([...existing, ...found])];
      return merged.join("\n");
    });
    push("success", `Imported ${found.length} address${found.length === 1 ? "" : "es"} from the file`);
  };

  const runCheck = async () => {
    const emails = extractEmails(input);
    if (emails.length === 0) {
      push("error", "Paste at least one email address first");
      return;
    }
    if (emails.length > MAX_EMAILS) {
      push("error", `Max ${MAX_EMAILS} emails per run — you have ${emails.length}`);
      return;
    }
    setChecking(true);
    setResults(null);
    setFilter("all");
    try {
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails, deep }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Verification failed");
      setResults(json.results as VerifyResult[]);
    } catch (err) {
      push("error", err instanceof Error ? err.message : "Verification failed");
    } finally {
      setChecking(false);
    }
  };

  const counts = {
    valid: results?.filter((r) => r.status === "valid").length ?? 0,
    risky: results?.filter((r) => r.status === "risky").length ?? 0,
    invalid: results?.filter((r) => r.status === "invalid").length ?? 0,
  };
  const shown =
    results?.filter((r) => filter === "all" || r.status === filter) ?? [];

  const copyValid = async () => {
    const valid = (results ?? [])
      .filter((r) => r.status === "valid")
      .map((r) => r.email);
    if (valid.length === 0) return;
    try {
      await navigator.clipboard.writeText(valid.join("\n"));
      push("success", `Copied ${valid.length} valid address${valid.length === 1 ? "" : "es"}`);
    } catch {
      push("error", "Could not copy to clipboard");
    }
  };

  // ---------- Rendering ----------
  if (status === "loading") {
    return (
      <main className="flex-1 grid place-items-center bg-slate-50 dark:bg-slate-950 text-slate-500">
        <div className="flex items-center gap-2">
          <Spinner /> Loading…
        </div>
      </main>
    );
  }

  if (!signedIn) {
    return (
      <main className="flex-1 grid place-items-center bg-slate-50 dark:bg-slate-950 p-6">
        <div className="max-w-md w-full rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-8 text-center shadow-sm">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
            Email verifier
          </h1>
          <p className="mt-3 text-slate-600 dark:text-slate-400">
            Sign in to check whether email addresses can receive mail.
          </p>
          <button
            onClick={() => signIn("google")}
            className="mt-6 w-full rounded-xl bg-indigo-600 text-white font-medium py-3 hover:bg-indigo-500 transition"
          >
            Connect Google account
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 overflow-x-clip bg-slate-50 dark:bg-slate-950">
      <AppHeader active="verify" />

      <div className="max-w-4xl mx-auto px-6 py-8 grid grid-cols-1 gap-6">
        {/* Input */}
        <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold text-slate-900 dark:text-white">
              Email verifier
            </h2>
            <button
              onClick={() => fileRef.current?.click()}
              className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              Import CSV / file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt,.tsv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onCsvFile(f);
                e.target.value = "";
              }}
            />
          </div>
          <p className="text-sm text-slate-500 mt-1">
            Checks the address format and whether the domain runs a mail
            server (plus disposable domains and typos). It can&apos;t confirm
            the exact inbox exists — that needs a mailbox-level check.
          </p>

          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={8}
            placeholder={"hr@acme.com\njobs@globex.com\n…one email per line (pasting CSV rows works too)"}
            className="mt-4 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 font-mono text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />

          <label className="mt-4 flex items-start gap-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-3 py-2.5 text-sm">
            <input
              type="checkbox"
              checked={deep}
              onChange={(e) => setDeep(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-indigo-600"
            />
            <span className="text-slate-600 dark:text-slate-400">
              <span className="font-medium text-slate-900 dark:text-white">
                Deep check (verify the mailbox exists)
              </span>{" "}
              — asks each mail server whether the exact inbox is real. Slower,
              and only works where outbound port 25 is open (locally yes; most
              cloud hosts block it). Catch-all domains still can&apos;t be
              confirmed.
            </span>
          </label>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-slate-400">
              {pendingCount} address{pendingCount === 1 ? "" : "es"} detected
            </span>
            <div className="flex items-center gap-3">
              {input.trim() && (
                <button
                  onClick={() => {
                    setInput("");
                    setResults(null);
                  }}
                  className="text-sm text-slate-500 dark:text-slate-400 hover:text-red-500"
                >
                  Clear
                </button>
              )}
              <button
                onClick={runCheck}
                disabled={checking || pendingCount === 0}
                className="flex items-center gap-2 rounded-xl bg-indigo-600 px-6 py-2.5 font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:hover:bg-indigo-600 transition"
              >
                {checking && <Spinner />}
                {checking
                  ? "Checking…"
                  : `Verify ${pendingCount || ""} email${pendingCount === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        </section>

        {/* Results */}
        {results && (
          <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5 text-sm">
                {(
                  [
                    { key: "all", label: `All (${results.length})` },
                    { key: "valid", label: `Valid (${counts.valid})` },
                    { key: "risky", label: `Risky (${counts.risky})` },
                    { key: "invalid", label: `Invalid (${counts.invalid})` },
                  ] as const
                ).map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setFilter(f.key)}
                    className={`rounded-full px-3 py-1.5 transition ${
                      filter === f.key
                        ? "bg-indigo-600 text-white"
                        : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              {counts.valid > 0 && (
                <button
                  onClick={copyValid}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
                >
                  Copy valid emails
                </button>
              )}
            </div>

            {shown.length === 0 ? (
              <p className="mt-4 text-sm text-slate-400">
                Nothing in this category.
              </p>
            ) : (
              <ul className="mt-4 max-h-[32rem] divide-y divide-slate-100 dark:divide-slate-800 overflow-y-auto text-sm">
                {shown.map((r) => (
                  <li
                    key={r.email}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-slate-900 dark:text-white">
                        {r.email}
                      </div>
                      <div className="truncate text-slate-500" title={r.mx ? `MX: ${r.mx}` : undefined}>
                        {r.reason}
                        {r.suggestion && (
                          <>
                            {" — did you mean "}
                            <span className="font-medium text-indigo-600 dark:text-indigo-400">
                              {r.suggestion}
                            </span>
                            ?
                          </>
                        )}
                      </div>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[r.status]}`}
                    >
                      {r.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>

      <ToastStack toasts={toasts} />
    </main>
  );
}
