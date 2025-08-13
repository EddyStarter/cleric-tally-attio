// api/tally-webhook.js

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
  return fields.find(f => (f.label || '').toLowerCase() === label.toLowerCase())?.value || '';
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const payload = req.body || {};
    const fields = payload.data?.fields || [];

    // Extract form values
    const fullName = pickField(fields, 'Full Name').trim();
    const companyNameField = pickField(fields, 'Company Name').trim();
    const companyWebsite = pickField(fields, 'Company Website').trim();
    const email = pickField(fields, 'Email Address').trim();

    // Split full name
    let firstName = '';
    let lastName = '';
    if (fullName) {
      const parts = fullName.split(' ');
      firstName = parts[0];
      lastName = parts.slice(1).join(' ') || '-';
    }

    // Determine domain for company linking
    const emailDomain = (email.split('@')[1] || '').toLowerCase();
    let domain = normalizeDomain(companyWebsite) || emailDomain;
    if (PERSONAL_DOMAINS.has(domain)) domain = '';

    const attioToken = process.env.ATTIO_TOKEN;
    const initialStage = process.env.ATTIO_INITIAL_STAGE;

    // 1) Upsert Person
    await fetch('https://api.attio.com/v2/objects/people/records', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${attioToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: {
          values: {
            name: [{ first_name: firstName, last_name: lastName }],
            email_addresses: [{ email_address: email, type: 'work' }],
          },
        },
      }),
    });

    // 2) Upsert Company
    if (domain) {
      const displayName = companyNameField || companyNameFromDomain(domain);
      await fetch('https://api.attio.com/v2/objects/companies/records?matching_attribute=domains', {
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
      });
    }

    // 3) Create Deal
    const displayCompany = domain ? (companyNameField || companyNameFromDomain(domain)) : '';
    const dealName = `Inbound — ${fullName || email}${displayCompany ? ' @ ' + displayCompany : ''}`;
    const dealValues = {
      name: dealName,
      stage: initialStage,
      associated_people: [
        { target_object: 'people', email_addresses: [{ email_address: email }] },
      ],
    };
    if (domain) {
      dealValues.associated_company = { target_object: 'companies', domains: [{ domain }] };
    }

    await fetch('https://api.attio.com/v2/objects/deals/records', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${attioToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data: { values: dealValues } }),
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('[webhook error]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}
