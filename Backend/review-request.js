// pages/api/webhook/review-request.js
//
// GHL calls this endpoint when a job is marked complete.
// Flow:
//   1. Verify the webhook signature from GHL
//   2. Upsert the contact into Supabase
//   3. Check cooldown — skip if contact is in cooldown window
//   4. Schedule the initial SMS (sent after `initial_delay_hours`)
//   5. Schedule follow-up 1 and follow-up 2
//   6. Log the activity

import { supabaseAdmin } from "../../../lib/supabase";
import { sendSms, buildMessage } from "../../../lib/twilio";
import crypto from "crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  // ── 1. Verify GHL webhook signature ────────────────────────────────────
  const signature = req.headers["x-ghl-signature"] ?? "";
  const expected  = crypto
    .createHmac("sha256", process.env.GHL_WEBHOOK_SECRET)
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (signature !== expected) {
    console.error("Invalid GHL webhook signature");
    return res.status(401).json({ error: "Invalid signature" });
  }

  // ── 2. Parse GHL payload ────────────────────────────────────────────────
  // GHL sends contact fields — adjust keys to match your GHL field names
  const {
    contactId,
    firstName,
    lastName,
    phone,
    email,
    customFields = {},
  } = req.body;

  const name       = `${firstName ?? ""} ${lastName ?? ""}`.trim();
  const serviceTag = customFields.service_type ?? "service";

  if (!phone) {
    return res.status(400).json({ error: "No phone number in payload" });
  }

  // ── 3. Upsert contact ───────────────────────────────────────────────────
  const { data: contact, error: upsertErr } = await supabaseAdmin
    .from("contacts")
    .upsert(
      { ghl_contact_id: contactId, name, phone, email, service_tag: serviceTag, last_job_date: new Date().toISOString().split("T")[0], source: "ghl" },
      { onConflict: "ghl_contact_id" }
    )
    .select()
    .single();

  if (upsertErr) {
    console.error("Upsert contact failed:", upsertErr);
    return res.status(500).json({ error: "DB error" });
  }

  // ── 4. Cooldown check ───────────────────────────────────────────────────
  if (contact.cooldown_until && new Date(contact.cooldown_until) > new Date()) {
    console.log(`Contact ${contact.id} is in cooldown until ${contact.cooldown_until}`);
    return res.status(200).json({ skipped: true, reason: "cooldown" });
  }

  // Already reviewed — don't re-request
  if (contact.status === "reviewed") {
    return res.status(200).json({ skipped: true, reason: "already_reviewed" });
  }

  // ── 5. Load workflow settings and message template ──────────────────────
  const { data: settings } = await supabaseAdmin
    .from("workflow_settings")
    .select("*")
    .eq("name", "review_request")
    .single();

  if (!settings?.active || settings?.all_paused) {
    return res.status(200).json({ skipped: true, reason: "workflow_paused" });
  }

  const { data: template } = await supabaseAdmin
    .from("message_templates")
    .select("*")
    .eq("type", "initial")
    .eq("channel", "sms")
    .eq("active", true)
    .single();

  // ── 6. Schedule and send initial SMS ───────────────────────────────────
  const delayMs    = (settings.initial_delay_hours ?? 2) * 60 * 60 * 1000;
  const scheduledAt = new Date(Date.now() + delayMs);

  const messageBody = buildMessage(template?.body ?? "Hi {{first_name}}, please leave us a review: {{review_link}}", {
    first_name:    firstName ?? name,
    review_link:   process.env.REVIEW_LINK,
    owner_name:    template?.owner_name ?? "The Team",
    business_name: template?.business_name ?? "Us",
  });

  // Insert the scheduled request record
  await supabaseAdmin.from("review_requests").insert({
    contact_id:   contact.id,
    type:         "initial",
    channel:      "sms",
    status:       "scheduled",
    scheduled_at: scheduledAt.toISOString(),
    message_body: messageBody,
  });

  // For production: use a queue (Inngest / Vercel Cron / Supabase Edge Function)
  // For simplicity here we send immediately if delay < 1 min (useful for testing)
  if (delayMs < 60_000) {
    const { sid } = await sendSms({ to: phone, body: messageBody });
    await supabaseAdmin
      .from("review_requests")
      .update({ status: "sent", sent_at: new Date().toISOString(), twilio_sid: sid })
      .eq("contact_id", contact.id)
      .eq("type", "initial");
    await supabaseAdmin.from("contacts").update({ status: "contacted" }).eq("id", contact.id);
  }

  // ── 7. Schedule follow-ups ──────────────────────────────────────────────
  const fu1Template = await supabaseAdmin.from("message_templates").select("*").eq("type","followup-1").eq("channel","sms").single();
  const fu2Template = await supabaseAdmin.from("message_templates").select("*").eq("type","followup-2").eq("channel","sms").single();

  const fu1Body = buildMessage(fu1Template?.data?.body ?? "Hi {{first_name}}, gentle reminder — {{review_link}}", { first_name:firstName??name, review_link:process.env.REVIEW_LINK, business_name:template?.business_name??"Us" });
  const fu2Body = buildMessage(fu2Template?.data?.body ?? "Hi {{first_name}}, last reminder — {{review_link}}", { first_name:firstName??name, review_link:process.env.REVIEW_LINK, business_name:template?.business_name??"Us" });

  await supabaseAdmin.from("review_requests").insert([
    { contact_id:contact.id, type:"followup-1", channel:"sms", status:"scheduled", scheduled_at:new Date(Date.now()+(settings.followup1_delay_hours??48)*3600000).toISOString(), message_body:fu1Body },
    { contact_id:contact.id, type:"followup-2", channel:"sms", status:"scheduled", scheduled_at:new Date(Date.now()+(settings.followup2_delay_hours??120)*3600000).toISOString(), message_body:fu2Body },
  ]);

  // ── 8. Activity log ─────────────────────────────────────────────────────
  await supabaseAdmin.from("activity_log").insert({
    type:       "review_request_scheduled",
    contact_id: contact.id,
    metadata:   { ghl_contact_id: contactId, phone, scheduled_at: scheduledAt },
  });

  return res.status(200).json({ success: true, contact_id: contact.id, scheduled_at: scheduledAt });
}
