// /api/tally-webhook.js  (CommonJS for Vercel)
// Creates/updates Person + Company from Tally; creates a Deal and links them.

const DEAL_OWNER_USER_ID = 'a8e7af3f-6595-48ff-ab12-d13e9964ee51'; // your Attio user UUID
const ATTIO_BASE = 'https://api.attio.com/v2';
const ATTIO_TOKEN = process.env.ATTIO_TOKEN;
const INITIAL_STAGE_NAME = process.env.ATTIO_INITIAL_STAGE || 'Prospect';

// ---------- helpers ----------
function normalizeDomain(raw) {
  if (!raw) return '';
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

function pickByLabel(fields, label) {
  return (fields.find(f => (f.label || '').toLowerCase() === label.toLowerCase())?.value);
}

function ensureString(v) {
  if (Array.isArray(v)) return v.filter(Boolean).join(' ').trim();
  if (typeof v === 'number') return String(v);
  return (v || '').toString().trim();
}

async function attioFetch(path, init = {}) {
  const res = await fetch(`${ATTIO_BASE}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${ATTIO_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    }
  });
  return res;
}

// ---------- People ----------
async function upsertPerson({ fullName, firstName, lastName, email }) {
  const payload = {
    data: {
      attributes: {
        name: { full_name: fullName || [firstName, lastName].filter(Boolean).join(' ') },
        email_addresses: email ? [{ email_address: email }] : [],
      }
    }
  };

  // Try to create
  let created = await attioFetch('/objects/people/records', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (created.ok) {
    const json = await created.json();
    return json.data.id;
  }

  const detail = await created.text();
  console.log('[people create] non-200:', created.status, detail);

  if (!email) throw new Error('Person requires an email to upsert');

  // Search by email then patch
  const search = await attioFetch(`/objects/people/records?query=${encodeURIComponent(email)}`);
  if (!search.ok) {
    const err = await search.text();
    throw new Error(`[people search] ${search.status} ${err}`);
  }
  const found = await search.json();
  const foundId = found?.data?.[0]?.id;
  if (!foundId) throw new Error(`Person not found by email "${email}" and create failed`);

  const update = await attioFetch(`/objects/people/records/${foundId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  if (!update.ok) {
    const err = await update.text();
    throw new Error(`[people update] ${update.status} ${err}`);
  }
  return foundId;
}

// ---------- Companies ----------
async function upsertCompany({ companyName, companyWebsite }) {
  const domain = normalizeDomain(companyWebsite);
  if (!domain && !companyName) return null;

  if (domain) {
    const payload = {
      data: {
        attributes: {
          domains: [{ domain }],
          ...(companyName ? { name: { full_name: companyName } } : {})
        }
      }
    };

    let created = await attioFetch('/objects/companies/records', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (created.ok) {
      const json = await created.json();
      return json.data.id;
    }
    const detail = await created.text();
    console.log('[company create] non-200:', created.status, detail);

    const search = await attioFetch(`/objects/companies/records?query=${encodeURIComponent(domain)}`);
    if (!search.ok) {
      const err = await search.text();
      throw new Error(`[company search] ${search.status} ${err}`);
    }
    const found = await search.json();
    const foundId = found?.data?.[0]?.id;
    if (!foundId) return null;

    const update = await attioFetch(`/objects/companies/records/${foundId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    if (!update.ok) {
      const err = await update.text();
      throw new Error(`[company update] ${update.status} ${err}`);
    }
    return foundId;
  }

  // name-only fallback
  const payload = { data: { attributes: { name: { full_name: companyName } } } };
  const res = await attioFetch('/objects/companies/records', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    console.log('[company create (name only)] non-200:', res.status, err);
    return null;
  }
  const json = await res.json();
  return json.data.id;
}

// ---------- Deals ----------
async function listDealAttributes() {
  const attrsRes = await attioFetch('/objects/deals/attributes');
  if (!attrsRes.ok) {
    const err = await attrsRes.text();
    throw new Error(`[deals attributes] ${attrsRes.status} ${err}`);
  }
  const attrs = await attrsRes.json();
  return attrs?.data || [];
}

async function getDealStageOptionIdByName(stageName, dealAttrs) {
  const stageAttr =
    dealAttrs.find(a => (a.slug || '').includes('stage')) ||
    dealAttrs.find(a => (a.name || '').toLowerCase().includes('stage'));
  if (!stageAttr) {
    console.log('[deal stage] no stage attribute found');
    return null;
  }

  let options = stageAttr?.options || stageAttr?.meta?.options || [];
  if (!options?.length && stageAttr.id) {
    const optRes = await attioFetch(`/objects/deals/attributes/${stageAttr.id}`);
    if (optRes.ok) {
      const optJson = await optRes.json();
      options = optJson?.data?.options || [];
    }
  }

  const match = options.find(o => (o.name || '').toLowerCase() === stageName.toLowerCase());
  if (!match) {
    console.log('[deal stage] no match for', stageName, 'Available:', options.map(o => o.name));
    return null;
  }
  return match.id || match.value || match.slug || null;
}

function addBestGuessDefaultsForRequired(attrs, attributesOut) {
  // If your workspace has required attributes (e.g., currency, value, source, close date),
  // this tries to set reasonable placeholders so creation succeeds.
  for (const a of attrs) {
    const isRequired = a?.required === true || a?.meta?.required === true;
    if (!isRequired) continue;

    // If we already set it, skip
    if (a.slug && attributesOut[a.slug] != null) continue;

    const nameLC = (a.name || '').toLowerCase();
    const slugLC = (a.slug || '').toLowerCase();

    // Common patterns:
    if (/currency/.test(slugLC) || /currency/.test(nameLC)) {
      attributesOut[a.slug] = 'USD';
      continue;
    }
    if (/value|amount|deal_value/.test(slugLC) || /value|amount/.test(nameLC)) {
      // Some workspaces store number directly; others have { amount, currency } split across fields.
      // We'll set a numeric 0 if the attribute looks numeric.
      attributesOut[a.slug] = 0;
      continue;
    }
    if (/close\s*date|expected\s*close/.test(nameLC)) {
      attributesOut[a.slug] = new Date().toISOString();
      continue;
    }
    if (/source/.test(slugLC) || /source/.test(nameLC)) {
      attributesOut[a.slug] = 'Inbound';
      continue;
    }
    if (/owner/.test(slugLC) || /owner/.test(nameLC)) {
      attributesOut[a.slug] = { target_object: 'users', target_record_id: DEAL_OWNER_USER_ID };
      continue;
    }

    // As last resort, leave it unset but log it so we can add an exact mapping.
    console.log('[deal required attr not set]', { id: a.id, slug: a.slug, name: a.name, type: a.type });
  }
}

async function createDeal({ dealName, stageOptionId, personId, companyId }) {
  const dealAttrs = await listDealAttributes();

  // Build attributes with what we know is safe
  const attributes = {
    name: { full_name: dealName },
  };

  // associations
  if (personId) {
    attributes.associated_people = [{ target_object: 'people', target_record_id: personId }];
  }
  if (companyId) {
    attributes.associated_companies = [{ target_object: 'companies', target_record_id: companyId }];
  }

  // stage
  if (stageOptionId) {
    // the slug in most workspaces is deal_stage (select)
    attributes.deal_stage = { id: stageOptionId };
  }

  // owner
  if (DEAL_OWNER_USER_ID) {
    attributes.deal_owner = { target_object: 'users', target_record_id: DEAL_OWNER_USER_ID };
  }

  // Add best-guess defaults for any required attributes we didn't set yet
  addBestGuessDefaultsForRequired(dealAttrs, attributes);

  const payload = { data: { attributes } };

  const res = await attioFetch('/objects/deals/records', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.log('[attio deal create] non-200:', res.status, errText);

    // If Attio tells us exactly which attribute ID is missing, look it up and log a friendly name
    const m = errText.match(/attribute with ID "([0-9a-f-]+)"/i);
    if (m) {
      const attrId = m[1];
      const attrRes = await attioFetch(`/objects/deals/attributes/${attrId}`);
      if (attrRes.ok) {
        const attrJson = await attrRes.json();
        console.log('[deal required attr details]', {
          id: attrId,
          slug: attrJson?.data?.slug,
          name: attrJson?.data?.name,
          type: attrJson?.data?.type,
        });
      } else {
        console.log('[deal required attr details] lookup failed', await attrRes.text());
      }
    }

    throw new Error(`Deal create failed (${res.status})`);
  }

  const json = await res.json();
  return json.data.id;
}

// ---------- handler ----------
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const payload = req.body || {};
    const fields = payload.data?.fields || [];

    // Read from Tally (labels must match)
    const fullNameRaw = pickByLabel(fields, 'Full Name');
    const emailRaw = pickByLabel(fields, 'Email Address') || pickByLabel(fields, 'Work Email');
    const companyNameRaw = pickByLabel(fields, 'Company Name');
    const companyWebsiteRaw = pickByLabel(fields, 'Company Website');

    const fullName = ensureString(fullNameRaw);
    const email = ensureString(emailRaw).toLowerCase();
    const companyName = ensureString(companyNameRaw);
    const companyWebsite = ensureString(companyWebsiteRaw);

    // Split name (helpful for some workspaces)
    let firstName = '';
    let lastName = '';
    if (fullName) {
      const parts = fullName.trim().split(/\s+/);
      firstName = parts[0] || '';
      lastName = parts.slice(1).join(' ') || '';
    }

    // 1) person
    const personId = await upsertPerson({ fullName, firstName, lastName, email });
    console.log('[person] id:', personId);

    // 2) company
    const companyId = await upsertCompany({ companyName, companyWebsite });
    console.log('[company] id:', companyId);

    // 3) deal stage
    const dealAttrs = await listDealAttributes();
    const stageOptionId = await getDealStageOptionIdByName(INITIAL_STAGE_NAME, dealAttrs);
    console.log('[deal stage option id] =>', stageOptionId, `(for "${INITIAL_STAGE_NAME}")`);

    // 4) deal
    const dealName = `Inbound · ${fullName || email}${companyName ? ` @ ${companyName}` : ''}`;
    const dealId = await createDeal({ dealName, stageOptionId, personId, companyId });
    console.log('[deal] id:', dealId);

    return res.status(200).json({ ok: true, created: { personId, companyId, dealId } });
  } catch (e) {
    console.error('[webhook] uncaught:', e);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};
