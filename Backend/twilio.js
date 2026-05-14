// lib/twilio.js
// Thin wrapper around Twilio REST API for sending SMS

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// Interpolate message tokens: {{first_name}}, {{review_link}}, etc.
export function buildMessage(template, tokens = {}) {
  return Object.entries(tokens).reduce(
    (msg, [key, val]) => msg.replaceAll(`{{${key}}}`, val ?? ""),
    template
  );
}

// Send a single SMS via Twilio REST API
export async function sendSms({ to, body }) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64"),
    },
    body: new URLSearchParams({ To: to, From: FROM_NUMBER, Body: body }).toString(),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Twilio error ${data.code}: ${data.message}`);
  }

  return { sid: data.sid, status: data.status };
}
