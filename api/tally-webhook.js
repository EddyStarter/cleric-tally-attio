// /api/tally-webhook.js
// Vercel Serverless Function (Node.js, CommonJS). Uses node-fetch v2.

const fetch = require('node-fetch');

// ---------- ENV VARS ----------
const ATTIO_TOKEN = process.env.ATTIO_TOKEN;                        // Attio API token
const ATTIO_OWNER_EMAIL = process.env.ATTIO_OWNER_EMAIL || null;    // Preferred: owner by email (string)
const ATTIO_OWNER_ID = process.env.ATTIO_OWNER_ID || null;          // Fallback: owner by ID (not used unless needed)
const ATTIO_INITIAL_STAGE_TITLE = process.env.ATTIO_INITIAL_STAGE_TITLE || "Prospect"; // Stage title

const ATTIO_API_BASE = 'https://api.attio.com/v2';

// ---------- LOW-LEVEL ATTIO CALLER (returns full Attio error when debug=1) ----------
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
    let errBody = null;
    try { errBody = await res.json(); } catch {}
    console.error('--- ATTIO API ERROR RESPONSE ---');
    console.error(JSON.stringify(errBody || {}, null, 2));
    console.error('--------------------------------');
    const e = new Error(`Attio ${endpoint} failed with status ${res.status}`);
    e.details = errBody; // attach Attio’s JSON for debugging
    throw e;
  }
  return res.json();
}

// ---------- PEOPLE: find by email or create ----------
async function findOrCreatePerson(email, firstName, lastName) {
  console.log(`Searching for person with email: ${email}`);

  const query = await attioApiRequest('/objects/people/records/query', 'POST', {
    query: {
      and: [{ attribute: 'email_addresses', condition: 'contains', value: email }],
    },
  });

  if (query?.data?.length) {
    const existing = query.data[0];
    console.log(`Found existing person: ${existing.id?.id || existing.id || '[no-id]'}`);
    return existing;
  }

  console.log('No existing person found. Creating a new one.');
  const values = { email_addresses: [{ email_address: email }] };
  if (firstName) values.first_name = [{ value: firstName }];
  if (lastName) values.last_name = [{ value: lastName }];

  const created = await attioApiRequest('/objects/people/records', 'POST', {
    data: { values },
  });
  console.log(`Created person: ${created.data.id?.id || created.data.id}`);
  return created.data;
}

// ---------- COMPANIES: find by domain or create ----------
async function findOrCreateCompany(companyName, companyDomain) {
  console.log(`Searching for company with domain: ${companyDomain}`);

  const query = await attioApiRequest('/objects/companies/records/query', 'POST', {
    query: { and: [{ attribute: 'domains', condition: 'is', value: companyDomain }] },
  });

  if (query?.data?.length) {
    const existing = query.data[0];
    console.log(`Found existing company: ${existing.id?.id || existing.id || '[no-id]'}`);
    return existing;
  }

  console.log('No existing company found. Creating a new company.');
  const created = await attioApiRequest('/objects/companies/records', 'POST', {
    data: { values: { name: [{ value: companyName }], domains: [{ value: companyDomain }] } },
  });
  console.log(`Created company: ${created.data.id?.id || created.data.id}`);
  return created.data;
}

// ---------- DEALS: create once, skip duplicates via unique attribute "external_source_id" ----------
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
      query: { and: [{ attribute: 'external_source_id', condition: 'is', value: externalId }] },
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
    'Unknown Com
