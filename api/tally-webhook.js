// /api/tally-webhook.js
// Vercel Serverless Function (Node.js, CommonJS). Uses node-fetch v2.

const fetch = require('node-fetch');

// ---------- ENV VARS ----------
const ATTIO_TOKEN = process.env.ATTIO_TOKEN;                               // REQUIRED: Attio API token
const ATTIO_OWNER_EMAIL = process.env.ATTIO_OWNER_EMAIL || null;           // RECOMMENDED: owner as email (string)
const ATTIO_INITIAL_STAGE_TITLE = process.env.ATTIO_INITIAL_STAGE_TITLE || "Prospect"; // Stage title (string)

const ATTIO_API_BASE = 'https://api.attio.com/v2';

// ---------- HTTP helper (includes debug error body) ----------
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

// ---------- ASSERT (UPSERT) HELPERS ----------
// People: assert by email (no prior read)
async function assertPersonByEmail(email, firstName, lastName) {
  const values = {
    // Attio accepts email_addresses in object form
    email_addresses: [{ email_address: email }],
  };
  // Optional name pieces if present
  if (firstName || lastName) {
    values.name = [{
      full_name: [firstName, lastName].filter(Boolean).join(' '),
      first_name: firstName || undefined,
      last_name: lastName || undefined,
    }];
  }

  const resp = await attioApiRequest(
    '/objects/people/records?matching_attribute=email_addresses',
    'PUT',
    { data: { values } }
  );
  return resp.data;
}

// Companies: assert by domain (no prior read)
async function assertCompanyByDomain(companyName, domain) {
  const values = {
    name: [{ value: companyName }],
    // Attio tolerates domain-type writes as arrays of domain strings/objects
    domains: [{ domain }],
  };

  const resp = await attioApiRequest(
    '/objects/companies/records?matching_attribute=domains',
    'PUT',
    { data: { values } }
  );
  return resp.data;
}

// Deals: assert by your unique "external_source_id"
async function assertDealByExternalId({
  externalId, dealName, stageTitle, ownerEmail, personEmail, companyDomain,
}) {
  // Build associations via natural keys (NOT IDs)
  const values = {
    name: [{ value: dealName }],
    stage: stageTitle,                // write stage as a STRING title
    associated_people: [
      {
        target_object: 'people',
        email_addresses: [{ email_address: personEmail }],
      },
    ],
    associated_company: {
      target_object: 'companies',
      domains: [{ domain: companyDomain }],
    },
    external_source_id: [{ value: externalId }],
  };

  // Owner as plain string email (omit if not provided)
  if (ownerEmail) values.owner = ownerEmail;

  // Assert (upsert) the deal by the unique attribute
  const resp = await attioApiRequest(
    '/objects/deals/records?matching_attribute=external_source_id',
    'PUT',
    { data: { values } }
  );
  return resp.data;
}

// ---------- MAIN HANDLER ----------
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

    // Split name safely
    const parts = fullName.trim().split(/\s+/).filter(Boolean);
    const firstName = parts[0] || '';
    const lastName = parts.slice(1).join(' ') || '';

    // Get clean domain
    const fullUrl = companyWebsite.startsWith('http') ? companyWebsite : `https://${companyWebsite}`;
    const domain = new URL(fullUrl).hostname.replace(/^www\./i, '');

    // Use Tally's IDs (consistent dedupe)
    const externalId = payl
