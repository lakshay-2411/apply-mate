/**
 * Runs once when a Next.js server instance boots. Starts a background
 * poller that sends due scheduled campaigns while the server is running —
 * this covers local/self-hosted use. On serverless (e.g. Vercel) this
 * long-lived interval doesn't apply; the /api/cron route + a cron schedule
 * (see vercel.json) does the same job there.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const g = globalThis as typeof globalThis & {
    __applyMateSchedulerStarted?: boolean;
  };
  if (g.__applyMateSchedulerStarted) return;
  g.__applyMateSchedulerStarted = true;

  const { processDueCampaigns } = await import("./lib/scheduler");
  const run = async () => {
    try {
      const { processed, failed } = await processDueCampaigns();
      if (processed || failed) {
        console.log(
          `[scheduler] sent ${processed} scheduled campaign(s), ${failed} failed`
        );
      }
    } catch (err) {
      // Missing env vars (e.g. during setup) or transient errors — try again
      // on the next tick rather than crashing the server.
      console.error("[scheduler]", err instanceof Error ? err.message : err);
    }
  };

  // Catch up shortly after boot (campaigns missed while the server was off),
  // then poll every minute.
  setTimeout(run, 5_000);
  setInterval(run, 60_000);
}
