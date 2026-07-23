# Skills & Employment Australia — Backend (Netlify Functions)

Two serverless endpoints powering the analytics + HubSpot integration for `skillsemployment.com.au`.

| Endpoint | Purpose |
|---|---|
| `POST /api/hubspot-deal` | Called from the enrol form. Creates a Contact and a Deal in Intro to Care → Enrolled. |
| `POST /webhooks/stripe-ga4` | Stripe webhook. Fires GA4 `purchase` + Meta CAPI `Purchase` server-side. |

## One-time deploy (5 minutes)

```bash
# From your laptop or wherever you keep source:
cd se-backend
npm install
npm install -g netlify-cli
netlify login          # opens a browser tab
netlify init           # → "Create & configure a new site" → org "Skills & Employment"
                       # → site name suggestion: se-backend
netlify deploy --prod  # deploys the two functions to https://<site>.netlify.app
```

Netlify assigns a URL like `https://se-backend.netlify.app`. Note it — the site needs it.

## Environment variables (Netlify UI → Site settings → Environment variables)

Add these, **all as regular secrets** (not build vars):

| Key | Where to get it | Required |
|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys → Secret key (`sk_live_...`) | ✅ |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Developers → Webhooks → your endpoint → Signing secret (`whsec_...`) | ✅ |
| `GA4_MEASUREMENT_ID` | GA4 → Admin → Data streams → your stream (`G-XXXXXXX`) | ✅ |
| `GA4_API_SECRET` | GA4 → Admin → Data streams → your stream → Measurement Protocol API secrets → Create | ✅ |
| `HUBSPOT_PRIVATE_APP_TOKEN` | HubSpot → Settings → Integrations → Private Apps → your app (`pat-na1-...`) | ✅ |
| `META_PIXEL_ID` | Meta Events Manager → your Pixel → Overview | optional |
| `META_ACCESS_TOKEN` | Meta Events Manager → your Pixel → Conversions API → Generate access token | optional |

## Wire up Stripe

Stripe dashboard → **Developers → Webhooks → Add endpoint**:
- URL: `https://<your-netlify-site>.netlify.app/webhooks/stripe-ga4`
- Events: `checkout.session.completed`, `payment_intent.succeeded`
- Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

## Wire up the enrol form

On `skillsemployment.com.au`, in the `<script src="/assets/se-hubspot.js">` file (aka `08_hubspot_form_integration.js`), set:

```js
const BACKEND_DEAL_URL = 'https://<your-netlify-site>.netlify.app/api/hubspot-deal';
```

The CORS header in `netlify.toml` already whitelists `https://skillsemployment.com.au`.

## Local testing

```bash
netlify dev            # serves the functions at http://localhost:8888
# Test the HubSpot endpoint:
curl -X POST http://localhost:8888/api/hubspot-deal \
  -H "Content-Type: application/json" \
  -d '{"email":"test+123@example.com","firstName":"Test","lastName":"User","phone":"0400000000","plan":"easystart_100","amount":100,"location":"Sydney","startDate":"2026-08-04"}'
# Should return { ok: true, contactId, dealId }
```

Use Stripe CLI to replay a test event against `/webhooks/stripe-ga4`:
```bash
stripe listen --forward-to http://localhost:8888/webhooks/stripe-ga4
stripe trigger checkout.session.completed
```

## Files

```
se-backend/
├── netlify.toml                                 # config, redirects, CORS
├── package.json                                  # depends only on stripe
├── netlify/functions/
│   ├── hubspot-deal.mjs                          # enrol-form → HubSpot
│   └── stripe-webhook.mjs                        # Stripe → GA4 + Meta CAPI + HubSpot advance
└── README.md
```

That's it. First-request cold start is ~300-600ms; steady-state responses are ~50ms. Netlify's free tier gives you 125k function invocations per month — you would need thousands of enrolments per day to exceed it.
