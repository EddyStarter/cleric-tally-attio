// /api/tally-webhook.js
// Vercel Node.js serverless function

// -------- helpers --------
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

// -------- handler --------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    // When you visit this URL in a browser you'll see 405 — that's expected
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const payload = req.body || {};
    const fields = payload?.data?.fields || [];

    // Labels your test form uses (case-insensitive)
    const fullName =
      (pickField(fields, "What's your name?") || '').trim();
    const email =
      (pickField(fields, 'Work Email') || pickField(fields, 'Work email') || '').trim();
    const website =
      (pickField(fields, 'Company Website') || pickField(fields, 'Company website') || '').trim();

    // If later you add the extra fields, these get included in description:
    const brings = pickMulti(fields, 'What brings you to Cleric?');
    const kubernetes = (pickField(fields, 'Do you deploy workloads to Kubernetes?') || '').trim();
    const observability = pickMulti(fields, 'Observability');
    const startWhen = (pickField(fields, 'When do you want to start?') || '').trim();

    if (!email) return res.status(400).json({ error: 'Email is required' });

    const domain = normalizeDomain(website) || (email.split('@')[1] || '');

    const descriptionParts = [
      brings.length ? `What brings you: ${brings.join(', ')}` : '',
      kubernetes ? `Kubernetes: ${kubernetes}` : '',
      observability.length ? `Observability: ${observability.join(', ')}` : '',
      startWhen ? `Start: ${startWhen}` : ''
    ].filter(Boolean);
    const description = descriptionParts.join(' | ');

    // --- Attio setup ---
    const attioToken = process.env.ATTIO_TOKEN;
    if (!attioToken) return res.status(500).json({ error: 'Missing ATTIO_TOKEN env var' });

    const initialStage = process.env.ATTIO_INITIAL_STAGE || 'Prospect';

    // --- 1) Upsert Person (match by email) ---
    const personResp = await fetch(
      'https://api.attio.com/v2/objects/people/records?matching_attribute=email_addresses',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${attioToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          data: {
            values: {
              email_addresses: [email],
              name: fullName ? [{ full_name: fullName }] : undefined,
              description: description || undefined,
              // hint/link company via domain
              company: domain
                ? [{ target_object: 'companies', domains: [{ domain }] }]
                : undefined
            }
          }
        })
      }
    );

    if (!personResp.ok) {
      const err = await personResp.text();
      console.error('Attio people error:', err);
      return res.status(502).json({ error: 'Attio people error', detail: err });
    }

    // --- 2) Create Deal in Prospect & link Person (+ Company if domain) ---
    const values = {
      name: `Inbound — ${fullName || email}`,
      stage: initialStage,
      associated_people: [
        { target_object: 'people', email_addresses: [{ email_address: email }] }
      ]
    };
    if (domain) {
      values.associated_company = {
        target_object: 'companies',
        domains: [{ domain }]
      };
    }

    const dealResp = await fetch('https://api.attio.com/v2/objects/deals/records', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${attioToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ data: { values } })
    });

    if (!dealResp.ok) {
      const err = await dealResp.text();
      console.error('Attio deal error:', err);
      return res.status(502).json({ error: 'Attio deal error', detail: err });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Webhook error:', e);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
