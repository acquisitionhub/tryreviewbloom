// pages/api/reviews/index.js
// GET  /api/reviews              — list reviews with filter
// POST /api/reviews/reply        — generate + post AI reply
// POST /api/reviews/social       — trigger social post for a review

import { supabaseAdmin } from "../../../lib/supabase";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, res) {

  // ── GET — list reviews ──────────────────────────────────────────────────
  if (req.method === "GET") {
    const { rating, replied, limit = 20, offset = 0 } = req.query;

    let query = supabaseAdmin
      .from("reviews")
      .select("*, contacts(name, phone, service_tag)", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (rating) query = query.eq("rating", Number(rating));
    if (replied === "true")  query = query.eq("reply_posted", true);
    if (replied === "false") query = query.eq("reply_posted", false);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ reviews: data, total: count });
  }

  return res.status(405).end();
}

// ── /api/reviews/reply ──────────────────────────────────────────────────────
// Separate file — pages/api/reviews/reply.js
// POST body: { review_id, tone }
// Generates AI reply, optionally posts to Google

export async function replyHandler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { review_id, tone = "Friendly", post_to_google = false } = req.body;

  if (!review_id) return res.status(400).json({ error: "review_id required" });

  const { data: review } = await supabaseAdmin
    .from("reviews")
    .select("*")
    .eq("id", review_id)
    .single();

  if (!review) return res.status(404).json({ error: "Review not found" });

  const toneMap = {
    Friendly:     "warm, friendly, and conversational",
    Professional: "polished and professional",
    Brief:        "very brief (under 40 words)",
    Custom:       "natural and genuine",
  };

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    messages: [{
      role: "user",
      content: `Write a ${toneMap[tone] ?? "friendly"} Google review reply for a home service business. Do not be sycophantic. Sign off "— The Team".\n\nRating: ${review.rating}/5\nReview: "${review.text}"`,
    }],
  });

  const replyText = msg.content[0]?.text ?? "";

  // Update Supabase with the draft reply
  await supabaseAdmin
    .from("reviews")
    .update({ reply_text: replyText })
    .eq("id", review_id);

  // Optionally post immediately to Google
  if (post_to_google && review.google_review_id) {
    try {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id:process.env.GOOGLE_CLIENT_ID, client_secret:process.env.GOOGLE_CLIENT_SECRET, refresh_token:process.env.GOOGLE_REFRESH_TOKEN, grant_type:"refresh_token" }),
      });
      const { access_token } = await tokenRes.json();

      const url = `https://mybusiness.googleapis.com/v4/${process.env.GOOGLE_ACCOUNT_ID}/${process.env.GOOGLE_LOCATION_ID}/reviews/${review.google_review_id}/reply`;
      const postRes = await fetch(url, {
        method: "PUT",
        headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ comment: replyText }),
      });

      if (postRes.ok) {
        await supabaseAdmin
          .from("reviews")
          .update({ reply_posted: true, replied_at: new Date().toISOString() })
          .eq("id", review_id);
      }
    } catch (e) {
      console.error("Google reply failed:", e);
    }
  }

  return res.status(200).json({ reply: replyText, review_id });
}
