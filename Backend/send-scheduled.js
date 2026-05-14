// pages/api/cron/send-scheduled.js
//
// Vercel Cron — runs every 15 minutes
// Add to vercel.json:
// {
//   "crons": [{ "path": "/api/cron/send-scheduled", "schedule": "*/15 * * * *" }]
// }
//
// Picks up any review_requests with status='scheduled'
// and scheduled_at <= now(), then sends the SMS.

import { supabaseAdmin } from "../../../lib/supabase";
import { sendSms } from "../../../lib/twilio";

export default async function handler(req, res) {
  // Protect the cron endpoint — Vercel sets this header automatically
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end("Unauthorized");
  }

  // ── Fetch due requests ──────────────────────────────────────────────────
  const { data: due, error } = await supabaseAdmin
    .from("review_requests")
    .select("*, contacts(name, phone, status, cooldown_until)")
    .eq("status", "scheduled")
    .lte("scheduled_at", new Date().toISOString())
    .limit(50); // process max 50 per run

  if (error) {
    console.error("Fetch due requests error:", error);
    return res.status(500).json({ error: error.message });
  }

  if (!due?.length) {
    return res.status(200).json({ processed: 0 });
  }

  // Check global pause
  const { data: wf } = await supabaseAdmin
    .from("workflow_settings")
    .select("all_paused")
    .eq("name", "review_request")
    .single();

  if (wf?.all_paused) {
    return res.status(200).json({ skipped: true, reason: "all_paused" });
  }

  const results = [];

  for (const req of due) {
    const contact = req.contacts;

    // Skip if contact already reviewed
    if (contact?.status === "reviewed") {
      await supabaseAdmin.from("review_requests").update({ status: "cancelled" }).eq("id", req.id);
      results.push({ id: req.id, skipped: "already_reviewed" });
      continue;
    }

    // Skip if contact in cooldown
    if (contact?.cooldown_until && new Date(contact.cooldown_until) > new Date()) {
      await supabaseAdmin.from("review_requests").update({ status: "cancelled" }).eq("id", req.id);
      results.push({ id: req.id, skipped: "cooldown" });
      continue;
    }

    // Skip if no phone
    if (!contact?.phone) {
      await supabaseAdmin.from("review_requests").update({ status: "failed" }).eq("id", req.id);
      results.push({ id: req.id, skipped: "no_phone" });
      continue;
    }

    // Send SMS
    try {
      const { sid } = await sendSms({ to: contact.phone, body: req.message_body });

      await supabaseAdmin
        .from("review_requests")
        .update({ status: "sent", sent_at: new Date().toISOString(), twilio_sid: sid })
        .eq("id", req.id);

      // Update contact status to 'contacted' if still pending
      if (contact.status === "pending") {
        await supabaseAdmin
          .from("contacts")
          .update({ status: "contacted" })
          .eq("id", req.contact_id);
      }

      await supabaseAdmin.from("activity_log").insert({
        type:       `sms_sent_${req.type}`,
        contact_id: req.contact_id,
        metadata:   { twilio_sid: sid, type: req.type },
      });

      results.push({ id: req.id, sent: true, sid });
    } catch (e) {
      console.error(`SMS send failed for request ${req.id}:`, e.message);
      await supabaseAdmin.from("review_requests").update({ status: "failed" }).eq("id", req.id);
      results.push({ id: req.id, error: e.message });
    }
  }

  return res.status(200).json({ processed: results.length, results });
}
