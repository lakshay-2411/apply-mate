"use client";

import Link from "next/link";
import { useSession, signOut } from "next-auth/react";

const TABS = [
  { key: "compose", href: "/", label: "Compose" },
  { key: "sent", href: "/sent", label: "Sent & follow-ups" },
  { key: "verify", href: "/verify", label: "Email verifier" },
] as const;

export type TabKey = (typeof TABS)[number]["key"];

export default function AppHeader({ active }: { active: TabKey }) {
  const { data: session } = useSession();

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900/90 backdrop-blur">
      <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between gap-4">
        <div className="flex items-center gap-5 min-w-0">
          <Link href="/" className="flex items-center gap-2 shrink-0">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-indigo-600 text-white">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4"
              >
                <path d="M22 2 11 13" />
                <path d="M22 2 15 22l-4-9-9-4 20-7z" />
              </svg>
            </span>
            <span className="font-bold text-slate-900 dark:text-white">
              Apply Mate
            </span>
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            {TABS.map((t) =>
              t.key === active ? (
                <span
                  key={t.key}
                  className="rounded-full bg-slate-100 dark:bg-slate-800 px-3 py-1.5 font-medium text-slate-900 dark:text-white"
                >
                  {t.label}
                </span>
              ) : (
                <Link
                  key={t.key}
                  href={t.href}
                  className="rounded-full px-3 py-1.5 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-white transition"
                >
                  {t.label}
                </Link>
              )
            )}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm min-w-0">
          <span className="truncate text-slate-500 dark:text-slate-400 hidden sm:block">
            {session?.user?.email}
          </span>
          <button
            onClick={() => signOut()}
            className="shrink-0 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
