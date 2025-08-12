// api/tally-webhook.js
// Vercel serverless function (Web API style, Node 18+)

function normalizeDomain(raw) {
  if (!raw) return '';
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./, '');
  } catch { return ''; }
}

async function verifyTallySignature(request, rawBody) {
  const secret = process.env.TALLY_SIGNING_SECRET;
  if (!secret) return true; // skip verification if not configured
  const received = request.headers.get('tally-signature');
  const crypto = await import('node:crypto');
  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  return received === computed;
}

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // Read raw body for optional signature verification
  const raw = await request.text();
  if (!(await verifyTallySignature(request, raw))) {
    return new Response('Invalid signature', { status: 401 });
  }

  // Parse JSON
  let payload;
  try { payload = JSON.parse(raw || '{}'); }
  catch { return new Response('Bad JSON', { status: 400 }); }

  // Tally fields come as an array of { label, value }
  const fields = payload?.data?.fields || [];
  const pick = (label) =>
    fields.find(f => (f.label || '').toLowerCase() === label.toLowerCase())?.value;
  const pickMulti = (label) => {
    const f = fields.find(f => (f.label || '').toLowerCase() === label.toLowerCase());
    if (!f) return [];
    if (Array.isArray(f.value)) return f.value.map(v => (v?.label ?? v)).filter(Boolean);
    return typeof f.value === 'string' ? [f.value] : [];
  };

  // Labels from your website/screenshots
  const fullName = (pick("What's your name?") || '').trim();
  const email = (pick('Work email') || '').trim();
  const website = (pick('Company website') || '').trim();
  const brings = pickMulti('What brings you to Cleric?');
  const kubernetes = (pick('Do you deploy workloads to Kubernetes?') || '').trim();
  const observability = pickMulti('Observability');
  const startWhen = (pick('When do you want to start?') || '').trim();

  if (!email) return new Response('Email is required', { status: 400 });

  const domain = normalizeDomain(website) || (email.split('@')[1] || '');

  // Build a readable note for the record
  const descriptionLines = [
    brings.length ? `What brings you: ${brings.join(', ')}` : '',
    kubernetes ? `Kubernetes: ${kubernetes}` : '',
    observability.length ? `Observability: ${observability.join(', ')}` : '',
    startWhen ? `Start: ${startWhen}` : ''
  ].filter(Boolean);
  const description = descriptionLines.join(' | ');

  // 1) Upsert Person in Attio (idempotent by email)
  const personResp = await fetch(
    'https://api.attio.com/v2/objects/people/records?matching_attribute=email_addresses',
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${process.env.ATTIO_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        data: {
          values: {
            email_addresses: [email],
            name: fullName ? [{ full_name: fullName }] : undefined,
            description: description || undefined,
            // Hint/link a company by domain (Attio matches/creates)
            company: domain ? [{ target_object: 'companies', domains: [{ domain }] }] : undefined
          }
        }
      })
    }
  );

  if (!personResp.ok) {
    const err = await personResp.text();
    return new Response(`Attio people error: ${err}`, { status: 502 });
  }

  // 2) Create Deal in stage "Prospect" and associate person + company
  const values = {
    name: `Inbound — ${fullName || email}`,
    stage: process.env.ATTIO_INITIAL_STAGE || 'Prospect',
    associated_people: [
      { target_object: 'people', email_addresses: [{ email_address: email }] }
    ]
  };
  if (domain) {
    values.associated_company = { target_object: 'companies', domains: [{ domain }] };
  }

  const dealResp = await fetch('https://api.attio.com/v2/objects/deals/records', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.ATTIO_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ data: { values } })
  });

  if (!dealResp.ok) {
    const err = await dealResp.text();
    return new Response(`Attio deal error: ${err}`, { status: 502 });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
