# Go-live guide — Stripe payments + automatic enrolment confirmation

The site takes card payment at enrolment (Stripe Checkout: card, Apple Pay,
Google Pay) and confirms students automatically — including overnight.
Follow these steps once; ~30 minutes total.

Everything runs in **test mode** until Step 6, so you can't charge real money
by accident.

---

## Step 1 — Stripe: get your API keys

1. Log in to **dashboard.stripe.com** → **Developers → API keys**.
2. Toggle **Test mode** ON (top right). Copy the test **Secret key** (`sk_test_...`).
3. Toggle Test mode OFF and copy the live **Secret key** (`sk_live_...`) for later.
4. **Never put secret keys in the website files or emails/chat** — they go into Netlify only (Step 3).

## Step 2 — Resend: email sending for confirmations

1. Free account at **resend.com** (3,000 emails/month free).
2. **Domains → Add domain** → `skillsemployment.com.au`; add the DNS records it shows; click **Verify**.
3. **API Keys → Create API key** → copy it (`re_...`).

## Step 3 — Netlify: environment variables

**Your site → Site configuration → Environment variables**:

| Key | Value |
|---|---|
| `STRIPE_SECRET_KEY` | your **test** secret key for now (`sk_test_...`) |
| `STRIPE_WEBHOOK_SECRET` | leave blank — filled in Step 5 |
| `RESEND_API_KEY` | your Resend key (`re_...`) |
| `ADMIN_EMAIL` | `enrol@skillsemployment.com.au` |
| `FROM_EMAIL` | `Skills & Employment Australia <enrol@skillsemployment.com.au>` |
| `SITE_URL` | `https://skillsemployment.com.au` |

## Step 4 — Deploy this folder

Drag the **whole unzipped folder** into **Deploys**. Afterwards check
**Logs → Functions**: you should see `create-order`, `stripe-webhook`, and
`charge-weekly`.

## Step 5 — Register the webhook (no terminal needed)

1. Stripe Dashboard → **Developers → Webhooks → Add endpoint** (in **Test mode** first).
2. Endpoint URL: `https://skillsemployment.com.au/.netlify/functions/stripe-webhook`
3. Select events: `checkout.session.completed`, `payment_intent.succeeded`, `payment_intent.payment_failed`.
4. After creating it, click **Reveal** on the **Signing secret** (`whsec_...`) and paste it into Netlify's `STRIPE_WEBHOOK_SECRET`, then **Trigger deploy** so functions pick it up.

## Step 6 — Test with fake money, then go live

**Test (no real money):**
1. On your live site, fill the enrolment form, choose **Easy Start**, submit.
2. You'll land on Stripe Checkout. Pay with test card **4242 4242 4242 4242**, any future expiry, any CVC, any postcode.
3. Within a minute: student confirmation email + your admin notification. That's the whole loop proven.
4. Optional: in Stripe → Payments you'll see the $100 test payment with all student details in metadata.

**Go live:** switch two things — `STRIPE_SECRET_KEY` → your `sk_live_` key in
Netlify, and repeat Step 5 with Test mode OFF (live webhooks are separate;
update `STRIPE_WEBHOOK_SECRET` with the live signing secret). Redeploy. Real
cards work immediately; payouts land in the bank account connected to your
Stripe account on your payout schedule (Settings → Payouts).

## How the Easy Start plan works

- Student pays $100 at Stripe Checkout; their card is saved for future charges (the form's consent checkbox covers the recurring authority).
- Daily at ~7am Sydney time, `charge-weekly` finds Easy Start students whose last successful payment is 7+ days old and charges the next **$70** to the saved card, off-session.
- Payments 1–4 of the weekly 5: receipt email. Final payment: student gets **"First Aid & CPR unlocked"**, you get a "book their session + placement" notification.
- Failed charge: friendly fix-it email to the student, alert to you, automatic retry the next day.

## Notes

- If Stripe ever can't start (missing key, outage), the form falls back to Netlify Forms — details land in your inbox and you send a payment link manually. No enrolment is lost. Submit the fallback form once after first deploy so Netlify registers it.
- Refunds, payout schedule, and receipts are all managed in your Stripe Dashboard.
