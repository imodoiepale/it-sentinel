import { DailyReport, formatDailyReportText } from "./report.service.js";

/**
 * WhatsApp Business Cloud API client. This is a genuine, correctly-shaped
 * integration against Meta's documented API — but it requires a real
 * WhatsApp Business Account, phone number ID, and access token that don't
 * exist yet for this deployment. WHATSAPP_ACCESS_TOKEN /
 * WHATSAPP_PHONE_NUMBER_ID are read from env and this module no-ops with a
 * clear log line if they're unset, rather than silently pretending to
 * send. Per the plan: WhatsApp is a notification channel only — never the
 * system of record, and never a channel for credentials or footage. Every
 * function here sends a link back to the portal rather than raw sensitive
 * detail.
 */

const WHATSAPP_API_VERSION = "v21.0";
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const PORTAL_URL = process.env.PORTAL_URL ?? "https://it-sentinel.internal";

function configured(): boolean {
  return Boolean(ACCESS_TOKEN && PHONE_NUMBER_ID);
}

async function sendText(toE164: string, body: string): Promise<{ sent: boolean; reason?: string }> {
  if (!configured()) {
    console.warn("[whatsapp] WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID not set — message NOT sent:\n", body);
    return { sent: false, reason: "not_configured" };
  }

  const res = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toE164,
      type: "text",
      text: { body },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error(`[whatsapp] send failed (${res.status}):`, detail);
    return { sent: false, reason: `http_${res.status}` };
  }
  return { sent: true };
}

export async function sendP1Alert(args: {
  toE164: string;
  branchName: string;
  title: string;
  ownerName: string;
  incidentId: string;
}) {
  const body =
    `P1 ALERT  IT Sentinel: P1 • ${args.branchName} • ${args.title}. ` +
    `Owner: ${args.ownerName}. View: ${PORTAL_URL}/incidents/${args.incidentId}`;
  return sendText(args.toE164, body);
}

export async function sendDailyDigest(toE164: string, report: DailyReport) {
  const body = `${formatDailyReportText(report)}\n\nDetails: ${PORTAL_URL}/reports/daily`;
  return sendText(toE164, body);
}
