// Shared helpers for the Stripe + Resend integration. Zero external dependencies.

export const cfg = () => {
  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  return {
    env: secretKey.startsWith('sk_live') ? 'live' : 'test',
    secretKey,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    resendKey: process.env.RESEND_API_KEY || '',
    fromEmail: process.env.FROM_EMAIL || 'Skills & Employment Australia <enrol@skillsemployment.com.au>',
    adminEmail: process.env.ADMIN_EMAIL || 'enrol@skillsemployment.com.au',
    siteUrl: (process.env.SITE_URL || 'https://skillsemployment.com.au').replace(/\/$/, ''),
    enrolAmount: 10000,      // Easy Start enrolment payment: $100.00 AUD in minor units
    installmentAmount: 7000, // Easy Start weekly payment: $70.00 AUD in minor units
    fullAmount: 40000,       // Pay in Full: $400.00 AUD in minor units
    weeklyCount: 5,          // number of $70 weekly payments after the $100 enrolment
    totalPayments: 6,        // 1 × $100 + 5 × $70 = $450
    // ---- Analytics stack (additive; safe if env vars missing) ----
    ga4MeasurementId: process.env.GA4_MEASUREMENT_ID || '',
    ga4ApiSecret:     process.env.GA4_API_SECRET || '',
    metaPixelId:      process.env.META_PIXEL_ID || '',
    metaAccessToken:  process.env.META_ACCESS_TOKEN || '',
    hubspotToken:     process.env.HUBSPOT_PRIVATE_APP_TOKEN || '',
    hubspotPipeline:  process.env.HUBSPOT_PIPELINE_ID || '2439332585',    // Intro to Care
    hubspotEnrolledStage: process.env.HUBSPOT_ENROLLED_STAGE_ID || '4036830946',
  };
};

