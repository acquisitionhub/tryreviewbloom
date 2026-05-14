// pages/api/post-social.js
//
// POST /api/post-social
// Body: { review_id?, platform, caption, image_url?, location_id? }
//
// Posts a review card to Facebook Page or Instagram Business Account
// via the Meta Graph API.

import { supabaseAdmin } from "../../lib/supabase";

const META_VERSION = "v19.0";
const BASE = `https://graph.facebook.com/${META_VERSION}`;

// ── Upload image to Facebook CDN (required for both IG and FB posts) ─────────
async function uploadImageUrl(imageUrl, pageAccessToken, pageId) {
  const res = await fetch(`${BASE}/${pageId}/photos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: imageUrl,
      published: false,               // unpublished — we publish separately
      access_token: pageAccessToken,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`FB photo upload failed: ${JSON.stringify(data)}`);
  return data.id; // photo ID
}

// ── Post to Facebook Page ────────────────────────────────────────────────────
async function postToFacebook({ caption, imageUrl, pageId, pageAccessToken }) {
  let body = { message: caption, access_token: pageAccessToken };

  if (imageUrl) {
    const photoId = await uploadImageUrl(imageUrl, pageAccessToken, pageId);
    body.attached_media = [{ media_fbid: photoId }];
  }

  const res = await fetch(`${BASE}/${pageId}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`FB post failed: ${JSON.stringify(data)}`);
  return data.id;
}

// ── Post to Instagram ────────────────────────────────────────────────────────
async function postToInstagram({ caption, imageUrl, igAccountId, pageAccessToken }) {
  if (!imageUrl) throw new Error("Instagram requires an image_url");

  // Step 1: Create media container
  const containerRes = await fetch(`${BASE}/${igAccountId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_url: imageUrl, caption, access_token: pageAccessToken }),
  });
  const container = await containerRes.json();
  if (!containerRes.ok) throw new Error(`IG container failed: ${JSON.stringify(container)}`);

  // Step 2: Publish the container
  const publishRes = await fetch(`${BASE}/${igAccountId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: container.id, access_token: pageAccessToken }),
  });
  const published = await publishRes.json();
  if (!publishRes.ok) throw new Error(`IG publish failed: ${JSON.stringify(published)}`);

  return published.id;
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const {
    review_id,
    platform = "instagram",   // 'instagram' | 'facebook'
    caption,
    image_url,
    location_id,              // optional — post to specific location's page
  } = req.body;

  if (!caption) return res.status(400).json({ error: "caption is required" });

  // Fetch location config if specified (different pages per location)
  let pageAccessToken = process.env.META_PAGE_ACCESS_TOKEN;
  let pageId          = process.env.META_FACEBOOK_PAGE_ID;
  let igAccountId     = process.env.META_INSTAGRAM_ACCOUNT_ID;

  if (location_id) {
    const { data: loc } = await supabaseAdmin
      .from("locations")
      .select("*")
      .eq("id", location_id)
      .single();
    if (loc?.page_id) pageId = loc.page_id;
  }

  let platformPostId;

  try {
    if (platform === "facebook") {
      platformPostId = await postToFacebook({ caption, imageUrl: image_url, pageId, pageAccessToken });
    } else {
      platformPostId = await postToInstagram({ caption, imageUrl: image_url, igAccountId, pageAccessToken });
    }
  } catch (err) {
    console.error("Social post failed:", err.message);
    if (review_id) {
      await supabaseAdmin.from("social_posts").update({ status: "failed" }).eq("review_id", review_id).eq("platform", platform);
    }
    return res.status(502).json({ error: err.message });
  }

  // Update DB record
  if (review_id) {
    await supabaseAdmin
      .from("social_posts")
      .update({ status: "posted", posted_at: new Date().toISOString(), platform_post_id: platformPostId })
      .eq("review_id", review_id)
      .eq("platform", platform);

    await supabaseAdmin
      .from("reviews")
      .update({ social_posted: true })
      .eq("id", review_id);
  }

  await supabaseAdmin.from("activity_log").insert({
    type:      "social_post_published",
    review_id: review_id ?? null,
    metadata:  { platform, platformPostId },
  });

  return res.status(200).json({ success: true, platform_post_id: platformPostId });
}
