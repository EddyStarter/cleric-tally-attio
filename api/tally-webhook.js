// api/tally-webhook.js
// Flow: Upsert Company -> Upsert Person -> Create Deal (link by record_ids when possible)

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
  const last = parts.length ? parts.join(' ') : '-';
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
  const core = domain.split('.').slice(0, -1).join('.') || domain.split('.')[0] || '';
  return titleCase(core.replace(/-/g, ' '));
}

const PERSONAL_DOMAINS = new Set([
  'gmail.com','yahoo.com','outlook.com','hotmail.com','icloud.com',
  'aol.com','proton.me','protonmail.com','live.com','me.com','mail.com'
]);

// Try hard to pull a record id from Attio responses regardless of shape
async function readJson(resp) {
  const text = await resp.text();
  try { return { json: JSON.parse(text), raw: text }; }
  catch { return { json: null, raw: text }; }
}
function extractRecordId(payload) {
  if (!payload) return null;
  // common shapes: {data:{id}}, {data:{record:{id}}}, {data:{records:[{id}]}}
  const d = payload.data || payload.record || payload;
  if (!d) return null;
  if (typeof d.id === 'string') return d.id;
  if (d.record && typeof d.record.id === 'string') return d.record.id;
  if (Array.isArray(d.records) && d.records[0]?.id) return d.records[0].id;
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const attioToken = process.env.ATTIO_TOKEN;
    const initialStage = process.env.ATTIO_INITIAL_STAGE || 'Prospect';
    if (!attioToken) return res.status(500).json({ error: 'Missing ATTIO_TOKEN env var' });

    const payload = req.body || {};
    const fields = payload?.data?.fields || [];

    // --- Read your Tally fields (exact labels from your form) ---
    const fullName = pickField(fields, 'Full Name').trim();
    const companyNameField = pickField(fields, 'Company Name').trim();
    const website = pickField(fields, 'Company Website').trim();
    const email = pickField(fields, 'Email Address').trim();

    if (!email) return res.status(400).json({ error: 'Email Address is required' });

    const { first: firstName, last: lastName } = splitName(fullName);
    const emailDomain = (email.split('@')[1] || '').toLowerCase();

    let domain = normalizeDomain(website) || emailDomain;
    if (PERSONAL_DOMAINS.has(domain)) domain = ''; // don’t create/link company for personal email domains

    // ---------- 1) Upsert Company (get companyId) ----------
    let companyId = null;
    if (domain) {
      const displayName = companyNameField || companyNameFromDomain(domain);
      const cResp = await fetch(
        'https://api.attio.com/v2/objects/companies/records?matching_attribute=domains',
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${attioToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            data: {
              values: {
                domains: [{ domain }],
                name: displayName,
              },
            },
          }),
        }
      );
      const { json: cJson, raw: cRaw } = await readJson(cResp);
      console.log('[attio company upsert]', cResp.status, cRaw);
      if (cResp.ok) companyId = extractRecordId(cJson);
      // non-200 here is not fatal; we’ll still proceed
    }

    // ---------- 2) Upsert Person (get personId) ----------
    const pResp = await fetch(
      'https://api.attio.com/v2/objects/people/records?matching_attribute=email_addresses',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${attioToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: {
            values: {
              email_addresses: [{ email_address: email, type: 'work' }],
              name: [{ first_name: firstName, last_name: lastName }],
            },
          },
        }),
      }
    );
    const { json: pJson, raw: pRaw } = await readJson(pResp);
    console.log('[attio people upsert]', pResp.status, pRaw);
    if (!pResp.ok) {
      return res.status(502).json({ error: 'Attio people error', detail: pRaw });
    }
    const personId = extractRecordId(pJson);

    // ---------- 3) Create Deal (link by IDs when available; fall back to email/domain) ----------
    const displayCompany = domain ? (companyNameField || companyNameFromDomain(domain)) : '';
    const dealName = `Inbound — ${fullName || email}${displayCompany ? ' @ ' + displayCompany : ''}`;

    const dealValues = {
      name: dealName,
      stage: initialStage,
    };

    // Link People
    if (personId) {
      dealValues.associated_people = [
        { target_object: 'people', record_ids: [personId] },
      ];
    } else {
      // fallback (shouldn't happen if upsert succeeded)
      dealValues.associated_people = [
        { target_object: 'people', email_addresses: [{ email_address: email }] },
      ];
    }

    // Link Company (if we have it)
    if (domain) {
      if (companyId) {
        dealValues.associated_company = {
          target_object: 'companies',
          record_ids: [companyId],
        };
      } else {
        // fallback by domain
        dealValues.associated_company = {
          target_object: 'companies',
          domains: [{ domain }],
        };
      }
    }

    const dResp = await fetch('https://api.attio.com/v2/objects/deals/records', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${attioToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data: { values: dealValues } }),
    });
    const { json: dJson, raw: dRaw } = await readJson(dResp);
    console.log('[attio deal create]', dResp.status, dRaw);
    if (!dResp.ok) {
      return res.status(502).json({ error: 'Attio deal error', detail: dRaw });
    }

    console.log('[webhook] success');
    return res.status(200).json({ ok: true, personId, companyId, dealId: extractRecordId(dJson) });
  } catch (e) {
    console.error('[webhook] uncaught', e);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
