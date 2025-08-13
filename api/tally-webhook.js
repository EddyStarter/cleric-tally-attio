// api/tally-webhook.js
// Robust: Upsert Company -> Upsert-or-Create Person (multi-shape fallbacks) -> Create Deal (link by IDs)

function pickField(fields, label) {
  return fields.find(f => (f.label || '').toLowerCase() === label.toLowerCase())?.value || '';
}

function normalizeDomain(raw) {
  if (!raw) return '';
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./, '');
  } catch { return ''; }
}

function splitName(full = '') {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: '-', last: '-' };
  const first = parts.shift() || '-';
  const last  = parts.length ? parts.join(' ') : '-';
  return { first, last };
}

function titleCase(s = '') {
  return s
    .split(/[\s\-_.]+/)
    .filter(Boolean)
    .map(w => w[0]?.toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}
function companyNameFromDomain(domain = '') {
  const core = domain.split('.').slice(0, -1).join(' ') || domain.split('.')[0] || '';
  return titleCase(core.replace(/-/g, ' '));
}

const PERSONAL_DOMAINS = new Set([
  'gmail.com','yahoo.com','outlook.com','hotmail.com','icloud.com',
  'aol.com','proton.me','protonmail.com','live.com','me.com','mail.com'
]);

async function readBody(resp) {
  const raw = await resp.text();
  try { return { raw, json: JSON.parse(raw) }; }
  catch { return { raw, json: null }; }
}
function getId(payload) {
  if (!payload) return null;
  const d = payload.data || payload.record || payload;
  if (!d) return null;
  if (typeof d.id === 'string') return d.id;
  if (d.record && typeof d.record.id === 'string') return d.record.id;
  if (Array.isArray(d.records) && typeof d.records[0]?.id === 'string') return d.records[0].id;
  return null;
}

async function tryPersonWrite({ method, authHeaders, url, valuesVariants, logPrefix }) {
  for (const values of valuesVariants) {
    const resp = await fetch(url, {
      method,
      headers: authHeaders,
      body: JSON.stringify({ data: { values } }),
    });
    const { raw, json } = await readBody(resp);
    console.log(`${logPrefix}`, resp.status, raw);
    if (resp.ok) return { id: getId(json), ok: true, raw };
  }
  return { ok: false };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const attioToken   = process.env.ATTIO_TOKEN;
    const initialStage = process.env.ATTIO_INITIAL_STAGE || 'Prospect';
    if (!attioToken) return res.status(500).json({ error: 'Missing ATTIO_TOKEN' });

    const fields = req.body?.data?.fields || [];

    // Labels from your Tally test form
    const fullName       = pickField(fields, 'Full Name').trim();
    const companyName    = pickField(fields, 'Company Name').trim();
    const companyWebsite = pickField(fields, 'Company Website').trim();
    const email          = pickField(fields, 'Email Address').trim();

    if (!email) return res.status(400).json({ error: 'Email Address is required' });

    const { first: firstName, last: lastName } = splitName(fullName);

    const emailDomain = (email.split('@')[1] || '').toLowerCase();
    let domain = normalizeDomain(companyWebsite) || emailDomain;
    if (PERSONAL_DOMAINS.has(domain)) domain = '';

    const authHeaders = {
      Authorization: `Bearer ${attioToken}`,
      'Content-Type': 'application/json',
    };

    // 1) Upsert or create Company (by domain)
    let companyId = null;
    if (domain) {
      const displayName = companyName || companyNameFromDomain(domain);
      const cResp = await fetch(
        'https://api.attio.com/v2/objects/companies/records?matching_attribute=domains',
        { method: 'PUT', headers: authHeaders,
          body: JSON.stringify({ data: { values: { domains: [{ domain }], name: displayName } } }) }
      );
      const { raw: cRaw, json: cJson } = await readBody(cResp);
      console.log('[attio company upsert]', cResp.status, cRaw);
      if (cResp.ok) companyId = getId(cJson);
    }

    // 2) Upsert-or-Create Person — try several shapes for email field
    let personId = null;

    const upsertUrl = 'https://api.attio.com/v2/objects/people/records?matching_attribute=email_addresses';
    const baseName  = [{ first_name: firstName, last_name: lastName }];
    const emailVariants = [
      { email_addresses: [{ email_address: email }], name: baseName }, // expected
      { email_addresses: [{ email: email }],        name: baseName },  // alt
      { email_addresses: [email],                    name: baseName },  // alt
      { emails: [{ email }],                         name: baseName },  // alt
      { emails: [email],                              name: baseName },  // alt
    ];

    let r = await tryPersonWrite({
      method: 'PUT',
      authHeaders,
      url: upsertUrl,
      valuesVariants: emailVariants,
      logPrefix: '[attio people upsert]',
    });

    if (!r.ok) {
      const createUrl = 'https://api.attio.com/v2/objects/people/records';
      r = await tryPersonWrite({
        method: 'POST',
        authHeaders,
        url: createUrl,
        valuesVariants: emailVariants,
        logPrefix: '[attio people create fallback]',
      });
    }

    if (!r.ok) return res.status(502).json({ error: 'Attio people error (all variants failed)' });
    personId = r.id || null;

    // 3) Create Deal and associate person (and company if we have it)
    const displayCompany = domain ? (companyName || companyNameFromDomain(domain)) : '';
    const dealName = `Inbound — ${fullName || email}${displayCompany ? ' @ ' + displayCompany : ''}`;

    const dealValues = {
      name: dealName,
      stage: initialStage,
      associated_people: personId
        ? [{ target_object: 'people', record_ids: [personId] }]
        : [{ target_object: 'people', email_addresses: [{ email_address: email }] }],
    };
    if (domain) {
      dealValues.associated_company = companyId
        ? { target_object: 'companies', record_ids: [companyId] }
        : { target_object: 'companies', domains: [{ domain }] };
    }

    const dResp = await fetch('https://api.attio.com/v2/objects/deals/records', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ data: { values: dealValues } })
    });
    const { raw: dRaw, json: dJson } = await readBody(dResp);
    console.log('[attio deal create]', dResp.status, dRaw);
    if (!dResp.ok) return res.status(502).json({ error: 'Attio deal error', detail: dRaw });

    console.log('[webhook] success');
    return res.status(200).json({ ok: true, personId, companyId, dealId: getId(dJson) });
  } catch (e) {
    console.error('[webhook] uncaught', e);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
