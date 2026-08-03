"use client";

import { useEffect, useRef, useState } from "react";
import { useSession, signIn } from "next-auth/react";
import { render } from "@/lib/template";
import { readNdjsonStream } from "@/lib/ndjson";
import AppHeader from "./components/AppHeader";
import { ToastStack, useToasts } from "./components/toasts";

interface Row {
  email: string;
  name: string;
  company: string;
  role: string;
}

interface SendResult {
  email: string;
  company: string;
  role: string;
  subject: string;
  status: "sent" | "failed";
  error?: string;
}

type SendEvent =
  | { type: "start"; total: number }
  | ({ type: "result" } & SendResult)
  | { type: "done"; sent: number; failed: number };

interface HistoryRow {
  to_email: string;
  company: string | null;
  role: string | null;
  subject: string;
  status: string;
  error: string | null;
  created_at: string;
}

const DEFAULT_SUBJECT = "Application for {role} at {company}";
const DEFAULT_BODY = `Hey!

Came across the post regarding Full Stack Developer Role and wanted to reach out.

I recently completed my 6-month internship at Myntra (Blr), working on production backend services. Before that, I was at a startup building full-stack stuff with Next.js, GCP, and async event-driven architecture - around ~1.2 years of internship experience across startups and product companies.

Comfortable across the JS/TS ecosystem (React, Next.js, Node) and have solid Python and Java experience too.

Resume: https://drive.google.com/file/d/1vdIz71jJ79Dd8XXijlxwbcXqNRiCmzfg/view?usp=sharing

Cheers!`;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKENS = ["company", "role", "name"] as const;

const inputCls =
  "w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500";
const cellCls =
  "w-full rounded-md border bg-white dark:bg-slate-950 px-2 py-1.5 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500";

function emptyRow(): Row {
  return { email: "", name: "", company: "", role: "" };
}

/** Parse pasted/typed CSV or spreadsheet text into rows. */
function parseCsvText(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(/\t|,/).map((p) => p.trim());
    if (!parts[0]) continue;
    if (/^e-?mail$/i.test(parts[0])) continue; // header row
    rows.push({
      email: parts[0] ?? "",
      name: parts[1] ?? "",
      company: parts[2] ?? "",
      role: parts[3] ?? "",
    });
  }
  return rows;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatEta(totalSeconds: number): string {
  const s = Math.max(1, Math.round(totalSeconds));
  if (s < 60) return `~${s}s`;
  return `~${Math.floor(s / 60)}m ${s % 60}s`;
}

function TokenChips({ onInsert }: { onInsert: (token: string) => void }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {TOKENS.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onInsert(t)}
          className="rounded-full border border-indigo-200 dark:border-indigo-900 bg-indigo-50 dark:bg-indigo-950/50 px-2 py-0.5 font-mono text-xs text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 transition"
          title={`Insert {${t}} at the cursor`}
        >
          {`{${t}}`}
        </button>
      ))}
    </div>
  );
}

function Spinner() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className="h-4 w-4 animate-spin"
      aria-hidden
    >
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

