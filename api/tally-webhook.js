// /api/tally-webhook.js
// Vercel Serverless Function (Node.js, CommonJS). Uses node-fetch v2.

const fetch = require('node-fetch');

// ---- Environment variables (set in Vercel -> Project -> Settings -> Environment Variables)
const ATTIO_TOKEN = process.env.ATTIO_TOKEN;                      // Attio API token
const ATTIO_INITIAL_STAGE_ID = process.env.ATTIO_INITIAL_STAGE_ID; // UUID for your "Prospect" (initial) stage
const ATTIO_OWNER_ID = process.env.ATTIO_OWNER_ID;                // UUID of the user who should own the deal

const ATTIO_API_BASE = 'https://api.attio.com/v2';

// ---- Helper to call Attio API with clear error logs
async function attioApiRequest(endpoint, method, body = null) {
  const res = await fetch(`${ATTIO_API_BASE}${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ATTIO_TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let err = null;
    try { err = await res.json(); } catch {}
    console.error('--- ATTIO API ERROR RESPONSE ---');
    console.error(JSON.stringify(err || {}, null, 2));
    console.error('--------------------------------');
    throw new Error(`Attio ${endpoint} failed with status ${res.status}`);
  }
  return res.json();
}

// ---- People: find by email or create
async function findOrCreatePerson(email, firstName, lastName) {
  console.log(`Searching for person with email: ${email}`);

  const query = await attioApiRequest('/objects/people/records/query', 'POST', {
    query: {
      and: [
        { attribute: 'email_addresses', condition: 'contains', value: email },
      ],
    },
  });

  if (query?.data?.length) {
    const existing = query.data[0];
    console.log(`Found existing person: ${existing.id?.id || existing.id || '[no-id]'}`);
    return existing;
  }

  console.log('No existing person found. Creating a new one.');
  const values = {
    email_addresses: [{ email_address: email }],
  };
  if (firstName) values.first_name = [{ value: firstName }];
  if (lastName) values.last_name = [{ value: lastName }];

  const created = await attioApiRequest('/objects/people/records', 'POST', {
    data: { values },
  });
  console.log(`Created person: ${created.data.id?.id || created.data.id}`);
  return created.data;
}

// ---- Companies: find by domain or create
async function findOrCreateCompany(companyName, companyDomain) {
  console.log(`Searching for company with domain: ${companyDomain}`);

  const query = await attioApiRequest('/objects/companies/records/query', 'POST', {
    query: {
      and: [
        { attribute: 'domains', condition: 'is', value: companyDomain },
      ],
    },
  });

  if (query?.data?.length) {
    const existing = query.data[0];
    console.log(`Found existing company: ${existing.id?.id || existing.id || '[no-id]'}`);
    return existing;
  }

  console.log('No existing company found. Creating a new one.');
  const created = await attioApiRequest('/objects/companies/records', 'POST', {
    data: {
      values: {
        name: [{ value: companyName }],
        domains: [{ value: companyDomain }],
      },
    },
  });
  console.log(`Created company: ${created.data.id?.id || created.data.id}`);
  return created.data;
}

// ---- Deals: create once, skip duplicates using your unique attribute "external_source_id"
/**
 * @param {object} personRecord
 * @param {object} companyRecord
 * @param {string|null} externalId - Tally responseId/submissionId (stable per submission)
 */
async function createDeal(personRecord, companyRecord, externalId) {
  console.log('Creating (or skipping) deal. externalId =', externalId || '(none)');

  // 1) If we have an external ID, check if a Deal already exists.
  if (externalId) {
    const existing = await attioApiRequest('/objects/deals/records/query', 'POST', {
      query: {
        and: [
          { attribute: 'external_source_id', condition: 'is', value: externalId },
        ],
      },
    });
    if (existing?.data?.length) {
      console.log('Deal already exists for this externalId. Returning existing record.');
      return existing.data[0];
    }
  }

  // 2) Build the create payload
  const companyName =
    companyRecord?.values?.name?.[0]?.value ||
    companyRecord?.values?.name?.[0] ||
    'Unknown Company';

  const dealName = `New Prospect - ${companyName}`;

  const payload = {
    data: {
      values: {
        name: [{ value: dealName }],

        // IMPORTANT: Attio’s status attribute on deals is "stage" (not "deal-stage")
        stage: [
          { target_record_id: ATTIO_INITIAL_STAGE_ID },
        ],

        owner: [
          { target_record_id: ATTIO_OWNER_ID },
        ],

        associated_company: [
          { target_record_id: companyRecord.id },
        ],
        associated_people: [
          { target_record_id: personRecord.id },
        ],
      },
    },
  };

  if (externalId) {
    payload.data.values.external_source_id = [{ value: externalId }];
  }

  const created = await attioApiRequest('/objects/deals/records', 'POST', payload);
  console.log(`Created deal: ${created.data.id?.id || created.data.id}`);
  return created.data;
}

// ---- Main Vercel handler
module.exports = async (req, res) => {
  console.log('--- TALLY WEBHOOK INVOCATION START ---');
  console.log(`Request received at: ${new Date().toISOString()}`);

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }

  try {
    const payload = req.body;
    console.log('Raw Request Body:', JSON.stringify(payload || {}, null, 2));

    if (!payload || !payload.data || !payload.data.fields) {
      console.error('Invalid or empty payload received from Tally.');
      return res.status(400).json({ status: 'error', message: 'Payload is missing or malformed.' });
    }

    const fields = payload.data.fields;
    const getField = (label) => (fields.find(f => f.label === label) || {}).value || null;

    const fullName = getField('Full Name') || '';
    const email = getField('Email Address');
    const companyName = getField('Company Name');
    const companyWebsite = getField('Company Website');

    if (!email || !companyName || !companyWebsite) {
      console.error('Missing required fields:', { email, companyName, companyWebsite });
      return res.status(400).json({ status: 'error', message: 'Missing required form fields.' });
    }

    // Split name (no "N/A" placeholders)
    const parts = fullName.trim().split(/\s+/).filter(Boolean);
    const firstName = parts[0] || '';
    const lastName = parts.slice(1).join(' ') || '';

    // Normalize the company domain
    const fullUrl = companyWebsite.startsWith('http') ? companyWebsite : `https://${companyWebsite}`;
    const domain = new URL(fullUrl).hostname.replace(/^www\./i, '');

    // Upsert person/company via "query then create"
    const person = await findOrCreatePerson(email, firstName, lastName);
    const company = await findOrCreateCompany(companyName, domain);

    // Prefer responseId; fall back to submissionId if present
    const externalId = payload?.data?.responseId || payload?.data?.submissionId || null;

    await createDeal(person, company, externalId);

    console.log('Workflow completed successfully.');
    return res.status(200).json({ status: 'success', message: 'Person, Company, and Deal processed in Attio.' });
  } catch (err) {
    console.error('Webhook processing failed:', err);
    return res.status(500).json({ status: 'error', message: 'An internal error occurred.', details: err.message });
  }
};
