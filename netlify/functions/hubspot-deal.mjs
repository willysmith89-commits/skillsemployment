/**
 * Netlify Function: /api/hubspot-deal
 * ---------------------------------------------------------------
 * Called by the enrol form on skillsemployment.com.au after submit.
 * Creates or updates a HubSpot Contact and creates a Deal in the
 * "Intro to Care" pipeline at the "Enrolled" stage, associated to
 * the Contact.
 *
 * Env var required:
 *   HUBSPOT_PRIVATE_APP_TOKEN
 *     Create in HubSpot: Settings > Integrations > Private Apps.
 *     Scopes: crm.objects.contacts.read/write, crm.objects.deals.read/write,
 *             crm.schemas.contacts.read, crm.schemas.deals.read
 */

const HS_ENDPOINT = 'https://api.hubapi.com';
const PIPELINE = '2439332585';   // Intro to Care
const STAGE    = '4036830946';   // Enrolled

const CORS = {
  'Access-Control-Allow-Origin': 'https://skillsemployment.com.au',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST')     return new Response('Method not allowed', { status: 405, headers: CORS });

  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: 'HubSpot token missing' }), {
      status: 500, headers: CORS
    });
  }

  let body;
  try { body = await req.json(); } catch { return new Response('Bad JSON', { status: 400, headers: CORS }); }

  const {
    email, firstName = '', lastName = '', phone = '',
    plan = 'unspecified', amount = 400,
    location = '', startDate = '', usi = '', message = '',
    utm = {}, pageUrl = ''
  } = body || {};

  if (!email) {
    return new Response(JSON.stringify({ ok: false, error: 'email required' }), {
      status: 400, headers: CORS
    });
  }

  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  try {
    // -------- 1. Upsert Contact by email --------
    let contactId;
    const findRes = await fetch(`${HS_ENDPOINT}/crm/v3/objects/contacts/search`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        properties: ['email'],
        limit: 1
      })
    }).then((r) => r.json());

    const contactProps = {
      firstname: firstName, lastname: lastName, phone,
      preferred_location: location, preferred_start_date: startDate,
      usi, payment_plan: plan,
      hs_analytics_source: utm.utm_source || '',
      utm_source:   utm.utm_source   || '',
      utm_medium:   utm.utm_medium   || '',
      utm_campaign: utm.utm_campaign || '',
      utm_content:  utm.utm_content  || ''
    };

    if (findRes.results && findRes.results[0]) {
      contactId = findRes.results[0].id;
      await fetch(`${HS_ENDPOINT}/crm/v3/objects/contacts/${contactId}`, {
        method: 'PATCH', headers: auth,
        body: JSON.stringify({ properties: contactProps })
      });
    } else {
      const createRes = await fetch(`${HS_ENDPOINT}/crm/v3/objects/contacts`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({
          properties: { email, lifecyclestage: 'lead', ...contactProps }
        })
      }).then((r) => r.json());
      contactId = createRes.id;
    }

    // -------- 2. Create Deal in Intro to Care → Enrolled, linked to contact --------
    const dealName = `${firstName || 'Enrolment'} ${lastName || ''} — CHCSS00114 (${plan})`.trim();
    const dealRes = await fetch(`${HS_ENDPOINT}/crm/v3/objects/deals`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        properties: {
          dealname:  dealName,
          pipeline:  PIPELINE,
          dealstage: STAGE,
          amount:    String(amount),
          deal_currency_code: 'AUD',
          payment_plan:         plan,
          preferred_location:   location,
          preferred_start_date: startDate,
          hs_deal_source_id:    pageUrl || 'skillsemployment.com.au',
          description:          message
        },
        associations: [{
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }]
        }]
      })
    }).then((r) => r.json());

    return new Response(JSON.stringify({ ok: true, contactId, dealId: dealRes.id }), {
      status: 200, headers: CORS
    });
  } catch (err) {
    console.error('HubSpot deal creation failed:', err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: CORS
    });
  }
};

export const config = {
  path: '/api/hubspot-deal'
};
