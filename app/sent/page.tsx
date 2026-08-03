"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession, signIn, signOut } from "next-auth/react";

interface SentMail {
  id: string;
  threadId: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  rfcMessageId: string;
}

interface FollowUpResult {
  to: string;
  subject: string;
  status: "sent" | "failed";
  error?: string;
}

const DEFAULT_AFTER = "2026-07-01";

function formatDate(value: string): string {
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function SentPage() {
  const { data: session, status } = useSession();

  const [after, setAfter] = useState(DEFAULT_AFTER);
  const [mails, setMails] = useState<SentMail[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [delaySec, setDelaySec] = useState(2);
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<FollowUpResult[] | null>(null);

  const signedIn = status === "authenticated";

  const load = async (opts?: { append?: boolean; pageToken?: string }) => {
    setLoading(true);
    setError(null);
    setNeedsReauth(false);
    try {
      const params = new URLSearchParams({ after });
      if (opts?.pageToken) params.set("pageToken", opts.pageToken);
      const res = await fetch(`/api/sent?${params}`);
      const json = await res.json();
      if (!res.ok) {
        if (json.needsReauth) setNeedsReauth(true);
        throw new Error(json.error ?? "Could not load sent mail");
      }
      setMails((prev) =>
        opts?.append ? [...prev, ...json.messages] : json.messages
      );
      setNextPageToken(json.nextPageToken);
      if (!opts?.append) setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load sent mail");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!signedIn) return;
    // Deferred so the effect body itself stays free of state updates.
    const t = setTimeout(() => load(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  // ---- Selection ----
  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const allSelected = mails.length > 0 && selected.size === mails.length;
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(mails.map((m) => m.id)));
  };

  // ---- Follow-up ----
  const sendFollowUp = async () => {
    setError(null);
    setResults(null);
    const targets = mails
      .filter((m) => selected.has(m.id))
      .map((m) => ({
        threadId: m.threadId,
        rfcMessageId: m.rfcMessageId,
        to: m.to,
        subject: m.subject,
      }));
    if (targets.length === 0) {
      setError("Select at least one mail to follow up on.");
      return;
    }
    if (!message.trim()) {
      setError("Write a follow-up message first.");
      return;
    }
    setSending(true);
    try {
      const res = await fetch("/api/follow-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          targets,
          delayMs: Math.round(delaySec * 1000),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Follow-up failed");
      setResults(json.results as FollowUpResult[]);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Follow-up failed");
    } finally {
      setSending(false);
    }
  };

  // ---------- Rendering ----------
  if (status === "loading") {
    return (
      <main className="flex-1 grid place-items-center text-slate-500">
        Loading…
      </main>
    );
  }

  if (!signedIn) {
    return (
      <main className="flex-1 grid place-items-center bg-slate-50 dark:bg-slate-950 p-6">
        <div className="max-w-md w-full rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-8 text-center shadow-sm">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
            Sent mail
          </h1>
          <p className="mt-3 text-slate-600 dark:text-slate-400">
            Sign in with Google to see your sent mail and send follow-ups.
          </p>
          <button
            onClick={() => signIn("google")}
            className="mt-6 w-full rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 font-medium py-3 hover:opacity-90 transition"
          >
            Connect Google account
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 bg-slate-50 dark:bg-slate-950">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="font-bold text-lg text-slate-900 dark:text-white">
              Apply Mate
            </h1>
            <nav className="flex items-center gap-3 text-sm">
              <Link
                href="/"
                className="text-slate-500 dark:text-slate-400 hover:underline"
              >
                Compose
              </Link>
              <span className="font-medium text-slate-900 dark:text-white">
                Sent &amp; follow-ups
              </span>
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-500 dark:text-slate-400">
              {session?.user?.email}
            </span>
            <button
              onClick={() => signOut()}
              className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8 grid gap-8">
        {/* Sent mail list */}
        <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold text-slate-900 dark:text-white">
              Sent mail{" "}
              <span className="text-slate-400 font-normal">
                ({mails.length}
                {nextPageToken ? "+" : ""})
              </span>
            </h2>
            <div className="flex items-center gap-2 text-sm">
              <label className="text-slate-600 dark:text-slate-400">
                Sent after
              </label>
              <input
                type="date"
                value={after}
                onChange={(e) => setAfter(e.target.value)}
                className="rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-slate-900 dark:text-white"
              />
              <button
                onClick={() => load()}
                disabled={loading}
                className="rounded-md bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-3 py-1.5 disabled:opacity-50"
              >
                {loading ? "Loading…" : "Refresh"}
              </button>
            </div>
          </div>
          <p className="text-sm text-slate-500 mt-1">
            All mail sent from your Gmail account (not just from this app).
            Select the ones you want to follow up on.
          </p>

          {needsReauth && (
            <div className="mt-4 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
              Reading sent mail needs a permission you haven&apos;t granted
              yet.{" "}
              <button onClick={() => signOut()} className="underline font-medium">
                Sign out
              </button>{" "}
              and sign in again, then approve the &quot;read email&quot;
              permission.
            </div>
          )}

          {error && !needsReauth && (
            <p className="mt-4 text-sm text-red-600 bg-red-50 dark:bg-red-950/40 rounded-md px-3 py-2">
              {error}
            </p>
          )}

          {mails.length > 0 && (
            <>
              <div className="mt-4 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  id="select-all"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="h-4 w-4 accent-slate-900 dark:accent-white"
                />
                <label
                  htmlFor="select-all"
                  className="text-slate-600 dark:text-slate-400"
                >
                  Select all ({selected.size} selected)
                </label>
              </div>

              <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
                {mails.map((m) => (
                  <li key={m.id} className="flex items-start gap-3 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(m.id)}
                      onChange={() => toggle(m.id)}
                      className="mt-1 h-4 w-4 accent-slate-900 dark:accent-white"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate font-medium text-slate-900 dark:text-white">
                          {m.to || "(no recipient)"}
                        </span>
                        <span className="shrink-0 text-xs text-slate-400">
                          {formatDate(m.date)}
                        </span>
                      </div>
                      <div className="truncate text-sm text-slate-700 dark:text-slate-300">
                        {m.subject || "(no subject)"}
                      </div>
                      <div className="truncate text-xs text-slate-400">
                        {m.snippet}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>

              {nextPageToken && (
                <button
                  onClick={() =>
                    load({ append: true, pageToken: nextPageToken })
                  }
                  disabled={loading}
                  className="mt-3 rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
                >
                  {loading ? "Loading…" : "Load more"}
                </button>
              )}
            </>
          )}

          {!loading && !error && !needsReauth && mails.length === 0 && (
            <p className="mt-4 text-sm text-slate-500">
              No sent mail found after {after}.
            </p>
          )}
        </section>

        {/* Follow-up composer */}
        <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6">
          <h2 className="font-semibold text-slate-900 dark:text-white">
            Follow-up message
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Sent as a reply in each selected conversation — same thread, subject
            becomes &quot;Re: …&quot;.
          </p>

          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={6}
            placeholder={
              "Hi, just following up on my application — happy to share anything else you need. Thanks!"
            }
            className="mt-3 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-slate-900 dark:text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />

          <div className="mt-4 flex flex-wrap items-center gap-4">
            <label className="text-sm text-slate-600 dark:text-slate-400">
              Delay between emails:{" "}
              <input
                type="number"
                min={0}
                max={30}
                value={delaySec}
                onChange={(e) => setDelaySec(Number(e.target.value))}
                className="w-16 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-slate-900 dark:text-white"
              />{" "}
              s
            </label>
            <button
              onClick={sendFollowUp}
              disabled={sending || selected.size === 0 || !message.trim()}
              className="rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 font-medium px-6 py-2.5 disabled:opacity-50 hover:opacity-90"
            >
              {sending
                ? "Sending…"
                : `Send follow-up to ${selected.size} thread${selected.size === 1 ? "" : "s"}`}
            </button>
          </div>

          {results && (
            <div className="mt-4">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Sent {results.filter((r) => r.status === "sent").length} ·
                Failed {results.filter((r) => r.status === "failed").length}
              </div>
              <ul className="mt-2 space-y-1 text-sm">
                {results.map((r, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between rounded-md border border-slate-200 dark:border-slate-800 px-3 py-1.5"
                  >
                    <span className="truncate text-slate-700 dark:text-slate-300">
                      {r.to} <span className="text-slate-400">— {r.subject}</span>
                    </span>
                    {r.status === "sent" ? (
                      <span className="shrink-0 text-green-600">✓ sent</span>
                    ) : (
                      <span className="shrink-0 text-red-500" title={r.error}>
                        ✕ {r.error ?? "failed"}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
