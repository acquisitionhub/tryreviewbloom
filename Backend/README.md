# Review Bloom — Full Backend Setup Guide

## Stack
- **Frontend**: Next.js + React (your dashboard JSX)
- **Database**: Supabase (Postgres)
- **SMS**: Twilio
- **AI**: Anthropic Claude
- **Social**: Meta Graph API
- **Reviews**: Google My Business API
- **Hosting**: Vercel

---

## Step 1 — Create a Next.js project

```bash
npx create-next-app@latest review-bloom
cd review-bloom
npm install @supabase/supabase-js @anthropic-ai/sdk papaparse recharts
```

Copy your dashboard JSX into `pages/index.jsx` (or `app/page.jsx` for App Router).
Copy all API route files from this folder into `pages/api/`.
Copy the `lib/` folder into your project root.

---

## Step 2 — Set up Supabase

1. Go to **supabase.com** → New Project
2. Open **SQL Editor** → paste and run `supabase/schema.sql`
3. Copy your keys from **Project Settings → API**:
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` → `SUPABASE_SERVICE_ROLE_KEY`

---

## Step 3 — Set up Twilio (SMS)

1. Go to **console.twilio.com** → get a phone number (~$1/mo)
2. Copy:
   - Account SID → `TWILIO_ACCOUNT_SID`
   - Auth Token → `TWILIO_AUTH_TOKEN`
   - Phone number → `TWILIO_PHONE_NUMBER` (format: +14155551234)

---

## Step 4 — Connect GHL webhooks

In **GHL → Automation → Workflows**:

### Workflow 1: Job Complete → Review Request
```
Trigger: Appointment status changed to "completed"  
         OR Invoice status changed to "paid"
Action:  Webhook (HTTP POST)
URL:     https://your-app.vercel.app/api/webhook/review-request
Method:  POST
Body:    {
           "contactId":  "{{contact.id}}",
           "firstName":  "{{contact.first_name}}",
           "lastName":   "{{contact.last_name}}",
           "phone":      "{{contact.phone}}",
           "email":      "{{contact.email}}",
           "customFields": { "service_type": "{{contact.tags}}" }
         }
```

### Workflow 2: New Google Review
```
Trigger: Reputation Management → New Review
Action:  Webhook (HTTP POST)
URL:     https://your-app.vercel.app/api/webhook/new-review
Body:    {
           "reviewId":     "{{review.id}}",
           "reviewerName": "{{review.reviewer_name}}",
           "rating":       "{{review.rating}}",
           "comment":      "{{review.comment}}",
           "contactId":    "{{contact.id}}"
         }
```

Set `GHL_WEBHOOK_SECRET` to match what you put in your GHL webhook headers.

---

## Step 5 — Google Business Profile API

1. Go to **console.cloud.google.com** → Create project
2. Enable **My Business Business Information API** and **My Business Reviews API**
3. Create OAuth 2.0 credentials
4. Run the OAuth flow once to get a refresh token:
   ```bash
   # Use oauth2l or the OAuth playground:
   # https://developers.google.com/oauthplayground
   # Scope: https://www.googleapis.com/auth/business.manage
   ```
5. Set `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
6. Find your account/location IDs:
   ```
   GET https://mybusinessbusinessinformation.googleapis.com/v1/accounts
   GET https://mybusinessbusinessinformation.googleapis.com/v1/{account}/locations
   ```

---

## Step 6 — Meta API (Facebook + Instagram)

1. Go to **developers.facebook.com** → Create App → Business
2. Add **Instagram Graph API** and **Pages API** products
3. Get a Page Access Token (long-lived):
   ```
   GET /oauth/access_token?client_id=APP_ID&client_secret=APP_SECRET
       &grant_type=fb_exchange_token&fb_exchange_token=SHORT_LIVED_TOKEN
   ```
4. Set:
   - `META_PAGE_ACCESS_TOKEN`
   - `META_FACEBOOK_PAGE_ID`
   - `META_INSTAGRAM_ACCOUNT_ID` (from GET /me/accounts)

---

## Step 7 — Deploy to Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# Add environment variables
cp .env.example .env.local
# Fill in all values in .env.local

# Deploy
vercel deploy

# Add env vars to Vercel dashboard (Settings → Environment Variables)
# or use:
vercel env add TWILIO_ACCOUNT_SID
# (repeat for each variable)
```

The cron job (`/api/cron/send-scheduled`) runs every 15 minutes automatically on Vercel Pro.
For the free tier, use a free cron service like **cron-job.org** to call that endpoint.

---

## Webhook Endpoints Reference

| Endpoint | Trigger | Called by |
|---|---|---|
| `POST /api/webhook/review-request` | Job complete | GHL Workflow |
| `POST /api/webhook/new-review` | New Google review | GHL Reputation |
| `GET /api/contacts` | List contacts | Dashboard |
| `POST /api/contacts` | Add contact | Dashboard |
| `POST /api/contacts?bulk=1` | CSV import | Dashboard |
| `GET /api/reviews` | List reviews | Dashboard |
| `POST /api/reviews/reply` | AI reply | Dashboard |
| `POST /api/post-social` | Post to FB/IG | Dashboard / auto |
| `GET /api/cron/send-scheduled` | Send due SMS | Vercel Cron |

---

## Data Flow Diagram

```
Job Complete (GHL)
       │
       ▼
POST /api/webhook/review-request
       │
       ├─► Upsert contact (Supabase)
       ├─► Check cooldown
       ├─► Schedule SMS requests (Supabase)
       └─► Cron runs every 15 min → sends SMS (Twilio)
                                          │
                                          ▼
                                Customer gets SMS
                                          │
                                 Leaves Google review
                                          │
                                          ▼
POST /api/webhook/new-review (GHL fires)
       │
       ├─► Save review (Supabase)
       ├─► Mark contact reviewed + set cooldown
       ├─► Generate AI reply (Anthropic)
       ├─► Post reply to Google
       └─► Schedule social post
                  │
                  ▼
       POST /api/post-social
       ├─► Facebook Page post
       └─► Instagram Business post
```
