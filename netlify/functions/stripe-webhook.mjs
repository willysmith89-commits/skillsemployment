/**
 * Netlify Function: /webhooks/stripe-ga4
 * ---------------------------------------------------------------
 * On Stripe payment success:
 *   1. Verifies the webhook signature
 *   2. Fires a GA4 `purchase` event via Measurement Protocol
 *   3. Fires a deduplicated Meta CAPI `Purchase` event
 *   4. Advances the matching HubSpot Deal — noop for Skills &
 *      Employment because deals already land in "Enrolled" on
 *      form submit; but if the deal is still in an earlier stage
 *      (e.g. someone paid without the form), we advance it here.
 *
 * Env vars required (set in Netlify UI → Site settings → Env vars):
 *   STRIPE_SECRET_KEY
 *   STRIPE_WEBHOOK_SECRET
 *   GA4_MEASUREMENT_ID
 *   GA4_API_SECRET
 *   META_PIXEL_ID              (optional)
 *   META_ACCESS_TOKEN          (optional)
 *   HUBSPOT_PRIVATE_APP_TOKEN  (optional — only if you also want deal advance)
 */

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-11-20.acacia'
});

// Netlify Functions v2 export
export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const sig = req.headers.get('stripe-signature');
  const raw = await req.text(); // MUST be raw text, not parsed JSON

  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe signature verification failed:', err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  if (!['checkout.session.completed', 'payment_intent.succeeded'].includes(event.type)) {
    return Response.json({ received: true, ignored: true });
  }

  const obj = event.data.object;
  const amountAud = (obj.amount_total || obj.amount_received || 0) / 100;
  const transactionId = obj.id;
  const metadata = obj.metadata || {};
  const clientId =
    metadata.ga_client_id ||
    obj.client_reference_id ||
    `srv.${Date.now()}.${Math.floor(Math.random() * 1e9)}`;

  const plan = metadata.plan || (amountAud <= 100 ? 'easystart_100' : 'full_400');

  // ---------- GA4 Measurement Protocol ----------
  try {
    const url = `https://www.google-analytics.com/mp/collect?measurement_id=${process.env.GA4_MEASUREMENT_ID}&api_secret=${process.env.GA4_API_SECRET}`;
    const gaRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        non_personalized_ads: false,
        events: [{
          name: 'purchase',
          params: {
            transaction_id: transactionId,
            value: amountAud,
            currency: 'AUD',
            plan_selected: plan,
            is_easy_start: (amountAud <= 100).toString(),
            items: [{
              item_id: 'CHCSS00114',
              item_name: 'CHCSS00114 Entry into Care Roles',
              item_category: 'Skill Set',
              price: amountAud,
              quantity: 1
            }]
          }
        }]
      })
    });
    console.log('GA4 MP:', gaRes.status);
  } catch (e) {
    console.error('GA4 MP failed:', e);
  }

  // ---------- Meta Conversions API ----------
  if (process.env.META_PIXEL_ID && process.env.META_ACCESS_TOKEN) {
    try {
      await fetch(
        `https://graph.facebook.com/v18.0/${process.env.META_PIXEL_ID}/events?access_token=${process.env.META_ACCESS_TOKEN}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            data: [{
              event_name: 'Purchase',
              event_time: Math.floor(Date.now() / 1000),
              event_id: transactionId,
              action_source: 'website',
              event_source_url: 'https://skillsemployment.com.au/',
              user_data: {
                em: metadata.email_sha256 || null,
                ph: metadata.phone_sha256 || null,
                client_user_agent: metadata.ua || null,
                fbc: metadata.fbc || null,
                fbp: metadata.fbp || null
              },
              custom_data: {
                value: amountAud,
                currency: 'AUD',
                content_name: 'CHCSS00114 Enrolment',
                content_category: plan
              }
            }]
          })
        }
      );
    } catch (e) {
      console.error('Meta CAPI failed:', e);
    }
  }

  // ---------- Optionally advance HubSpot deal to "Enrolled" ----------
  // Only matters if the deal was created via a payment-first flow that
  // skipped the enrol form. Safe no-op if it's already at that stage.
  if (process.env.HUBSPOT_PRIVATE_APP_TOKEN && metadata.hubspot_deal_id) {
    try {
      await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${metadata.hubspot_deal_id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          properties: {
            dealstage: '4036830946', // "Enrolled" in Intro to Care pipeline
            hs_stripe_payment_id: transactionId,
            amount_paid: String(amountAud)
          }
        })
      });
    } catch (e) {
      console.error('HubSpot deal advance failed:', e);
    }
  }

  return Response.json({ received: true });
};

export const config = {
  path: '/webhooks/stripe-ga4'
};
