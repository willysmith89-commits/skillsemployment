// Scheduled function (see netlify.toml) — runs daily.
// Stateless: reconstructs each Easy Start student's progress from Stripe's own
// PaymentIntent history (metadata course=intro, plan=weekly), then charges the
// next $70 off-session for anyone whose last successful payment is 7+ days old.
import {
  cfg, stripe, sendEmail,
  paymentFailedEmail, adminNotifyEmail,
} from './lib.mjs';

const DAY = 24 * 60 * 60 * 1000;

async function searchWeeklyPaymentIntents() {
  const collected = [];
  let page = null;
  for (let i = 0; i < 10; i++) {
    const params = {
      query: `metadata['course']:'intro' AND metadata['plan']:'weekly'`,
      limit: '100',
    };
    if (page) params.page = page;
    const res = await stripe('/v1/payment_intents/search', { params });
    collected.push(...(res.data || []));
    if (!res.has_more || !res.next_page) break;
    page = res.next_page;
  }
  return collected;
}

export const handler = async () => {
  const c = cfg();
  if (!c.secretKey) return { statusCode: 200, body: 'not configured' };

  const results = { charged: [], failed: [], skipped: 0 };
  try {
    const pis = await searchWeeklyPaymentIntents();

    // Group by student email
    const byStudent = new Map();
    for (const pi of pis) {
      const key = (pi.metadata?.student_email || '').toLowerCase();
      if (!key) continue;
      if (!byStudent.has(key)) byStudent.set(key, []);
      byStudent.get(key).push(pi);
    }

    for (const [email, list] of byStudent) {
      const succeeded = list
        .filter((pi) => pi.status === 'succeeded')
        .sort((a, b) => a.created - b.created);
      const done = succeeded.length; // 1 = $100 enrolment done; 6 = fully paid ($450)
      if (done === 0 || done >= c.totalPayments) { results.skipped++; continue; }

      const last = succeeded[succeeded.length - 1];
      if (Date.now() - last.created * 1000 < 6.5 * DAY) { results.skipped++; continue; }

      // A processing/requires_action attempt in the last day? Don't double-charge.
      const pendingRecently = list.some((pi) =>
        !['succeeded', 'canceled'].includes(pi.status) &&
        pi.status !== 'requires_payment_method' &&
        Date.now() - pi.created * 1000 < 1 * DAY);
      if (pendingRecently) { results.skipped++; continue; }

      const md = last.metadata || {};
      const customerId = last.customer;
      const name = md.student_name || '';
      const nextNo = done + 1;       // 2..6
      const weeklyNo = nextNo - 1;   // 1..5

      try {
        if (!customerId) throw new Error('no customer id on previous payment');

        // Saved card: prefer the payment method used for the enrolment payment
        let pmId = typeof last.payment_method === 'string' ? last.payment_method : last.payment_method?.id;
        if (!pmId) {
          const pms = await stripe('/v1/payment_methods', { params: { customer: customerId, type: 'card', limit: '1' } });
          pmId = pms.data?.[0]?.id;
        }
        if (!pmId) throw new Error('no saved payment method for customer');

        const params = {
          amount: String(c.installmentAmount),
          currency: 'aud',
          customer: customerId,
          payment_method: pmId,
          off_session: 'true',
          confirm: 'true',
          description: `Easy Start Plan — weekly payment ${weeklyNo} of ${c.weeklyCount} ($70)`,
        };
        const meta = { ...md, installment: String(nextNo), source: 'weekly-auto' };
        for (const [k, v] of Object.entries(meta)) params[`metadata[${k}]`] = v;

        await stripe('/v1/payment_intents', { method: 'POST', params });
        results.charged.push(`${email} (weekly ${weeklyNo}/${c.weeklyCount})`);
        // Success/failed emails are handled by the webhook (payment_intent.succeeded / payment_failed).
      } catch (e) {
        // Card declined off-session raises an error here too; webhook may not fire if PI creation failed outright.
        console.error(`weekly charge failed for ${email}:`, e.message);
        results.failed.push(`${email}: ${String(e.message).slice(0, 200)}`);
        if (e.code !== 'authentication_required') {
          sendEmail({ to: email, ...paymentFailedEmail({ name, weeklyNo, weeklyTotal: c.weeklyCount }) }).catch(() => {});
        }
      }
    }

    if (results.charged.length || results.failed.length) {
      const note = adminNotifyEmail('Weekly charge run summary', [
        `Charged: ${results.charged.length ? results.charged.join('; ') : 'none'}`,
        `Failed: ${results.failed.length ? results.failed.join('; ') : 'none'}`,
        `Skipped (not due / complete): ${results.skipped}`,
      ]);
      await sendEmail({ to: c.adminEmail, ...note });
    }

    return { statusCode: 200, body: JSON.stringify(results) };
  } catch (e) {
    console.error('charge-weekly run failed:', e.message);
    const note = adminNotifyEmail('⚠️ Weekly charge run FAILED', [String(e.message).slice(0, 400)]);
    sendEmail({ to: cfg().adminEmail, ...note }).catch(() => {});
    return { statusCode: 500, body: 'error' };
  }
};
