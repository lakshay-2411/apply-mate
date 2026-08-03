"use client";

import { useEffect, useState } from "react";
import { useSession, signIn, signOut } from "next-auth/react";
import { readNdjsonStream } from "@/lib/ndjson";
import AppHeader from "../components/AppHeader";
import { ToastStack, useToasts } from "../components/toasts";

/** One sent conversation, grouped server-side by Gmail thread. */
interface SentThread {
  threadId: string;
  /** Number of mails you sent in this thread (original + follow-ups). */
  count: number;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  /** RFC 822 Message-ID of your latest sent mail — the reply target. */
  rfcMessageId: string;
  /** True when the thread contains a received mail (they replied). */
  hasReply: boolean;
}

interface FollowUpResult {
  to: string;
  subject: string;
  status: "sent" | "failed";
  error?: string;
}

type FollowUpEvent =
  | { type: "start"; total: number }
  | ({ type: "result" } & FollowUpResult)
  | { type: "done"; sent: number; failed: number };

const DEFAULT_AFTER = "2026-07-01";

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

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

/** Split a `Name <email>` header into display name + address. */
function parseTo(to: string): { display: string; email: string } {
  const m = to.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/);
  if (m) return { display: m[1].trim() || m[2].trim(), email: m[2].trim() };
  return { display: to.trim(), email: to.trim() };
}

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

