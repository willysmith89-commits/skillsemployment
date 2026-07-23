// POST /.netlify/functions/create-order
// Body: { name, email, phone, location, usi, plan: "full" | "weekly", message? }
// Creates a Stripe Checkout Session and returns its hosted payment URL.
import { cfg, stripe, sendEmail, adminNotifyEmail, json } from './lib.mjs';

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }

  const name = String(body.name || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().slice(0, 200);
  const phone = String(body.phone || '').trim().slice(0, 40);
  const location = String(body.location || '').trim().slice(0, 80);
  const startDate = String(body.start_date || '').trim().slice(0, 20);
  const usi = String(body.usi || '').trim().toUpperCase().slice(0, 10);
  const plan = body.plan === 'weekly' ? 'weekly' : 'full';
  const message = String(body.message || '').trim().slice(0, 1000);

  // Analytics attribution (optional — all safe if blank)
  const gaClientId = String(body.ga_client_id || '').slice(0, 60);
  const fbp        = String(body.fbp || '').slice(0, 100);
  const fbc        = String(body.fbc || '').slice(0, 200);
  const ua         = String(body.ua  || '').slice(0, 250);
  const utmSource   = String(body.utm_source   || '').slice(0, 80);
  const utmMedium   = String(body.utm_medium   || '').slice(0, 80);
  const utmCampaign = String(body.utm_campaign || '').slice(0, 120);
  const utmContent  = String(body.utm_content  || '').slice(0, 120);

  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !phone) {
    return json(400, { error: 'Please provide your name, a valid email, and a phone number.' });
  }

  const c = cfg();
  if (!c.secretKey) return json(503, { error: 'Payments are not configured yet. Please email enrol@skillsemployment.com.au.' });

  const isWeekly = plan === 'weekly';
  const meta = {
    course: 'intro',
    plan,
    installment: '1',
    student_name: name,
    student_email: email,
    student_phone: phone,
    student_location: location,
    student_start_date: startDate,
    student_usi: usi,
    student_message: message,
    // Analytics attribution — flowed through to stripe-webhook for GA4/Meta CAPI stitching
    ga_client_id: gaClientId,
    fbp,
    fbc,
    ua,
    utm_source:   utmSource,
    utm_medium:   utmMedium,
    utm_campaign: utmCampaign,
    utm_content:  utmContent,
  };

  try {
    const params = {
      'mode': 'payment',
      'customer_email': email,
      'customer_creation': 'always',
      'currency': 'aud',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'aud',
      'line_items[0][price_data][unit_amount]': String(isWeekly ? c.enrolAmount : c.fullAmount),
      'line_items[0][price_data][product_data][name]': isWeekly
        ? 'CHCSS00114 Entry into Care Roles — Easy Start Plan enrolment ($100 today, then 5 × $70 weekly)'
        : 'CHCSS00114 Entry into Care Roles — full course fee',
      'success_url': `${c.siteUrl}/payment-success.html?plan=${plan}`,
      'cancel_url': `${c.siteUrl}/#enrol`,
      'payment_intent_data[description]': isWeekly
        ? 'Easy Start Plan — enrolment payment 1 of 6 ($100)'
        : 'Full course fee ($400)',
    };
    // Session + PaymentIntent both carry the metadata
    for (const [k, v] of Object.entries(meta)) {
      params[`metadata[${k}]`] = v;
      params[`payment_intent_data[metadata][${k}]`] = v;
    }
    // Weekly plan: save the card for merchant-initiated weekly charges
    if (isWeekly) params['payment_intent_data[setup_future_usage]'] = 'off_session';

    const session = await stripe('/v1/checkout/sessions', { method: 'POST', params });

    const note = adminNotifyEmail('New enrolment started (checkout opened)', [
      `<strong>${name}</strong> — ${email} — ${phone}`,
      `Starting Monday: <strong>${startDate || 'not chosen'}</strong>`,
      `Location (placement & First Aid booking): <strong>${location || 'not provided'}</strong>`,
      `USI: ${usi || 'not provided yet'}`,
      `Plan: ${isWeekly ? 'Easy Start ($100 today + 5 × $70 = $450)' : 'Pay in Full ($400)'}`,
      message ? `Message: ${message}` : 'No message.',
      `Stripe session: ${session.id} (${c.env} mode)`,
    ]);
    sendEmail({ to: c.adminEmail, ...note }).catch(() => {});

    if (!session.url) throw new Error('No checkout URL in Stripe response');
    return json(200, { checkout_url: session.url, order_id: session.id });
  } catch (e) {
    console.error('create-order failed:', e.message);
    const note = adminNotifyEmail('⚠️ Checkout failed to start', [
      `${name} — ${email} — ${phone} — plan: ${plan}`,
      `Error: ${String(e.message).slice(0, 300)}`,
    ]);
    sendEmail({ to: cfg().adminEmail, ...note }).catch(() => {});
    return json(502, { error: 'We could not start the payment just now. Please try again in a minute, or email enrol@skillsemployment.com.au and we will help.' });
  }
};
