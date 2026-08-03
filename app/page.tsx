"use client";

import { useEffect, useState } from "react";
import { useSession, signIn, signOut } from "next-auth/react";
import { render } from "@/lib/template";

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

function emptyRow(): Row {
  return { email: "", name: "", company: "", role: "" };
}

export default function Home() {
  const { data: session, status } = useSession();

  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [bodyText, setBodyText] = useState(DEFAULT_BODY);
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [csv, setCsv] = useState("");
  const [showCsv, setShowCsv] = useState(false);
  const [delaySec, setDelaySec] = useState(2);

  const [resume, setResume] = useState<{
    path: string;
    name: string;
    mimeType: string;
  } | null>(null);
  const [uploading, setUploading] = useState(false);

  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<SendResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);

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
    if (signedIn) loadHistory();
  }, [signedIn]);

  // ---- Recipient rows ----
  const updateRow = (i: number, field: keyof Row, value: string) => {
    setRows((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, [field]: value } : r))
    );
  };
  const addRow = () => setRows((prev) => [...prev, emptyRow()]);
  const removeRow = (i: number) =>
    setRows((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));

  const importCsv = () => {
    const lines = csv
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const parsed: Row[] = [];
    for (const line of lines) {
      const parts = line.split(/\t|,/).map((p) => p.trim());
      // Skip an obvious header row.
      if (/^e-?mail$/i.test(parts[0])) continue;
      if (!parts[0]) continue;
      parsed.push({
        email: parts[0] ?? "",
        name: parts[1] ?? "",
        company: parts[2] ?? "",
        role: parts[3] ?? "",
      });
    }
    if (parsed.length) {
      setRows((prev) => {
        const existing = prev.filter(
          (r) => r.email || r.name || r.company || r.role
        );
        return [...existing, ...parsed];
      });
      setCsv("");
      setShowCsv(false);
    }
  };

  // ---- Resume upload ----
  const onResumeChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Upload failed");
      setResume({ path: json.path, name: json.name, mimeType: json.mimeType });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  // ---- Send ----
  const validRows = rows.filter((r) => r.email.trim());
  const previewVars = {
    company: validRows[0]?.company || "Acme Corp",
    role: validRows[0]?.role || "Software Developer",
    name: validRows[0]?.name || "Jane",
    email: validRows[0]?.email || "hr@example.com",
  };

  const send = async () => {
    setError(null);
    setResults(null);
    if (validRows.length === 0) {
      setError("Add at least one recipient with an email address.");
      return;
    }
    setSending(true);
    try {
      const res = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subjectTemplate: subject,
          bodyTemplate: bodyText,
          recipients: validRows,
          resumePath: resume?.path,
          resumeName: resume?.name,
          resumeMimeType: resume?.mimeType,
          delayMs: Math.round(delaySec * 1000),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Send failed");
      setResults(json.results as SendResult[]);
      loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
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
            Apply Mate
          </h1>
          <p className="mt-3 text-slate-600 dark:text-slate-400">
            Connect your Gmail and send personalized job-application emails to
            many HRs at once — same content, different company &amp; role.
          </p>
          <button
            onClick={() => signIn("google")}
            className="mt-6 w-full rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 font-medium py-3 hover:opacity-90 transition"
          >
            Connect Google account
          </button>
          <p className="mt-4 text-xs text-slate-400">
            We only request permission to send email on your behalf.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 bg-slate-50 dark:bg-slate-950">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <h1 className="font-bold text-lg text-slate-900 dark:text-white">
            Apply Mate
          </h1>
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
        {/* Template */}
        <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6">
          <h2 className="font-semibold text-slate-900 dark:text-white">
            1. Email template
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Use{" "}
            <code className="px-1 rounded bg-slate-100 dark:bg-slate-800">
              {"{company}"}
            </code>
            ,{" "}
            <code className="px-1 rounded bg-slate-100 dark:bg-slate-800">
              {"{role}"}
            </code>
            , and{" "}
            <code className="px-1 rounded bg-slate-100 dark:bg-slate-800">
              {"{name}"}
            </code>{" "}
            — they get filled in per recipient.
          </p>

          <label className="block mt-4 text-sm font-medium text-slate-700 dark:text-slate-300">
            Subject
          </label>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-slate-400"
          />

          <label className="block mt-4 text-sm font-medium text-slate-700 dark:text-slate-300">
            Body
          </label>
          <textarea
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            rows={10}
            className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-slate-900 dark:text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />

          {/* Resume */}
          <div className="mt-4">
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
              Resume / CV (optional, attached to every email)
            </label>
            <div className="mt-1 flex items-center gap-3">
              <input
                type="file"
                accept=".pdf,.doc,.docx"
                onChange={onResumeChange}
                className="text-sm text-slate-600 dark:text-slate-400 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:dark:bg-white file:text-white file:dark:text-slate-900 file:px-3 file:py-1.5 file:text-sm"
              />
              {uploading && (
                <span className="text-sm text-slate-500">Uploading…</span>
              )}
              {resume && !uploading && (
                <span className="text-sm text-green-600">✓ {resume.name}</span>
              )}
            </div>
          </div>
        </section>

        {/* Recipients */}
        <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-slate-900 dark:text-white">
              2. Recipients{" "}
              <span className="text-slate-400 font-normal">
                ({validRows.length})
              </span>
            </h2>
            <button
              onClick={() => setShowCsv((s) => !s)}
              className="text-sm text-slate-600 dark:text-slate-400 underline"
            >
              {showCsv ? "Hide paste/CSV" : "Paste / CSV import"}
            </button>
          </div>

          {showCsv && (
            <div className="mt-3">
              <textarea
                value={csv}
                onChange={(e) => setCsv(e.target.value)}
                rows={4}
                placeholder={"hr@acme.com, Jane, Acme Corp, Full Stack Developer\nhr@globex.com, John, Globex, Software Developer"}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm font-mono text-slate-900 dark:text-white"
              />
              <p className="text-xs text-slate-400 mt-1">
                One recipient per line: <b>email, name, company, role</b>{" "}
                (comma or tab separated). Works with pasted spreadsheet
                columns.
              </p>
              <button
                onClick={importCsv}
                className="mt-2 rounded-md bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-3 py-1.5 text-sm"
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
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="py-1 pr-3">
                      <input
                        value={r.email}
                        onChange={(e) => updateRow(i, "email", e.target.value)}
                        placeholder="hr@company.com"
                        className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-slate-900 dark:text-white"
                      />
                    </td>
                    <td className="py-1 pr-3">
                      <input
                        value={r.name}
                        onChange={(e) => updateRow(i, "name", e.target.value)}
                        placeholder="Jane"
                        className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-slate-900 dark:text-white"
                      />
                    </td>
                    <td className="py-1 pr-3">
                      <input
                        value={r.company}
                        onChange={(e) => updateRow(i, "company", e.target.value)}
                        placeholder="Acme Corp"
                        className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-slate-900 dark:text-white"
                      />
                    </td>
                    <td className="py-1 pr-3">
                      <input
                        value={r.role}
                        onChange={(e) => updateRow(i, "role", e.target.value)}
                        placeholder="Full Stack Developer"
                        className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-slate-900 dark:text-white"
                      />
                    </td>
                    <td className="py-1 text-center">
                      <button
                        onClick={() => removeRow(i)}
                        className="text-slate-400 hover:text-red-500"
                        title="Remove"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            onClick={addRow}
            className="mt-3 rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            + Add row
          </button>
        </section>

        {/* Preview + send */}
        <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6">
          <h2 className="font-semibold text-slate-900 dark:text-white">
            3. Preview &amp; send
          </h2>
          <div className="mt-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-4">
            <div className="text-xs uppercase tracking-wide text-slate-400">
              Subject
            </div>
            <div className="font-medium text-slate-900 dark:text-white">
              {render(subject, previewVars)}
            </div>
            <div className="mt-3 text-xs uppercase tracking-wide text-slate-400">
              Body
            </div>
            <pre className="mt-1 whitespace-pre-wrap font-sans text-sm text-slate-700 dark:text-slate-300">
              {render(bodyText, previewVars)}
            </pre>
          </div>

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
              onClick={send}
              disabled={sending || validRows.length === 0}
              className="rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 font-medium px-6 py-2.5 disabled:opacity-50 hover:opacity-90"
            >
              {sending
                ? "Sending…"
                : `Send ${validRows.length} email${validRows.length === 1 ? "" : "s"}`}
            </button>
          </div>

          {error && (
            <p className="mt-3 text-sm text-red-600 bg-red-50 dark:bg-red-950/40 rounded-md px-3 py-2">
              {error}
            </p>
          )}

          {results && (
            <div className="mt-4">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Sent {results.filter((r) => r.status === "sent").length} · Failed{" "}
                {results.filter((r) => r.status === "failed").length}
              </div>
              <ul className="mt-2 space-y-1 text-sm">
                {results.map((r, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between rounded-md border border-slate-200 dark:border-slate-800 px-3 py-1.5"
                  >
                    <span className="text-slate-700 dark:text-slate-300">
                      {r.email}{" "}
                      <span className="text-slate-400">— {r.subject}</span>
                    </span>
                    {r.status === "sent" ? (
                      <span className="text-green-600">✓ sent</span>
                    ) : (
                      <span className="text-red-500" title={r.error}>
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
            <ul className="mt-3 space-y-1 text-sm">
              {history.slice(0, 20).map((h, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 py-1.5"
                >
                  <span className="text-slate-600 dark:text-slate-400">
                    {h.to_email}{" "}
                    <span className="text-slate-400">— {h.subject}</span>
                  </span>
                  <span
                    className={
                      h.status === "sent" ? "text-green-600" : "text-red-500"
                    }
                  >
                    {h.status}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
