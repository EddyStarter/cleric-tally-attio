// /api/tally-webhook.js
// Vercel Node.js serverless function (no framework)

// ======= CONFIG YOU GAVE ME =======
const DEAL_OWNER_USER_ID = 'a8e7af3f-6595-48ff-ab12-d13e9964ee51'; // your Attio user UUID
// ==================================

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

// Create or update Person by email
async function upsertPerson({ fullName, firstName, lastName, email }) {
  // prefer upsert by email
  const payload = {
    data: {
      attributes: {
        // Many workspaces want name.full_name; include both for broader compatibility
        name: { full_name: fullName || [firstName, lastName].filter(Boolean).join(' ') },
        email_addresses: email ? [{ email_address: email }] : [],
      }
    }
  };

  // Upsert-by-email (if supported); otherwise create fallback
  // We try the generic create; if workspace needs upsert key we handle “already exists” by searching.
  // 1) Try create
  let created = await attioFetch('/objects/people/records', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (created.ok) {
    const json = await created.json();
    return json.data.id;
  }

  // If creation failed (e.g., record exists or validation differences), fall back to: find by email, then update
  const detail = await created.text();
  console.log('[people create] non-200:', created.status, detail);

  if (!email) throw new Error('Person requires an email to upsert');

  // Search by email
  const search = await attioFetch(`/objects/people/records?query=${encodeURIComponent(email)}`);
  if (!search.ok) {
    const err = await search.text();
    throw new Error(`[people search] ${search.status} ${err}`);
  }
  const found = await search.json();
  const foundId = found?.data?.[0]?.id;
  if (!foundId) throw new Error(`Person not found by email "${email}" and create failed`);

  // Update the found record with provided name/emails
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

// Create or update Company by domain (if domain provided)
async function upsertCompany({ companyName, companyWebsite }) {
  const domain = normalizeDomain(companyWebsite);
  if (!domain && !companyName) return null;

  // We’ll prefer domain upsert; many workspaces enrich companies by domain automatically.
  if (domain) {
    const payload = {
      data: {
        attributes: {
          domains: [{ domain }],
          // name is optional if you want Attio enrichment to set it later
          ...(companyName ? { name: { full_name: companyName } } : {})
        }
      }
    };

    // try create
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

    // fallback: search by domain then patch
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

  // No domain, fallback to a name-only create (best effort)
  const payload = {
    data: {
      attributes: {
        name: { full_name: companyName }
      }
    }
  };
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

// Get the ID of the “Deal stage” option that matches INITIAL_STAGE_NAME
async function getDealStageOptionIdByName(stageName) {
  // List attributes for the Deals object, find the stage attribute & its options
  const attrsRes = await attioFetch('/objects/deals/attributes');
  if (!attrsRes.ok) {
    const err = await attrsRes.text();
    throw new Error(`[deals attributes] ${attrsRes.status} ${err}`);
  }
  const attrs = await attrsRes.json();
  const stageAttr = attrs?.data?.find(a => (a.slug || '').includes('stage') || (a.name || '').toLowerCase().includes('stage'));
  if (!stageAttr) {
    console.log('[deals attributes] Could not find a stage attribute. Returning null.');
    return null;
  }

  // Some APIs return options embedded; others require a second call.
  // First try embedded:
  let options = stageAttr?.options || stageAttr?.meta?.options || [];

  // If no embedded options, try fetching via attribute id endpoint (best guess)
  if (!options?.length && stageAttr.id) {
    const optRes = await attioFetch(`/objects/deals/attributes/${stageAttr.id}`);
    if (optRes.ok) {
      const optJson = await optRes.json();
      options = optJson?.data?.options || [];
    }
  }

  const match = options.find(o => (o.name || '').toLowerCase() === stageName.toLowerCase());
  if (!match) {
    console.log('[deals stage] No option matched name:', stageName, 'Available:', options.map(o => o.name));
    return null;
  }
  // Try id first; some APIs also accept slug/value
  return match.id || match.value || match.slug || null;
}

async function createDeal({ dealName, stageOptionId, personId, companyId }) {
  // Build minimal but valid payload. Shape varies by workspace; we keep it conservative.
  const attributes = {
    name: { full_name: dealName },
  };

  // Assign stage if we resolved one
  if (stageOptionId) {
    // Most workspaces accept “stage” (or “deal_stage”) as a select field with option id
    attributes.deal_stage = { id: stageOptionId };
  }

  // Associate person (recommended: “associated_people” with target ids)
  if (personId) {
    attributes.associated_people = [{ target_object: 'people', target_record_id: personId }];
  }

  // Associate company (best effort; some workspaces have “associated_companies”)
  if (companyId) {
    attributes.associated_companies = [{ target_object: 'companies', target_record_id: companyId }];
  }

  // Optional: set owner to you
  if (DEAL_OWNER_USER_ID) {
    attributes.deal_owner = { target_object: 'users', target_record_id: DEAL_OWNER_USER_ID };
  }

  const payload = { data: { attributes } };

  const res = await attioFetch('/objects/deals/records', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    console.log('[attio deal create] non-200:', res.status, err);
    // Helpful hint if a required field is missing:
    if (res.status === 400 && err.includes('Required value for attribute')) {
      console.log('Tip: Attio is telling us a Deal attribute is required by your workspace. ' +
        'Open Attio → Objects → Deals → Attributes and either (a) make it optional, or ' +
        '(b) tell me its slug and how to set it, and I’ll add it here.');
    }
    throw new Error(`Deal create failed (${res.status})`);
  }

  const json = await res.json();
  return json.data.id;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    // Visiting in a browser should show 405 (expected).
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const payload = req.body || {};
    const fields = payload.data?.fields || [];

    // ---- Read fields from your Tally test form ----
    // Labels must match your form exactly.
    const fullNameRaw = pickByLabel(fields, 'Full Name');
    const emailRaw = pickByLabel(fields, 'Email Address') || pickByLabel(fields, 'Work Email');
    const companyNameRaw = pickByLabel(fields, 'Company Name');
    const companyWebsiteRaw = pickByLabel(fields, 'Company Website');

    const fullName = ensureString(fullNameRaw);
    const email = ensureString(emailRaw).toLowerCase();
    const companyName = ensureString(companyNameRaw);
    const companyWebsite = ensureString(companyWebsiteRaw);

    // Split name (helps workspaces that track first/last under name)
    let firstName = '';
    let lastName = '';
    if (fullName) {
      const parts = fullName.trim().split(/\s+/);
      firstName = parts[0] || '';
      lastName = parts.slice(1).join(' ') || '';
    }

    // --- Create/Upsert Person ---
    const personId = await upsertPerson({
      fullName,
      firstName,
      lastName,
      email,
    });
    console.log('[person] id:', personId);

    // --- Create/Upsert Company (best effort, by domain) ---
    const companyId = await upsertCompany({
      companyName,
      companyWebsite,
    });
    console.log('[company] id:', companyId);

    // --- Resolve Deal stage option id by name (Prospect) ---
    const stageOptionId = await getDealStageOptionIdByName(INITIAL_STAGE_NAME);
    console.log('[deal stage option id] =>', stageOptionId, `(for "${INITIAL_STAGE_NAME}")`);

    // --- Create Deal ---
    const dealName = `Inbound · ${fullName || email}${companyName ? ` @ ${companyName}` : ''}`;
    const dealId = await createDeal({
      dealName,
      stageOptionId,
      personId,
      companyId,
    });
    console.log('[deal] id:', dealId);

    return res.status(200).json({
      ok: true,
      created: { personId, companyId, dealId },
    });

  } catch (e) {
    console.error('[webhook] uncaught:', e);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
