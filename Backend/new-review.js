// pages/api/webhook/new-review.js
//
// GHL fires this when a new Google review is received.
// Flow:
//   1. Save review to Supabase
//   2. Mark contact as "reviewed" + set cooldown
//   3. Generate AI reply via Anthropic
//   4. Post reply to Google Business Profile
//   5. Trigger social post creation (if 5 stars)
//   6. Log activity

import { supabaseAdmin } from "../../../lib/supabase";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateReply(reviewText, rating) {
  const tone = rating >= 5 ? "warm and enthusiastic" : rating >= 4 ? "friendly and appreciative" : "understanding and constructive";
  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    messages: [{
      role: "user",
      content: `Write a ${tone} Google review reply for a home service business. Under 80 words. Be genuine. Do not be sycophantic. Sign off "— The Team".\n\nRating: ${rating}/5\nReview: "${reviewText}"`,
    }],
  });
  return msg.content[0]?.text ?? "";
}

async function postReplyToGoogle(googleReviewId, replyText) {
  // Google My Business API — post reply
  // Requires a valid access token (refresh via OAuth before calling)
  const accessToken = await getGoogleAccessToken();
  const url = `https://mybusiness.googleapis.com/v4/${process.env.GOOGLE_ACCOUNT_ID}/${process.env.GOOGLE_LOCATION_ID}/reviews/${googleReviewId}/reply`;

  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ comment: replyText }),
  });

  return res.ok;
}

async function getGoogleAccessToken() {
  // Refresh the OAuth token using the stored refresh token
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type:    "refresh_token",
    }),
  });
  const data = await res.json();
  return data.access_token;
}

async function createSocialPost(review, replyText) {
  // Insert a social post record — actual posting handled by /api/post-social
  await supabaseAdmin.from("social_posts").insert({
    review_id:     review.id,
    platform:      "instagram",
    template_type: "quote",
    caption:       `⭐⭐⭐⭐⭐ "${review.text.slice(0, 100)}…" — ${review.reviewer_name}`,
    status:        "scheduled",
    scheduled_at:  new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min from now
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  // GHL reputation webhook payload
  const { reviewId, reviewerName, rating, comment, contactId } = req.body;

  if (!reviewId) return res.status(400).json({ error: "Missing reviewId" });

  // ── 1. Save review ──────────────────────────────────────────────────────
  // Find matching contact by GHL contact ID
  const { data: contact } = await supabaseAdmin
    .from("contacts")
    .select("id")
    .eq("ghl_contact_id", contactId)
    .maybeSingle();

  const { data: review, error } = await supabaseAdmin
    .from("reviews")
    .upsert({
      contact_id:       contact?.id ?? null,
      reviewer_name:    reviewerName,
      rating:           parseInt(rating),
      text:             comment,
      platform:         "google",
      google_review_id: reviewId,
    }, { onConflict: "google_review_id" })
    .select()
    .single();

  if (error) {
    console.error("Save review error:", error);
    return res.status(500).json({ error: "DB error" });
  }

  // ── 2. Mark contact as reviewed + set cooldown ──────────────────────────
  if (contact?.id) {
    const { data: wf } = await supabaseAdmin.from("workflow_settings").select("cooldown_days").eq("name","review_request").single();
    const cooldownDays = wf?.cooldown_days ?? 30;
    const cooldownUntil = new Date(Date.now() + cooldownDays * 86400000).toISOString();

    await supabaseAdmin
      .from("contacts")
      .update({ status: "reviewed", cooldown_until: cooldownUntil })
      .eq("id", contact.id);

    // Cancel any pending follow-up requests for this contact
    await supabaseAdmin
      .from("review_requests")
      .update({ status: "cancelled" })
      .eq("contact_id", contact.id)
      .eq("status", "scheduled");
  }

  // ── 3. Generate AI reply ────────────────────────────────────────────────
  const { data: aiSettings } = await supabaseAdmin.from("workflow_settings").select("active").eq("name","ai_reply").single();

  let replyText = null;
  let replyPosted = false;

  if (aiSettings?.active && review.text) {
    try {
      replyText = await generateReply(review.text, review.rating);
    } catch (e) {
      console.error("AI reply generation failed:", e);
    }
  }

  // ── 4. Post reply to Google ─────────────────────────────────────────────
  if (replyText && reviewId) {
    try {
      replyPosted = await postReplyToGoogle(reviewId, replyText);
      if (replyPosted) {
        await supabaseAdmin
          .from("reviews")
          .update({ reply_text: replyText, replied_at: new Date().toISOString(), reply_posted: true })
          .eq("id", review.id);
      }
    } catch (e) {
      console.error("Post reply to Google failed:", e);
    }
  }

  // ── 5. Schedule social post (5-star only) ───────────────────────────────
  const { data: socialSettings } = await supabaseAdmin.from("workflow_settings").select("active").eq("name","social_post").single();

  if (socialSettings?.active && review.rating >= 5) {
    await createSocialPost(review, replyText);
  }

  // ── 6. Log ──────────────────────────────────────────────────────────────
  await supabaseAdmin.from("activity_log").insert({
    type:      "review_received",
    review_id: review.id,
    contact_id: contact?.id ?? null,
    metadata:  { rating: review.rating, reply_posted: replyPosted, reviewer: reviewerName },
  });

  return res.status(200).json({
    success: true,
    review_id: review.id,
    reply_generated: !!replyText,
    reply_posted: replyPosted,
  });
}
