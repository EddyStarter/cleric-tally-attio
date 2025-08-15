// /api/tally-webhook.js
// CommonJS (works on Vercel without ESM). Minimal create-first flow.

const ATTIO_API = 'https://api.attio.com/v2';
const ATTIO_TOKEN = process.env.ATTIO_TOKEN;
const INITIAL_STAGE = process.env.ATTIO_INITIAL_STAGE || 'Prospect'; // not used yet (we'll add deals after P/C are stable)

function pickField(fields, label) {
  const f = fields.find(x => (x.label || '').toLowerCase() === (label || '').toLowerCase());
  return f?.value ?? '';
}

function splitName(fullName) {
  if (!fullName) return { first: '', last: '' };
  const parts = fullName.trim().split(/\s+/);
  const first = parts.shift() || '';
  const last = parts.length ? parts.join(' ') : '';
  return { first, last };
}

function hostFromUrl(raw) {
  if (!raw) return '';
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

async function attioFetch(path, opts = {}) {
  if (!ATTIO_TOKEN) throw new Error('Missing ATTIO_TOKEN');
  const res = await fetch(`${ATTIO_API}${path}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${ATTIO_TOKEN}`,
      'Content-Type': 'application/json',
    },
    ...opts,
  });
  return res;
}

// --- CREATE PERSON (no search for now) ---
async function createPerson({ fullName, email }) {
  const { first, last } = splitName(fullName || '');
  const values = {
    // Attio expects either name.full_name OR name.{first_name,last_name}
    name: first || last ? { first_name: first, last_name: last } : undefined,
    // prior errors showed 'type' was unrecognized — send only email_address
    email_addresses: email ? [{ email_address: email }] : [],
  };

  // Remove undefined keys
  Object.keys(values).forEach(k => values[k] === undefined && delete values[k]);

  const body = JSON.stringify({ data: { values } });
  const r = await attioFetch('/objects/people/records', { method: 'POST', body });
  const text = await r.text();
  if (!r.ok) {
    console.error('[person create] status:', r.status, 'body:', text);
    throw new Error(`[person create] ${r.status} ${text}`);
  }
  const json = JSON.parse(text);
  const id = json?.data?.id;
  console.log('[person] id:', id);
  return id;
}

// --- CREATE or MATCH COMPANY by domain (best-effort create) ---
async function createCompany({ companyName, companyWebsite }) {
  const domain = hostFromUrl(companyWebsite || '');
  const values = {
    name: companyName || domain || undefined,
    // Companies accepts "domains": [{ domain: "example.com" }]
    domains: domain ? [{ domain }] : [],
  };
  Object.keys(values).forEach(k => values[k] === undefined && delete values[k]);

  const body = JSON.stringify({ data: { values } });
  const r = await attioFetch('/objects/companies/records', { method: 'POST', body });
  const text = await r.text();
  if (!r.ok) {
    console.error('[company create] status:', r.status, 'body:', text);
    throw new Error(`[company create] ${r.status} ${text}`);
  }
  const json = JSON.parse(text);
  const id = json?.data?.id;
  console.log('[company] id:', id, 'domain:', domain);
  return id;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, note: 'Method Not Allowed' });
  }

  try {
    // Tally payload
    const fields = req.body?.data?.fields || [];

    const fullName       = pickField(fields, 'Full Name');
    const email          = pickField(fields, 'Email Address') || pickField(fields, 'Work Email') || pickField(fields, 'Email');
    const companyName    = pickField(fields, 'Company Name');
    const companyWebsite = pickField(fields, 'Company Website');

    console.log('[tally] fullName:', fullName, 'email:', email, 'companyName:', companyName, 'companyWebsite:', companyWebsite);

    // 1) Person
    const personId = await createPerson({ fullName, email });

    // 2) Company (best effort; okay if website is blank)
    let companyId = null;
    try {
      if (companyName || companyWebsite) {
        companyId = await createCompany({ companyName, companyWebsite });
      }
    } catch (e) {
      // Not fatal for the test; log and continue
      console.error('[company] error:', e?.message || e);
    }

    // NOTE: Deal creation is intentionally skipped right now so we can first confirm
    // People & Companies consistently land. Once confirmed, we’ll add the Deal block back.

    return res.status(200).json({
      ok: true,
      personId,
      companyId,
      note: 'Person (and Company if provided) created. Deal creation temporarily disabled.',
    });
  } catch (e) {
    console.error('[webhook] uncaught:', e);
    return res.status(500).json({ ok: false, error: 'Internal Server Error' });
  }
};
