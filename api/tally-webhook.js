// /api/tally-webhook.js
// Vercel Serverless Function (CommonJS). Uses node-fetch v2 (declared in package.json).

const fetch = require('node-fetch');

// --- Environment Variables (set these in Vercel > Project > Settings > Environment Variables) ---
const ATTIO_TOKEN = process.env.ATTIO_TOKEN;                // Attio API token
const ATTIO_INITIAL_STAGE_ID = process.env.ATTIO_INITIAL_STAGE_ID; // UUID for "Prospect" (or your initial stage)
const ATTIO_OWNER_ID = process.env.ATTIO_OWNER_ID;          // UUID of the user who should own the deal

// --- Attio API base ---
const ATTIO_API_BASE = 'https://api.attio.com/v2';

// --- Helper: make authenticated calls to Attio with clear error logs ---
const attioApiRequest = async (endpoint, method, body = null) => {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ATTIO_TOKEN}`,
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${ATTIO_API_BASE}${endpoint}`, options);

  if (!res.ok) {
    let errBody = null;
    try { errBody = await res.json(); } catch {}
    console.error('--- ATTIO API ERROR RESPONSE ---');
    console.error(JSON.stringify(errBody || {}, null, 2));
    console.error('--------------------------------');
    throw new Error(`Attio ${endpoint} failed with status ${res.status}`);
  }

  return res.json();
};

// --- People: find by email or create ---
const findOrCreatePerson = async (email, firstName, lastName) => {
  console.log(`Searching for person with email: ${email}`);

  const queryResponse = await attioApiRequest('/objects/people/records/query', 'POST', {
    query: {
      and: [
        {
          attribute: 'email_addresses',
          condition: 'contains',
          value: email,
        },
      ],
    },
  });

  if (queryResponse?.data?.length) {
    const existing = queryResponse.data[0];
    console.log(`Found existing person: ${existing.id}`);
    return existing;
  }

  console.log('No existing person found. Creating a new person.');

  const values = {
    email_addresses: [{ email_address: email }],
  };
  if (firstName) values['first_name'] = [{ value: firstName }];
  if (lastName) values['last_name'] = [{ value: lastName }];

  const createResponse = await attioApiRequest('/objects/people/records', 'POST', {
    data: { values },
  });

  console.log(`Created person: ${createResponse.data.id}`);
  return createResponse.data;
};

// --- Companies: find by domain or create ---
const findOrCreateCompany = async (companyName, companyDomain) => {
  console.log(`Searching for company with domain: ${companyDomain}`);

  const queryResponse = await attioApiRequest('/objects/companies/records/query', 'POST', {
    query: {
      and: [
        { attribute: 'domains', condition: 'is', value: companyDomain },
      ],
    },
  });

  if (queryResponse?.data?.length) {
    const existing = queryResponse.data[0];
    console.log(`Found existing company: ${existing.id}`);
    return existing;
  }

  console.log('No existing company found. Creating a new company.');
  const createResponse = await attioApiRequest('/objects/companies/records', 'POST', {
    data: {
      values: {
        name: [{ value: companyName }],
        domains: [{ value: companyDomain }],
      },
    },
  });

  console.log(`Created company: ${createResponse.data.id}`);
  return createResponse.data;
};

// --- Deals: prevent duplicates using your unique attribute "external_source_id" ---
/**
 * @param {object} personRecord
 * @param {object} companyRecord
 * @param {string|null} externalId - Tally responseId/submissionId if present
 */
const createDeal = async (personRecord, companyRecord, externalId) => {
  console.log('Creating (or skipping) deal. externalId =', externalId || '(none)');

  // 1) If we have an external ID, check if a Deal already exists.
  if (externalId) {
    const existing = await attioApiRequest('/objects/deals/records/query', 'POST', {
      query: {
        and: [
          {
            attribute: 'external_source_id', // your confirmed slug
            condition: 'is',
            value: externalId,
          },
        ],
      },
    });

    if (existing?.data?.length) {
      console.log('Deal already exists for this externalId. Returning existing record.');
      return existing.data[0];
    }
  }

  // 2) Build payload to create a Deal
  const companyName =
    companyRecord?.values?.name?.[0]?.value ||
    companyRecord?.values?.name?.[0] ||
    'Unknown Company';

  const dealName = `New Prospect - ${companyName}`;

  const dealPayload = {
    data: {
      values: {
        name: [{ value: dealName }],

        // Keep using your known-good slugs
        'deal-stage': [
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

  // Add the external source id so we can skip duplicates next time
  if (externalId) {
    dealPayload.data.values['external_source_id'] = [{ value: externalId }];
  }

  const created = await attioApiRequest('/objects/deals/records', 'POST', dealPayload);
  console.log(`Created deal: ${created.data.id}`);
  return created.data;
};

// --- Main handler ---
module.exports = async (req, res) => {
  console.log('--- TALLY WEBHOOK START ---', new Date().toISOString());

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }

  try {
    const payload = req.body;
    console.log('Raw Request Body:', JSON.stringify(payload, null, 2));

    if (!payload || !payload.data || !payload.data.fields) {
      console.error('Invalid or empty payload from Tally.');
      return res.status(400).json({ status: 'error', message: 'Payload is missing or malformed.' });
    }

    const fields = payload.data.fields;

    const getFieldValue = (label) => {
      const field = fields.find((f) => f.label === label);
      return field ? field.value : null;
    };

    const fullName = getFieldValue('Full Name') || '';
    const email = getFieldValue('Email Address');
    const companyName = getFieldValue('Company Name');
    const companyWebsite = getFieldValue('Company Website');

    if (!email || !companyName || !companyWebsite) {
      console.error('Missing required fields:', { email, companyName, companyWebsite });
      return res.status(400).json({ status: 'error', message: 'Missing required form fields.' });
    }

    // Name splitting (no "N/A" placeholders)
    const parts = fullName.trim().split(/\s+/).filter(Boolean);
    const firstName = parts[0] || '';
    const lastName = parts.slice(1).join(' ') || '';

    // Normalize domain from the website input
    const fullUrl = companyWebsite.startsWith('http') ? companyWebsite : `https://${companyWebsite}`;
    const domain = new URL(fullUrl).hostname.replace(/^www\./i, '');

    // Upsert Person & Company
    const personRecord = await findOrCreatePerson(email, firstName, lastName);
    const companyRecord = await findOrCreateCompany(companyName, domain);

    // Prefer Tally's responseId; fall back to submissionId if present
    const externalId = payload?.data?.responseId || payload?.data?.submissionId || null;

    // Create the Deal (idempotent with external_source_id)
    await createDeal(personRecord, companyRecord, externalId);

    console.log('Workflow completed successfully.');
    return res.status(200).json({ status: 'success', message: 'Person, Company, and Deal processed in Attio.' });
  } catch (err) {
    console.error('Webhook processing failed:', err);
    return res.status(500).json({ status: 'error', message: 'An internal error occurred.', details: err.message });
  }
};
