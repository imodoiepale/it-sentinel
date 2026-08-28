import { generateDailyReport } from "./report.service.js";
import { sendDailyDigest } from "./whatsapp.service.js";

/**
 * Runs the daily digest from inside the long-lived control-plane process
 * rather than via pg_cron + pg_net calling back into this service — Supabase's
 * cloud pg_cron cannot reach a `localhost` control plane, and pointing it at
 * an address that doesn't resolve from Supabase's network would be a
 * scheduled job that silently fails forever. Once control-plane is deployed
 * behind a real public URL, moving this to pg_cron+pg_net (calling
 * /v1/reports/daily/whatsapp) is a legitimate follow-on — this in-process
 * scheduler is the correct choice for the topology that actually exists
 * right now.
 */

const DIGEST_HOUR_UTC = Number(process.env.DAILY_DIGEST_HOUR_UTC ?? 5); // ~08:00 EAT
const DIGEST_RECIPIENTS = (process.env.DAILY_DIGEST_RECIPIENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const CHECK_INTERVAL_MS = 60_000;

let lastSentDateKey: string | null = null;

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function startDailyDigestScheduler() {
  if (DIGEST_RECIPIENTS.length === 0) {
    console.log("[scheduler] DAILY_DIGEST_RECIPIENTS not set — daily digest scheduling is idle");
    return;
  }

  setInterval(async () => {
    const now = new Date();
    const today = dateKey(now);
    if (now.getUTCHours() !== DIGEST_HOUR_UTC || lastSentDateKey === today) return;

    lastSentDateKey = today;
    try {
      const report = await generateDailyReport();
      for (const recipient of DIGEST_RECIPIENTS) {
        await sendDailyDigest(recipient, report);
      }
      console.log(`[scheduler] daily digest sent to ${DIGEST_RECIPIENTS.length} recipient(s)`);
    } catch (err) {
      console.error("[scheduler] daily digest failed:", err);
    }
  }, CHECK_INTERVAL_MS);
}
