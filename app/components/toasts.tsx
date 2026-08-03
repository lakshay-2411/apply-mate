"use client";

import { useCallback, useRef, useState } from "react";

export interface ToastItem {
  id: number;
  type: "success" | "error";
  text: string;
}

/** Small self-expiring notification stack. */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((type: ToastItem["type"], text: string) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, type, text }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  }, []);

  return { toasts, push };
}

export function ToastStack({ toasts }: { toasts: ToastItem[] }) {
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-80 max-w-[calc(100vw-2.5rem)] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-2 rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur ${
            t.type === "success"
              ? "border-green-200 bg-green-50/95 text-green-800 dark:border-green-900 dark:bg-green-950/90 dark:text-green-200"
              : "border-red-200 bg-red-50/95 text-red-800 dark:border-red-900 dark:bg-red-950/90 dark:text-red-200"
          }`}
        >
          <span className="mt-0.5 shrink-0">
            {t.type === "success" ? "✓" : "✕"}
          </span>
          <span className="min-w-0">{t.text}</span>
        </div>
      ))}
    </div>
  );
}