export default function SentPage() {
  const { status } = useSession();
  const { toasts, push } = useToasts();

  const [after, setAfter] = useState(DEFAULT_AFTER);
  const [threads, setThreads] = useState<SentThread[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [panelOpen, setPanelOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [delaySec, setDelaySec] = useState(2);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [results, setResults] = useState<FollowUpResult[] | null>(null);

  const signedIn = status === "authenticated";

  const load = async (opts?: {
    after?: string;
    append?: boolean;
    pageToken?: string;
  }) => {
    const afterVal = opts?.after ?? after;
    setLoading(true);
    setError(null);
    setNeedsReauth(false);
    try {
      const params = new URLSearchParams({ after: afterVal });
      if (opts?.pageToken) params.set("pageToken", opts.pageToken);
      const res = await fetch(`/api/sent?${params}`);
      const json = await res.json();
      if (!res.ok) {
        if (json.needsReauth) setNeedsReauth(true);
        throw new Error(json.error ?? "Could not load sent mail");
      }
      setThreads((prev) =>
        opts?.append
          ? [
              ...prev,
              ...(json.threads as SentThread[]).filter(
                (t) => !prev.some((p) => p.threadId === t.threadId)
              ),
            ]
          : json.threads
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

  const applyAfter = (value: string) => {
    setAfter(value);
    load({ after: value });
  };

  const quickFilters = [
    { label: "Last 7 days", value: daysAgo(7) },
    { label: "Last 30 days", value: daysAgo(30) },
    { label: "Since Jul 1", value: DEFAULT_AFTER },
  ];

  // ---- Search / selection (per thread) ----
  const q = query.trim().toLowerCase();
  const visible = q
    ? threads.filter((t) =>
        `${t.to} ${t.subject} ${t.snippet}`.toLowerCase().includes(q)
      )
    : threads;
  const totalMails = threads.reduce((sum, t) => sum + t.count, 0);

  const toggle = (threadId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  };
  const allVisibleSelected =
    visible.length > 0 && visible.every((t) => selected.has(t.threadId));
  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visible.forEach((t) => next.delete(t.threadId));
      else visible.forEach((t) => next.add(t.threadId));
      return next;
    });
  };

  const selectedThreads = threads.filter((t) => selected.has(t.threadId));

  // ---- Follow-up ----
  const sendFollowUp = async () => {
    if (selectedThreads.length === 0 || !message.trim()) return;
    setError(null);
    setResults([]);
    setSending(true);
    setProgress({ done: 0, total: selectedThreads.length });
    try {
      const res = await fetch("/api/follow-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          // Replies target the newest sent mail so Gmail threads them.
          targets: selectedThreads.map((t) => ({
            threadId: t.threadId,
            rfcMessageId: t.rfcMessageId,
            to: t.to,
            subject: t.subject,
          })),
          delayMs: Math.round(delaySec * 1000),
        }),
      });
      if (
        !res.ok ||
        (res.headers.get("content-type") ?? "").includes("application/json")
      ) {
        const json = await res.json();
        throw new Error(json.error ?? "Follow-up failed");
      }
      await readNdjsonStream<FollowUpEvent>(res, (ev) => {
        if (ev.type === "start") {
          setProgress({ done: 0, total: ev.total });
        } else if (ev.type === "result") {
          setResults((prev) => [...(prev ?? []), ev]);
          setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
        } else if (ev.type === "done") {
          push(
            ev.failed === 0 ? "success" : "error",
            `Follow-up done — ${ev.sent} sent${ev.failed ? `, ${ev.failed} failed` : ""}`
          );
          if (ev.failed === 0) setSelected(new Set());
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Follow-up failed";
      push("error", msg);
    } finally {
      setSending(false);
      setProgress(null);
    }
  };

  const closePanel = () => {
    if (sending) return;
    setPanelOpen(false);
    setResults(null);
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
            Sent mail
          </h1>
          <p className="mt-3 text-slate-600 dark:text-slate-400">
            Sign in with Google to see your sent mail and send follow-ups.
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
    <main className="flex-1 overflow-x-clip bg-slate-50 dark:bg-slate-950 pb-28">
      <AppHeader active="sent" />

      <div className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-1 gap-6">
        {/* Toolbar */}
        <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-56 flex-1">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search loaded mail by recipient or subject…"
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 py-2 pl-9 pr-3 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div className="flex items-center gap-1.5">
              {quickFilters.map((f) => (
                <button
                  key={f.label}
                  onClick={() => applyAfter(f.value)}
                  disabled={loading}
                  className={`rounded-full px-3 py-1.5 text-sm transition ${
                    after === f.value
                      ? "bg-indigo-600 text-white"
                      : "border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-sm">
              <input
                type="date"
                value={after}
                onChange={(e) => e.target.value && applyAfter(e.target.value)}
                className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button
                onClick={() => load()}
                disabled={loading}
                title="Refresh"
                className="grid h-9 w-9 place-items-center rounded-lg border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 transition"
              >
                {loading ? (
                  <Spinner />
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-4 w-4"
                  >
                    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                    <path d="M21 3v6h-6" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </section>

        {/* Mail list */}
        <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 px-5 py-3">
            <label className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-600 dark:text-slate-400">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={toggleAll}
                disabled={visible.length === 0}
                className="h-4 w-4 accent-indigo-600"
              />
              Select all{query ? " (matching)" : ""}
            </label>
            <span className="text-sm text-slate-400">
              {visible.length} conversation{visible.length === 1 ? "" : "s"} (
              {totalMails} mail{totalMails === 1 ? "" : "s"}
              {nextPageToken ? " loaded" : ""})
              {selected.size > 0 && ` · ${selected.size} selected`}
            </span>
          </div>

          {needsReauth && (
            <div className="m-5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
              Reading sent mail needs a permission you haven&apos;t granted
              yet.{" "}
              <button
                onClick={() => signOut()}
                className="font-medium underline"
              >
                Sign out
              </button>{" "}
              and sign in again, then approve the &quot;read email&quot;
              permission.
            </div>
          )}

          {error && !needsReauth && (
            <p className="m-5 rounded-lg bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-600">
              {error}
            </p>
          )}

          {/* Skeletons on first load */}
          {loading && threads.length === 0 && !needsReauth && (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {Array.from({ length: 6 }).map((_, i) => (
                <li key={i} className="flex items-center gap-3 px-5 py-3.5">
                  <div className="h-4 w-4 rounded bg-slate-100 dark:bg-slate-800 animate-pulse" />
                  <div className="h-9 w-9 rounded-full bg-slate-100 dark:bg-slate-800 animate-pulse" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-1/3 rounded bg-slate-100 dark:bg-slate-800 animate-pulse" />
                    <div className="h-3 w-2/3 rounded bg-slate-100 dark:bg-slate-800 animate-pulse" />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {visible.length > 0 && (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {visible.map((t) => {
                const { display, email } = parseTo(t.to);
                const checked = selected.has(t.threadId);
                return (
                  <li
                    key={t.threadId}
                    onClick={() => toggle(t.threadId)}
                    className={`flex cursor-pointer items-center gap-3 px-5 py-3 transition ${
                      checked
                        ? "bg-indigo-50/70 dark:bg-indigo-950/30"
                        : "hover:bg-slate-50 dark:hover:bg-slate-800/40"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(t.threadId)}
                      onClick={(e) => e.stopPropagation()}
                      className="h-4 w-4 shrink-0 accent-indigo-600"
                    />
                    <span
                      className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-semibold ${
                        checked
                          ? "bg-indigo-600 text-white"
                          : "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                      }`}
                    >
                      {(display[0] ?? "?").toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="flex min-w-0 items-baseline gap-2">
                          <span
                            className="truncate font-medium text-slate-900 dark:text-white"
                            title={email}
                          >
                            {display || "(no recipient)"}
                          </span>
                          {t.count > 1 && (
                            <span
                              className="shrink-0 rounded-full bg-slate-200 dark:bg-slate-700 px-1.5 text-[11px] font-semibold leading-5 text-slate-600 dark:text-slate-300"
                              title={`You sent ${t.count} mails in this conversation`}
                            >
                              {t.count}
                            </span>
                          )}
                          {t.hasReply && (
                            <span
                              className="shrink-0 rounded-full bg-green-100 dark:bg-green-950 px-1.5 text-[11px] font-medium leading-5 text-green-700 dark:text-green-400"
                              title="This conversation has a reply from them"
                            >
                              replied
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-xs text-slate-400">
                          {formatDate(t.date)}
                        </span>
                      </div>
                      <div className="truncate text-sm text-slate-600 dark:text-slate-400">
                        <span className="text-slate-800 dark:text-slate-200">
                          {t.subject || "(no subject)"}
                        </span>
                        {t.snippet && (
                          <span className="text-slate-400"> — {t.snippet}</span>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {!loading &&
            !error &&
            !needsReauth &&
            threads.length > 0 &&
            visible.length === 0 && (
              <p className="px-5 py-10 text-center text-sm text-slate-500">
                Nothing matches &quot;{query}&quot; in the loaded mail.
              </p>
            )}

          {!loading && !error && !needsReauth && threads.length === 0 && (
            <div className="px-5 py-14 text-center">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mx-auto h-10 w-10 text-slate-300 dark:text-slate-700"
              >
                <rect width="20" height="16" x="2" y="4" rx="2" />
                <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
              </svg>
              <p className="mt-3 text-sm text-slate-500">
                No sent mail found after {after}.
              </p>
            </div>
          )}

          {nextPageToken && (
            <div className="border-t border-slate-100 dark:border-slate-800 p-4 text-center">
              <button
                onClick={() => load({ append: true, pageToken: nextPageToken })}
                disabled={loading}
                className="rounded-lg border border-slate-300 dark:border-slate-700 px-4 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 transition"
              >
                {loading ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </section>
      </div>

      {/* Sticky selection action bar */}
      {selected.size > 0 && !panelOpen && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-30 flex justify-center px-4">
          <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-slate-900 dark:bg-white py-2 pl-5 pr-2 text-white dark:text-slate-900 shadow-xl">
            <span className="text-sm font-medium">
              {selected.size} selected
            </span>
            <button
              onClick={() => setSelected(new Set())}
              className="ml-1 text-sm text-slate-400 dark:text-slate-500 hover:text-white dark:hover:text-slate-900"
            >
              Clear
            </button>
            <button
              onClick={() => {
                setResults(null);
                setPanelOpen(true);
              }}
              className="ml-2 rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 transition"
            >
              Write follow-up →
            </button>
          </div>
        </div>
      )}

      {/* Follow-up slide-over */}
      <div
        className={`fixed inset-0 z-40 overflow-hidden ${panelOpen ? "" : "pointer-events-none"}`}
        aria-hidden={!panelOpen}
      >
        <div
          className={`absolute inset-0 bg-black/40 transition-opacity duration-300 ${
            panelOpen ? "opacity-100" : "opacity-0"
          }`}
          onClick={closePanel}
        />
        <div
          className={`absolute inset-y-0 right-0 flex w-full max-w-md flex-col bg-white dark:bg-slate-900 shadow-2xl transition-transform duration-300 ${
            panelOpen ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 px-6 py-4">
            <h3 className="font-semibold text-slate-900 dark:text-white">
              Follow-up to {selectedThreads.length} thread
              {selectedThreads.length === 1 ? "" : "s"}
            </h3>
            <button
              onClick={closePanel}
              disabled={sending}
              className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-50"
              title="Close"
            >
              ✕
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            <div className="flex flex-wrap gap-1.5">
              {selectedThreads.slice(0, 5).map((t) => (
                <span
                  key={t.threadId}
                  className="max-w-full truncate rounded-full bg-slate-100 dark:bg-slate-800 px-2.5 py-1 text-xs text-slate-600 dark:text-slate-300"
                >
                  {parseTo(t.to).display}
                </span>
              ))}
              {selectedThreads.length > 5 && (
                <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2.5 py-1 text-xs text-slate-400">
                  +{selectedThreads.length - 5} more
                </span>
              )}
            </div>

            <p className="mt-4 text-sm text-slate-500">
              Sent as a reply in each conversation — same thread, subject
              becomes &quot;Re: …&quot;.
            </p>

            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={8}
              disabled={sending}
              placeholder={
                "Hi, just following up on my application — happy to share anything else you need. Thanks!"
              }
              className="mt-3 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 font-mono text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60"
            />

            <label className="mt-3 block text-sm text-slate-600 dark:text-slate-400">
              Delay between emails:{" "}
              <input
                type="number"
                min={0}
                max={30}
                value={delaySec}
                onChange={(e) => setDelaySec(Number(e.target.value))}
                disabled={sending}
                className="w-16 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />{" "}
              s
            </label>

            {sending && progress && (
              <div className="mt-4">
                <div className="flex items-center justify-between text-sm text-slate-600 dark:text-slate-400">
                  <span>
                    Sending {Math.min(progress.done + 1, progress.total)} of{" "}
                    {progress.total}…
                  </span>
                  <span>
                    {progress.done}/{progress.total}
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div
                    className="h-full rounded-full bg-indigo-600 transition-all duration-500"
                    style={{
                      width: `${(progress.done / Math.max(1, progress.total)) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {results && results.length > 0 && (
              <ul className="mt-4 space-y-1 text-sm">
                {results.map((r, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-1.5"
                  >
                    <span className="truncate text-slate-700 dark:text-slate-300">
                      {parseTo(r.to).display || "(unknown)"}
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
            )}
          </div>

          <div className="border-t border-slate-200 dark:border-slate-800 px-6 py-4">
            <button
              onClick={sendFollowUp}
              disabled={
                sending || selectedThreads.length === 0 || !message.trim()
              }
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 py-2.5 font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:hover:bg-indigo-600 transition"
            >
              {sending && <Spinner />}
              {sending
                ? "Sending…"
                : `Send follow-up to ${selectedThreads.length} thread${selectedThreads.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      </div>

      <ToastStack toasts={toasts} />
    </main>
  );
}
