// POST /.netlify/functions/stripe-webhook
// Stripe webhook endpoint. Register in Stripe Dashboard → Developers → Webhooks for events:
//   checkout.session.completed, payment_intent.succeeded, payment_intent.payment_failed
// Verifies the Stripe-Signature header, then sends the right emails automatically.
import crypto from 'node:crypto';
import {
  cfg, sendEmail, json,
  enrolmentConfirmedEmail, installmentReceiptEmail, firstAidUnlockedEmail,
  paymentFailedEmail, adminNotifyEmail,
  ga4Send, metaCapiSend, hubspotUpsertEnrolment,
} from './lib.mjs';

function verifySignature(event, secret) {
  if (!secret) return { ok: false, reason: 'STRIPE_WEBHOOK_SECRET not set' };
  const header = event.headers['stripe-signature'] || event.headers['Stripe-Signature'] || '';
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=').map((s) => s.trim())).filter((p) => p.length === 2));
  if (!parts.t || !parts.v1) return { ok: false, reason: 'missing signature header parts' };
  // Reject stale events (>5 min) to limit replay
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return { ok: false, reason: 'timestamp too old' };
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${event.body}`).digest('hex');
  const provided = header.split(',').filter((s) => s.trim().startsWith('v1=')).map((s) => s.trim().slice(3));
  const ok = provided.some((sig) => {
    try { return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex')); } catch { return false; }
  });
  return { ok, reason: ok ? '' : 'signature mismatch' };
}

async function handleSuccess(md, sourceId, c) {
  const name = md.student_name || '';
  const email = md.student_email;
  const plan = md.plan === 'weekly' ? 'weekly' : 'full';
  const installment = parseInt(md.installment || '1', 10) || 1; // 1 = $100 enrolment (or $400 full), 2..6 = $70 weekly
  const total = c.totalPayments; // 6
  const weeklyNo = installment - 1;

  if (!email) throw new Error(`No student email in metadata for ${sourceId}`);

  if (plan === 'full') {
    await sendEmail({ to: email, ...enrolmentConfirmedEmail({ name, plan: 'full' }) });
  } else if (installment === 1) {
    await sendEmail({ to: email, ...enrolmentConfirmedEmail({ name, plan: 'weekly' }) });
  } else if (installment >= total) {
    await sendEmail({ to: email, ...firstAidUnlockedEmail({ name }) });
  } else {
    await sendEmail({ to: email, ...installmentReceiptEmail({ name, weeklyNo, weeklyTotal: c.weeklyCount }) });
  }

  const note = adminNotifyEmail(
    plan === 'full'
      ? `✅ PAID IN FULL — ${name} ($400)`
      : installment === 1
        ? `✅ Easy Start enrolment payment ($100) — ${name}`
        : `✅ Weekly payment ${weeklyNo}/${c.weeklyCount} ($70) — ${name}${installment >= total ? ' — NOW PAID IN FULL ($450), First Aid & CPR unlocked' : ''}`,
    [
      `${name} — ${email} — ${md.student_phone || ''}`,
      `Starting Monday: ${md.student_start_date || 'not chosen'} — Location: ${md.student_location || 'not provided'} — USI: ${md.student_usi || 'not provided'}`,
      `Stripe: ${sourceId} (${c.env} mode).`,
      plan === 'full' || installment >= total
        ? '<strong>Fees paid in full — eligible for First Aid & CPR. Book their in-person session and placement for their location.</strong>'
        : `Next automatic charge: ~7 days from now ($70, weekly payment ${weeklyNo + 1} of ${c.weeklyCount}).`,
    ]
  );
  await sendEmail({ to: c.adminEmail, ...note });
}

// Fires GA4 purchase + Meta CAPI Purchase + HubSpot Deal creation.
// All errors are swallowed — analytics MUST NOT block payments/emails.
async function fireAnalytics({ md, sourceObj, isFirstPayment }) {
  try {
    const plan = md.plan === 'weekly' ? 'easystart_100' : 'full_400';
    const isEasyStart = md.plan === 'weekly';
    const installment = parseInt(md.installment || '1', 10) || 1;
    const paidAud = (sourceObj.amount_total || sourceObj.amount_received || sourceObj.amount || 0) / 100;
    const txnId = sourceObj.id;

    // Split the student name (best-effort)
    const fullName = (md.student_name || '').trim();
    const firstName = fullName.split(' ')[0] || '';
    const lastName  = fullName.split(' ').slice(1).join(' ');

    // Fire GA4 purchase for every successful payment (enrolment + each weekly + full).
    // client_id: use ga_client_id from metadata if create-order captured it, else stable fallback.
    const clientId = md.ga_client_id || `srv.${md.student_email || txnId}`;
    await ga4Send({
      clientId,
      name: 'purchase',
      params: {
        transaction_id: txnId,
        value: paidAud,
        currency: 'AUD',
        plan_selected: plan,
        is_easy_start: String(isEasyStart),
        installment_number: installment,
        items: [{
          item_id: 'CHCSS00114',
          item_name: 'CHCSS00114 Entry into Care Roles',
          item_category: 'Skill Set',
          price: paidAud,
          quantity: 1,
        }],
      },
    });

    // Fire Meta CAPI Purchase (dedupes with client pixel via event_id = txn id).
    await metaCapiSend({
      eventName: 'Purchase',
      eventId:   txnId,
      value:     paidAud,
      currency:  'AUD',
      email:     md.student_email,
      phone:     md.student_phone,
      firstName, lastName,
      fbp: md.fbp || null,
      fbc: md.fbc || null,
      ua:  md.ua  || null,
      contentCategory: plan,
    });

    // Create HubSpot Contact + Deal only on the FIRST payment (enrolment or full).
    // Weekly installments should not spawn new deals — they update the same student.
    if (isFirstPayment) {
      await hubspotUpsertEnrolment({
        email:     md.student_email,
        firstName, lastName,
        phone:     md.student_phone,
        plan:      plan,
        amount:    isEasyStart ? 450 : 400,  // Total course value, not first payment
        location:  md.student_location,
        startDate: md.student_start_date,
        usi:       md.student_usi,
        message:   md.student_message,
      });
    }
  } catch (e) {
    console.warn('fireAnalytics failed:', e.message);
  }
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const c = cfg();

  const sig = verifySignature(event, c.webhookSecret);
  if (!sig.ok) {
    console.warn('Webhook rejected:', sig.reason);
    return json(400, { error: 'invalid signature' });
  }

  let evt;
  try { evt = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad json' }); }
  const obj = evt.data?.object || {};
  const md = obj.metadata || {};

  try {
    if (md.course !== 'intro') return json(200, { ok: true, ignored: 'not an intro-course object' });

    if (evt.type === 'checkout.session.completed') {
      // First payment (enrolment $100 or full $400) — session carries the metadata.
      if (obj.payment_status && obj.payment_status !== 'paid') return json(200, { ok: true, ignored: 'not paid yet' });
      await handleSuccess(md, obj.id, c);
      // Fire analytics AFTER emails succeed. All fire-and-forget; failures never break payments.
      fireAnalytics({ md, sourceObj: obj, isFirstPayment: true }).catch(() => {});
      return json(200, { ok: true });
    }

    if (evt.type === 'payment_intent.succeeded') {
      // Only the automated weekly charges — checkout payments already handled above.
      if (md.source !== 'weekly-auto') return json(200, { ok: true, ignored: 'checkout-originated PI' });
      await handleSuccess(md, obj.id, c);
      fireAnalytics({ md, sourceObj: obj, isFirstPayment: false }).catch(() => {});
      return json(200, { ok: true });
    }

    if (evt.type === 'payment_intent.payment_failed' && md.source === 'weekly-auto') {
      const weeklyNo = (parseInt(md.installment || '2', 10) || 2) - 1;
      if (md.student_email) {
        await sendEmail({ to: md.student_email, ...paymentFailedEmail({ name: md.student_name || '', weeklyNo, weeklyTotal: c.weeklyCount }) });
      }
      const note = adminNotifyEmail(`⚠️ Weekly charge failed — ${md.student_name || md.student_email}`, [
        `${md.student_name || ''} — ${md.student_email || ''} — weekly payment ${weeklyNo}/${c.weeklyCount}`,
        `Reason: ${obj.last_payment_error?.message || 'unknown'}. Will retry on the next daily run.`,
      ]);
      await sendEmail({ to: c.adminEmail, ...note });
      return json(200, { ok: true });
    }

    return json(200, { ok: true, ignored: evt.type });
  } catch (e) {
    console.error('webhook processing failed:', e.message);
    const note = adminNotifyEmail('⚠️ Webhook processing error', [String(e.message).slice(0, 400)]);
    sendEmail({ to: c.adminEmail, ...note }).catch(() => {});
    return json(200, { ok: false });
  }
};