export default function Home() {
  const { data: session, status } = useSession();
  const { toasts, push } = useToasts();

  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [bodyText, setBodyText] = useState(DEFAULT_BODY);
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [csv, setCsv] = useState("");
  const [showCsv, setShowCsv] = useState(false);
  const [delaySec, setDelaySec] = useState(2);

  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [resume, setResume] = useState<{
    path: string;
    name: string;
    mimeType: string;
    size: number;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const [sending, setSending] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [results, setResults] = useState<SendResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const lastBatch = useRef<Row[]>([]);

  const signedIn = status === "authenticated";

  const loadHistory = async () => {
    try {
      const res = await fetch("/api/history");
      if (res.ok) {
        const json = await res.json();
        setHistory(json.sends ?? []);
      }
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (!signedIn) return;
    // Deferred so the effect body itself stays free of state updates.
    const t = setTimeout(() => loadHistory(), 0);
    return () => clearTimeout(t);
  }, [signedIn]);

  // ---- Template helpers ----
  const insertToken = (field: "subject" | "body", token: string) => {
    const text = `{${token}}`;
    if (field === "subject") {
      const el = subjectRef.current;
      const start = el?.selectionStart ?? subject.length;
      const end = el?.selectionEnd ?? start;
      setSubject(subject.slice(0, start) + text + subject.slice(end));
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(start + text.length, start + text.length);
      });
    } else {
      const el = bodyRef.current;
      const start = el?.selectionStart ?? bodyText.length;
      const end = el?.selectionEnd ?? start;
      setBodyText(bodyText.slice(0, start) + text + bodyText.slice(end));
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(start + text.length, start + text.length);
      });
    }
  };

  // ---- Recipient rows ----
  const updateRow = (i: number, field: keyof Row, value: string) => {
    setRows((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, [field]: value } : r))
    );
  };
  const addRow = () => setRows((prev) => [...prev, emptyRow()]);
  const removeRow = (i: number) =>
    setRows((prev) =>
      prev.length > 1 ? prev.filter((_, idx) => idx !== i) : [emptyRow()]
    );
  const clearRows = () => setRows([emptyRow()]);

  const mergeRows = (parsed: Row[]) => {
    if (!parsed.length) return;
    setRows((prev) => {
      const existing = prev.filter(
        (r) => r.email || r.name || r.company || r.role
      );
      return [...existing, ...parsed];
    });
    push("success", `Imported ${parsed.length} recipient${parsed.length === 1 ? "" : "s"}`);
  };

  const importCsv = () => {
    const parsed = parseCsvText(csv);
    if (parsed.length) {
      mergeRows(parsed);
      setCsv("");
      setShowCsv(false);
    } else {
      push("error", "No recipients found in the pasted text");
    }
  };

  /** Pasting spreadsheet/CSV text into an email cell imports it as rows. */
  const onEmailPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (!/[\n\t]/.test(text)) return; // normal single-value paste
    e.preventDefault();
    mergeRows(parseCsvText(text));
  };

  const emailCounts = new Map<string, number>();
  for (const r of rows) {
    const key = r.email.trim().toLowerCase();
    if (key) emailCounts.set(key, (emailCounts.get(key) ?? 0) + 1);
  }
  const isInvalid = (email: string) =>
    !!email.trim() && !EMAIL_RE.test(email.trim());
  const isDuplicate = (email: string) =>
    (emailCounts.get(email.trim().toLowerCase()) ?? 0) > 1;

  const validRows = rows.filter((r) => EMAIL_RE.test(r.email.trim()));
  const invalidCount = rows.filter((r) => isInvalid(r.email)).length;
  const duplicateCount = rows.filter((r) => isDuplicate(r.email)).length;

  // ---- Resume upload ----
  const uploadResume = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Upload failed");
      setResume({
        path: json.path,
        name: json.name,
        mimeType: json.mimeType,
        size: file.size,
      });
      push("success", `Resume "${json.name}" uploaded`);
    } catch (err) {
      push("error", err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  // ---- Preview ----
  const previewVars = {
    company: validRows[0]?.company || "Acme Corp",
    role: validRows[0]?.role || "Software Developer",
    name: validRows[0]?.name || "Jane",
    email: validRows[0]?.email || "hr@example.com",
  };

  // ---- Send ----
  const estimatedSeconds = (n: number) => (n - 1) * delaySec * 1.5 + n * 1;

  const sendBatch = async (recipients: Row[]) => {
    setShowConfirm(false);
    setError(null);
    setResults([]);
    setSending(true);
    setProgress({ done: 0, total: recipients.length });
    lastBatch.current = recipients;
    try {
      const res = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subjectTemplate: subject,
          bodyTemplate: bodyText,
          recipients,
          resumePath: resume?.path,
          resumeName: resume?.name,
          resumeMimeType: resume?.mimeType,
          delayMs: Math.round(delaySec * 1000),
        }),
      });
      if (
        !res.ok ||
        (res.headers.get("content-type") ?? "").includes("application/json")
      ) {
        const json = await res.json();
        throw new Error(json.error ?? "Send failed");
      }
      await readNdjsonStream<SendEvent>(res, (ev) => {
        if (ev.type === "start") {
          setProgress({ done: 0, total: ev.total });
        } else if (ev.type === "result") {
          setResults((prev) => [...(prev ?? []), ev]);
          setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
        } else if (ev.type === "done") {
          push(
            ev.failed === 0 ? "success" : "error",
            `Done — ${ev.sent} sent${ev.failed ? `, ${ev.failed} failed` : ""}`
          );
        }
      });
      loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(false);
      setProgress(null);
    }
  };

  const failedEmails = new Set(
    (results ?? []).filter((r) => r.status === "failed").map((r) => r.email)
  );
  const retryFailed = () =>
    sendBatch(lastBatch.current.filter((r) => failedEmails.has(r.email)));

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
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-indigo-600 text-white">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-6 w-6"
            >
              <path d="M22 2 11 13" />
              <path d="M22 2 15 22l-4-9-9-4 20-7z" />
            </svg>
          </span>
          <h1 className="mt-4 text-2xl font-bold text-slate-900 dark:text-white">
            Apply Mate
          </h1>
          <p className="mt-3 text-slate-600 dark:text-slate-400">
            Connect your Gmail and send personalized job-application emails to
            many HRs at once — same content, different company &amp; role.
          </p>
          <button
            onClick={() => signIn("google")}
            className="mt-6 w-full rounded-xl bg-indigo-600 text-white font-medium py-3 hover:bg-indigo-500 transition"
          >
            Connect Google account
          </button>
          <p className="mt-4 text-xs text-slate-400">
            We only request permission to send email and read your sent mail.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 overflow-x-clip bg-slate-50 dark:bg-slate-950">
      <AppHeader active="compose" />

      <div className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-1 gap-6">
        {/* Template + live preview */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_28rem] items-start">
          {/* Template editor */}
          <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6">
            <h2 className="font-semibold text-slate-900 dark:text-white">
              Email template
            </h2>
            <p className="text-sm text-slate-500 mt-1">
              Click a chip to insert a placeholder — each one is filled in per
              recipient.
            </p>

            <label className="block mt-4 text-sm font-medium text-slate-700 dark:text-slate-300">
              Subject
            </label>
            <input
              ref={subjectRef}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
            <TokenChips onInsert={(t) => insertToken("subject", t)} />

            <label className="block mt-4 text-sm font-medium text-slate-700 dark:text-slate-300">
              Body
            </label>
            <textarea
              ref={bodyRef}
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              rows={12}
              className={`mt-1 font-mono text-sm ${inputCls}`}
            />
            <TokenChips onInsert={(t) => insertToken("body", t)} />

            {/* Resume drop zone */}
            <label className="block mt-5 text-sm font-medium text-slate-700 dark:text-slate-300">
              Resume / CV{" "}
              <span className="font-normal text-slate-400">
                (optional, attached to every email)
              </span>
            </label>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.doc,.docx"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadResume(f);
                e.target.value = "";
              }}
            />
            {resume ? (
              <div className="mt-2 flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-4 py-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-indigo-100 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-4 w-4"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <path d="M14 2v6h6" />
                  </svg>
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-900 dark:text-white">
                    {resume.name}
                  </div>
                  <div className="text-xs text-slate-400">
                    {formatBytes(resume.size)}
                  </div>
                </div>
                <button
                  onClick={() => setResume(null)}
                  className="shrink-0 text-slate-400 hover:text-red-500"
                  title="Remove attachment"
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) uploadResume(f);
                }}
                disabled={uploading}
                className={`mt-2 w-full rounded-xl border-2 border-dashed px-4 py-6 text-sm transition ${
                  dragOver
                    ? "border-indigo-400 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-300"
                    : "border-slate-300 dark:border-slate-700 text-slate-500 hover:border-indigo-300 hover:text-indigo-600 dark:hover:text-indigo-400"
                }`}
              >
                {uploading ? (
                  <span className="flex items-center justify-center gap-2">
                    <Spinner /> Uploading…
                  </span>
                ) : (
                  <>
                    <span className="font-medium">
                      Drop your resume here or click to browse
                    </span>
                    <span className="mt-1 block text-xs text-slate-400">
                      PDF, DOC, DOCX — up to 10MB
                    </span>
                  </>
                )}
              </button>
            )}
          </section>

          {/* Live preview */}
          <section className="lg:sticky lg:top-20 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-slate-900 dark:text-white">
                Live preview
              </h2>
              <span className="text-xs text-slate-400">
                {validRows.length > 0
                  ? "using your first recipient"
                  : "using example values"}
              </span>
            </div>
            <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
              <div className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-4 py-3 text-xs">
                <div className="flex gap-2">
                  <span className="w-12 shrink-0 text-slate-400">From</span>
                  <span className="truncate text-slate-700 dark:text-slate-300">
                    {session?.user?.email}
                  </span>
                </div>
                <div className="mt-1 flex gap-2">
                  <span className="w-12 shrink-0 text-slate-400">To</span>
                  <span className="truncate text-slate-700 dark:text-slate-300">
                    {previewVars.email}
                  </span>
                </div>
                <div className="mt-1 flex gap-2">
                  <span className="w-12 shrink-0 text-slate-400">Subject</span>
                  <span className="truncate font-medium text-slate-900 dark:text-white">
                    {render(subject, previewVars) || "(empty subject)"}
                  </span>
                </div>
              </div>
              <div className="px-4 py-4">
                <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                  {render(bodyText, previewVars) || "(empty body)"}
                </pre>
                {resume && (
                  <div className="mt-4 inline-flex max-w-full items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs text-slate-600 dark:text-slate-400">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-3.5 w-3.5 shrink-0"
                    >
                      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                    </svg>
                    <span className="truncate">{resume.name}</span>
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>

        {/* Recipients */}
        <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold text-slate-900 dark:text-white">
              Recipients{" "}
              <span className="text-slate-400 font-normal">
                ({validRows.length} ready)
              </span>
            </h2>
            <div className="flex items-center gap-3 text-sm">
              <button
                onClick={() => setShowCsv((s) => !s)}
                className="text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                {showCsv ? "Hide paste/CSV" : "Paste / CSV import"}
              </button>
              <button
                onClick={clearRows}
                className="text-slate-500 dark:text-slate-400 hover:text-red-500"
              >
                Clear all
              </button>
            </div>
          </div>
          <p className="text-sm text-slate-500 mt-1">
            Tip: paste spreadsheet columns straight into an email cell — rows
            are imported automatically.
          </p>

          {showCsv && (
            <div className="mt-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-4">
              <textarea
                value={csv}
                onChange={(e) => setCsv(e.target.value)}
                rows={4}
                placeholder={
                  "hr@acme.com, Jane, Acme Corp, Full Stack Developer\nhr@globex.com, John, Globex, Software Developer"
                }
                className={`font-mono text-sm ${inputCls}`}
              />
              <p className="text-xs text-slate-400 mt-2">
                One recipient per line: <b>email, name, company, role</b>{" "}
                (comma or tab separated).
              </p>
              <button
                onClick={importCsv}
                className="mt-2 rounded-lg bg-indigo-600 text-white px-3 py-1.5 text-sm hover:bg-indigo-500 transition"
              >
                Import rows
              </button>
            </div>
          )}

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="pb-2 pr-3 font-medium">HR email</th>
                  <th className="pb-2 pr-3 font-medium">HR name</th>
                  <th className="pb-2 pr-3 font-medium">Company</th>
                  <th className="pb-2 pr-3 font-medium">Role</th>
                  <th className="pb-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const invalid = isInvalid(r.email);
                  const dup = !invalid && isDuplicate(r.email);
                  const emailBorder = invalid
                    ? "border-red-400 dark:border-red-700"
                    : dup
                      ? "border-amber-400 dark:border-amber-600"
                      : "border-slate-300 dark:border-slate-700";
                  return (
                    <tr key={i}>
                      <td className="py-1 pr-3">
                        <input
                          value={r.email}
                          onChange={(e) =>
                            updateRow(i, "email", e.target.value)
                          }
                          onPaste={onEmailPaste}
                          placeholder="hr@company.com"
                          title={
                            invalid
                              ? "Invalid email — this row won't be sent"
                              : dup
                                ? "Duplicate email"
                                : undefined
                          }
                          className={`${cellCls} ${emailBorder}`}
                        />
                      </td>
                      <td className="py-1 pr-3">
                        <input
                          value={r.name}
                          onChange={(e) => updateRow(i, "name", e.target.value)}
                          placeholder="Jane"
                          className={`${cellCls} border-slate-300 dark:border-slate-700`}
                        />
                      </td>
                      <td className="py-1 pr-3">
                        <input
                          value={r.company}
                          onChange={(e) =>
                            updateRow(i, "company", e.target.value)
                          }
                          placeholder="Acme Corp"
                          className={`${cellCls} border-slate-300 dark:border-slate-700`}
                        />
                      </td>
                      <td className="py-1 pr-3">
                        <input
                          value={r.role}
                          onChange={(e) => updateRow(i, "role", e.target.value)}
                          placeholder="Full Stack Developer"
                          className={`${cellCls} border-slate-300 dark:border-slate-700`}
                        />
                      </td>
                      <td className="py-1 text-center">
                        <button
                          onClick={() => removeRow(i)}
                          className="text-slate-400 hover:text-red-500"
                          title="Remove row"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-4">
            <button
              onClick={addRow}
              className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
            >
              + Add row
            </button>
            {invalidCount > 0 && (
              <span className="text-sm text-red-600 dark:text-red-400">
                {invalidCount} row{invalidCount === 1 ? " has an" : "s have"}{" "}
                invalid email{invalidCount === 1 ? "" : "s"} — they won&apos;t
                be sent.
              </span>
            )}
            {duplicateCount > 0 && (
              <span className="text-sm text-amber-600 dark:text-amber-400">
                Duplicate emails detected — those addresses would get multiple
                mails.
              </span>
            )}
          </div>
        </section>

        {/* Send */}
        <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="font-semibold text-slate-900 dark:text-white">
                Send
              </h2>
              <p className="text-sm text-slate-500 mt-1">
                {validRows.length} recipient
                {validRows.length === 1 ? "" : "s"} ·{" "}
                {resume ? `"${resume.name}" attached` : "no attachment"} ·
                spaced {delaySec}s apart
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <label className="text-sm text-slate-600 dark:text-slate-400">
                Delay between emails:{" "}
                <input
                  type="number"
                  min={0}
                  max={30}
                  value={delaySec}
                  onChange={(e) => setDelaySec(Number(e.target.value))}
                  className="w-16 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />{" "}
                s
              </label>
              <button
                onClick={() => setShowConfirm(true)}
                disabled={sending || validRows.length === 0}
                className="flex items-center gap-2 rounded-xl bg-indigo-600 text-white font-medium px-6 py-2.5 hover:bg-indigo-500 disabled:opacity-50 disabled:hover:bg-indigo-600 transition"
              >
                {sending && <Spinner />}
                {sending
                  ? "Sending…"
                  : `Send ${validRows.length} email${validRows.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>

          {/* Live progress */}
          {sending && progress && (
            <div className="mt-4">
              <div className="flex items-center justify-between text-sm text-slate-600 dark:text-slate-400">
                <span>
                  {progress.done < progress.total
                    ? `Sending ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
                    : "Finishing up…"}
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

          {error && (
            <p className="mt-4 text-sm text-red-600 bg-red-50 dark:bg-red-950/40 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          {results && results.length > 0 && (
            <div className="mt-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Sent {results.filter((r) => r.status === "sent").length} ·
                  Failed {results.filter((r) => r.status === "failed").length}
                </div>
                {!sending && failedEmails.size > 0 && (
                  <button
                    onClick={retryFailed}
                    className="rounded-lg border border-red-300 dark:border-red-800 px-3 py-1.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition"
                  >
                    Retry {failedEmails.size} failed
                  </button>
                )}
              </div>
              <ul className="mt-2 space-y-1 text-sm">
                {results.map((r, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-1.5"
                  >
                    <span className="truncate text-slate-700 dark:text-slate-300">
                      {r.email || "(batch error)"}{" "}
                      <span className="text-slate-400">— {r.subject}</span>
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

        {/* History */}
        {history.length > 0 && (
          <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6">
            <h2 className="font-semibold text-slate-900 dark:text-white">
              Recent sends
            </h2>
            <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800 text-sm">
              {history.slice(0, 20).map((h, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <span className="truncate text-slate-600 dark:text-slate-400">
                    <span className="text-slate-900 dark:text-white">
                      {h.to_email}
                    </span>{" "}
                    <span className="text-slate-400">— {h.subject}</span>
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                      h.status === "sent"
                        ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
                        : "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                    }`}
                  >
                    {h.status}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {/* Confirm modal */}
      {showConfirm && (
        <div
          className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4"
          onClick={() => setShowConfirm(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
              Ready to send?
            </h3>
            <ul className="mt-4 space-y-2 text-sm text-slate-600 dark:text-slate-400">
              <li className="flex justify-between gap-3">
                <span>Recipients</span>
                <span className="font-medium text-slate-900 dark:text-white">
                  {validRows.length}
                  {invalidCount > 0 && (
                    <span className="ml-1 font-normal text-red-500">
                      ({invalidCount} invalid skipped)
                    </span>
                  )}
                </span>
              </li>
              <li className="flex justify-between gap-3">
                <span>Attachment</span>
                <span className="truncate font-medium text-slate-900 dark:text-white">
                  {resume ? resume.name : "None"}
                </span>
              </li>
              <li className="flex justify-between gap-3">
                <span>Delay between emails</span>
                <span className="font-medium text-slate-900 dark:text-white">
                  {delaySec}s (randomized)
                </span>
              </li>
              <li className="flex justify-between gap-3">
                <span>Estimated time</span>
                <span className="font-medium text-slate-900 dark:text-white">
                  {formatEta(estimatedSeconds(validRows.length))}
                </span>
              </li>
            </ul>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setShowConfirm(false)}
                className="rounded-lg border border-slate-300 dark:border-slate-700 px-4 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
              >
                Cancel
              </button>
              <button
                onClick={() => sendBatch(validRows)}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition"
              >
                Send now
              </button>
            </div>
          </div>
        </div>
      )}

      <ToastStack toasts={toasts} />
    </main>
  );
}