// Minimal Stripe API client — form-encoded, zero dependencies.
// params is a flat object whose keys may use Stripe's bracket notation,
// e.g. { 'line_items[0][price_data][currency]': 'aud' }.
export async function stripe(path, { method = 'GET', params } = {}) {
  const c = cfg();
  let url = `https://api.stripe.com${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${c.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  };
  if (params) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) body.append(k, String(v));
    }
    if (method === 'GET') url += `?${body.toString()}`;
    else opts.body = body.toString();
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
  if (!res.ok) {
    const err = new Error(`Stripe ${method} ${path} -> ${res.status}: ${(json?.error?.message || text).slice(0, 400)}`);
    err.status = res.status;
    err.body = json || text;
    err.code = json?.error?.code;
    throw err;
  }
  return json;
}

export async function sendEmail({ to, subject, html, replyTo }) {
  const c = cfg();
  if (!c.resendKey) {
    console.warn('RESEND_API_KEY not set — email skipped:', subject, '->', to);
    return { skipped: true };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${c.resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: c.fromEmail,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  if (!res.ok) console.error('Resend error', res.status, await res.text());
  return { ok: res.ok };
}

// ---------- email templates ----------
const shell = (title, inner) => `<!DOCTYPE html><html><body style="margin:0;background:#F4F7F6;font-family:Arial,Helvetica,sans-serif;color:#102A33">
<div style="max-width:560px;margin:0 auto;padding:28px 20px">
  <div style="background:#102A33;border-radius:14px 14px 0 0;padding:22px 28px">
    <span style="color:#fff;font-weight:bold;font-size:17px">Skills &amp; Employment Australia</span>
  </div>
  <div style="background:#ffffff;border:1px solid #dde5e3;border-top:0;border-radius:0 0 14px 14px;padding:28px">
    <h1 style="font-size:20px;color:#102A33;margin:0 0 14px">${title}</h1>
    ${inner}
    <p style="font-size:13px;color:#4e646c;margin-top:26px">Questions? Just reply to this email or write to enrol@skillsemployment.com.au.<br>Skills &amp; Employment Australia — Level 7, 99 York St, Sydney NSW 2000</p>
  </div>
</div></body></html>`;

const p = (t) => `<p style="font-size:15px;line-height:1.6;margin:0 0 14px">${t}</p>`;
const box = (t) => `<div style="background:#F4F7F6;border-left:4px solid #0E6B6B;padding:14px 18px;border-radius:0 10px 10px 0;font-size:14px;line-height:1.6;margin:0 0 14px">${t}</div>`;

export function enrolmentConfirmedEmail({ name, plan }) {
  const first = (name || '').split(' ')[0] || 'there';
  if (plan === 'full') {
    return {
      subject: 'You’re enrolled! Entry into Care Roles Skill Set — paid in full',
      html: shell('Welcome aboard — you’re enrolled ✅', [
        p(`Hi ${first},`),
        p('Your payment of <strong>$400</strong> has been received and your place in the <strong>CHCSS00114 Entry into Care Roles Skill Set</strong> is confirmed.'),
        box('<strong>You’re paid in full, so your First Aid &amp; CPR component (HLTAID011) is unlocked.</strong> You can attend as soon as your online training is complete — we’ll be in touch with session details for your area.'),
        p('<strong>Your classes:</strong> live online, Monday–Wednesday, 9:00am–12:00pm, with intakes starting every Monday (Sydney time). Please note: you’ll need a computer with your camera on during classes (a compliance requirement), and at least 80% attendance to complete the skill set.'),
        p('We’ll email your class links and start details shortly. After the course, you’ll have a one-on-one session with our careers consultant — and every unit you complete credits toward the CHC33021 Certificate III in Individual Support.'),
      ].join('')),
    };
  }
  return {
    subject: 'You’re enrolled! Entry into Care Roles Skill Set — Easy Start Plan',
    html: shell('Welcome aboard — you’re enrolled ✅', [
      p(`Hi ${first},`),
      p('Your enrolment payment of <strong>$100</strong> has been received and your place in the <strong>CHCSS00114 Entry into Care Roles Skill Set</strong> is confirmed. Your online training starts straight away.'),
      p('<strong>Your Easy Start Plan:</strong> $100 paid today, then 5 easy weekly payments of $70 ($450 total). The weekly payments are charged automatically to the same card, one week apart.'),
      box('<strong>Reminder:</strong> your First Aid &amp; CPR component (HLTAID011) unlocks once your course fees are paid in full — that’s right after your 5th and final $70 payment. We’ll email you the moment it clears.'),
      p('<strong>Your classes:</strong> live online, Monday–Wednesday, 9:00am–12:00pm, with intakes starting every Monday (Sydney time). Please note: you’ll need a computer with your camera on during classes (a compliance requirement), and at least 80% attendance to complete the skill set.'),
      p('We’ll email your class links and start details shortly.'),
    ].join('')),
  };
}

export function installmentReceiptEmail({ name, weeklyNo, weeklyTotal }) {
  const first = (name || '').split(' ')[0] || 'there';
  const left = weeklyTotal - weeklyNo;
  return {
    subject: `Weekly payment ${weeklyNo} of ${weeklyTotal} received — $70`,
    html: shell(`Weekly payment ${weeklyNo} of ${weeklyTotal} received`, [
      p(`Hi ${first},`),
      p(`We’ve received your Easy Start weekly payment of <strong>$70</strong> (${weeklyNo} of ${weeklyTotal}).`),
      p(`Remaining: <strong>${left} payment${left === 1 ? '' : 's'}</strong>. Your First Aid &amp; CPR component unlocks after your final payment.`),
    ].join('')),
  };
}

export function firstAidUnlockedEmail({ name }) {
  const first = (name || '').split(' ')[0] || 'there';
  return {
    subject: '🎉 Paid in full — your First Aid & CPR is unlocked',
    html: shell('Paid in full — First Aid & CPR unlocked 🎉', [
      p(`Hi ${first},`),
      p('Your final payment has cleared — your course fees are now <strong>paid in full</strong>.'),
      box('<strong>Your First Aid &amp; CPR component (HLTAID011) is now unlocked.</strong> Once your online training is complete you can attend the in-person session — we’ll contact you with details for your area, or reply to this email to lock in a date.'),
      p('After First Aid &amp; CPR, don’t forget your one-on-one careers consultation — we’ll help you map the path into the industry, including crediting your units toward the CHC33021 Certificate III in Individual Support.'),
    ].join('')),
  };
}

export function paymentFailedEmail({ name, weeklyNo, weeklyTotal }) {
  const first = (name || '').split(' ')[0] || 'there';
  return {
    subject: 'Action needed — your weekly course payment didn’t go through',
    html: shell('Your weekly payment didn’t go through', [
      p(`Hi ${first},`),
      p(`We tried to process Easy Start weekly payment ${weeklyNo} of ${weeklyTotal} ($70) for your Entry into Care Roles Skill Set, but it didn’t go through.`),
      p('This is usually a card limit or expiry issue. We’ll automatically retry tomorrow — or reply to this email and we’ll sort it out together.'),
      box('Remember: your First Aid &amp; CPR component unlocks once all payments are complete.'),
    ].join('')),
  };
}

export function adminNotifyEmail(subject, lines) {
  return {
    subject: `[Enrolments] ${subject}`,
    html: shell(subject, lines.map((l) => p(l)).join('')),
  };
}

export const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
});

// =====================================================================
// ANALYTICS HELPERS — added 2026-07-23
// All fire-and-forget: analytics failure never affects payments or emails.
// =====================================================================

import crypto_ref from 'node:crypto';

const _sha256 = (s) => {
  if (!s) return null;
  return crypto_ref.createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex');
};

// Fire a GA4 event via the Measurement Protocol.
// clientId should be the browser's _ga cookie tail (or a stable server-generated fallback).
export async function ga4Send({ clientId, name, params }) {
  const c = cfg();
  if (!c.ga4MeasurementId || !c.ga4ApiSecret) return { skipped: true, reason: 'ga4 not configured' };
  if (!clientId) return { skipped: true, reason: 'no clientId' };
  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(c.ga4MeasurementId)}&api_secret=${encodeURIComponent(c.ga4ApiSecret)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        non_personalized_ads: false,
        events: [{ name, params: params || {} }],
      }),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    console.warn('GA4 MP failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// Fire a Meta Conversions API event.
// eventId enables client-server deduplication — pass the Stripe payment/session id.
export async function metaCapiSend({ eventName, eventId, value, currency = 'AUD', email, phone, firstName, lastName, fbp, fbc, ua, contentCategory }) {
  const c = cfg();
  if (!c.metaPixelId || !c.metaAccessToken) return { skipped: true, reason: 'meta CAPI not configured' };
  const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(c.metaPixelId)}/events?access_token=${encodeURIComponent(c.metaAccessToken)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [{
          event_name: eventName,
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventId,
          action_source: 'website',
          event_source_url: 'https://skillsemployment.com.au/',
          user_data: {
            em: _sha256(email),
            ph: _sha256((phone || '').replace(/[^\d]/g, '')),
            fn: _sha256(firstName),
            ln: _sha256(lastName),
            fbp: fbp || null,
            fbc: fbc || null,
            client_user_agent: ua || null,
          },
          custom_data: {
            value: value,
            currency,
            content_name: 'CHCSS00114 Enrolment',
            content_category: contentCategory || 'unspecified',
          },
        }],
      }),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    console.warn('Meta CAPI failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// HubSpot: upsert Contact + create Deal in Intro to Care → Enrolled.
export async function hubspotUpsertEnrolment({ email, firstName, lastName, phone, plan, amount, location, startDate, usi, message }) {
  const c = cfg();
  if (!c.hubspotToken || !email) return { skipped: true };
  const auth = { Authorization: `Bearer ${c.hubspotToken}`, 'Content-Type': 'application/json' };
  try {
    // 1. Search for existing contact by email
    const findRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        properties: ['email'],
        limit: 1,
      }),
    }).then((r) => r.json()).catch(() => ({ results: [] }));

    const contactProps = {
      firstname: firstName || '',
      lastname:  lastName  || '',
      phone:     phone     || '',
      preferred_location:   location  || '',
      preferred_start_date: startDate || '',
      usi: usi || '',
      payment_plan: plan || '',
    };

    let contactId;
    if (findRes.results && findRes.results[0]) {
      contactId = findRes.results[0].id;
      await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`, {
        method: 'PATCH', headers: auth,
        body: JSON.stringify({ properties: contactProps }),
      });
    } else {
      const createRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ properties: { email, lifecyclestage: 'customer', ...contactProps } }),
      }).then((r) => r.json());
      contactId = createRes.id;
    }

    if (!contactId) return { ok: false, reason: 'no contactId' };

    // 2. Create Deal at Enrolled stage, associated to contact
    const dealName = `${firstName || 'Enrolment'} ${lastName || ''} — CHCSS00114 (${plan})`.trim();
    const dealRes = await fetch('https://api.hubapi.com/crm/v3/objects/deals', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        properties: {
          dealname:  dealName,
          pipeline:  c.hubspotPipeline,
          dealstage: c.hubspotEnrolledStage,
          amount:    String(amount || 0),
          deal_currency_code: 'AUD',
          payment_plan:         plan,
          preferred_location:   location  || '',
          preferred_start_date: startDate || '',
          description: message || '',
        },
        associations: [{
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
        }],
      }),
    }).then((r) => r.json());

    return { ok: true, contactId, dealId: dealRes.id };
  } catch (e) {
    console.warn('HubSpot upsert failed:', e.message);
    return { ok: false, error: e.message };
  }
}
