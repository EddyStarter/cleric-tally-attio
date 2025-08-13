// /api/tally-webhook.js
// Vercel Node.js serverless function

// ---------- helpers ----------
function normalizeDomain(raw) {
  if (!raw) return '';
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
function pickField(fields, label) {
  return fields.find(f => (f.label || '').toLowerCase() === label.toLowerCase())?.value;
}
function pickMulti(fields, label) {
  const f = fields.find(f => (f.label || '').toLowerCase() === label.toLowerCase());
  if (!f) return [];
  if (Array.isArray(f.value)) return f.value.map(v => (v?.label ?? v)).filter(Boolean);
  return typeof f.value === 'string' ? [f.value] : [];
}

// ---------- handler ----------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    // Visiting this URL in a browser should show 405 (expected).
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const payload = req.body || {};
    const fields = payload?.data?.fields || [];

    // Read fields from your Tally test form
    const fullNameInput =
      (pickField(fields, 'Full Name') ||
        pickField(fields, "What's your name?") ||
        '').trim();

    // Split full name into first/last for Attio's "name" attribute
    let firstName = '';
    let lastName = '';
    if (fullNameInput) {
      const parts = fullNameInput.split(/\s+/);
      firstName = parts.shift() || '';
      lastName = parts.join(' ') || '-'; // fallback so last_name is never undefined
    }

    const email =
      (pickField(fields, 'Work Email') ||
        pickField(fields, 'Work email') ||
        '').trim();

    const website = (
      pickField(fields, 'Company Website') ||
      pickField(fields, 'Company website') ||
      ''
    ).trim();

    const brings = pickMulti(fields, 'What brings you to Cleric?');
    const kubernetes = (pickField(fields, 'Do you deploy workloads to Kubernetes?') || '').trim();
    const observability = pickMulti(fields, 'Observability');
    const startWhen = (pickField(fields, 'When do you want to start?') || '').trim();

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const domain = normalizeDomain(website) || (email.split('@')[1] || '');
    const descriptionParts = [
      brings.length ? `What brings you: ${brings.join(', ')}` : '',
      kubernetes ? `Kubernetes: ${kubernetes}` : '',
      observability.length ? `Observability: ${observability.join(', ')}` : '',
      startWhen ? `Start: ${startWhen}` : ''
    ].filter(Boolean);
    const description = descriptionParts.join(' | ');

    // Env vars from Vercel
    const attioToken = process.env.ATTIO_TOKEN;
    const initialStage = process.env.ATTIO_INITIAL_STAGE || 'Prospect';
    if (!attioToken) {
      return res.status(500).json({ error: 'Missing ATTIO_TOKEN env var' });
    }

    // --- 1) Upsert Person (match by email) ---
    // Attio v2 People object expects the "name" attribute as first_name/last_name
    const peopleUrl = 'https://api.attio.com/v2/objects/people/records?matching_attribute=email_addresses';
    const personBody = {
      data: {
        values: {
          email_addresses: [email],
          name: [{ first_name: firstName || '-', last_name: lastName || '-' }],
          description: description || undefined,
          company: domain
            ? [{ target_object: 'companies', domains: [{ domain }] }]
            : undefined
        }
      }
    };

    const personResp = await fetch(peopleUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${attioToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(personBody)
    });
    const personText = await personResp.text();
    if (!personResp.ok) {
      // Surface Attio validation errors clearly
      return res.status(502).json({ error: 'Attio people error', detail: personText });
    }

    // --- 2) Create Deal in initial stage & link Person (+ Company if domain) ---
    const values = {
      name: `Inbound — ${fullNameInput || email}`,
      stage: initialStage,
      associated_people: [
        { target_object: 'people', email_addresses: [{ email_address: email }] }
      ]
    };
    if (domain) {
      values.associated_company = { target_object: 'companies', domains: [{ domain }] };
    }

    const dealResp = await fetch('https://api.attio.com/v2/objects/deals/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${attioToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { values } })
    });
    const dealText = await dealResp.text();
    if (!dealResp.ok) {
      return res.status(502).json({ error: 'Attio deal error', detail: dealText });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Webhook error:', e);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
