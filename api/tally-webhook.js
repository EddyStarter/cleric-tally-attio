// /api/tally-webhook.js — minimal, hardened version

function pickField(fields, label) {
  return fields.find(f => (f.label || '').toLowerCase() === label.toLowerCase())?.value;
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

    // Inputs from Tally
    const fullName = (pickField(fields, 'Full Name') || pickField(fields, "What's your name?") || '').trim();
    const email = (pickField(fields, 'Work Email') || pickField(fields, 'Work email') || '').trim();
    // keep website out for now to avoid schema mismatches
    if (!email) return res.status(400).json({ error: 'Email is required' });

    // Split name safely (never send undefined)
    let firstName = '';
    let lastName = '';
    if (fullName) {
      const parts = fullName.split(/\s+/);
      firstName = parts.shift() || '-';
      lastName = parts.join(' ') || '-';
    } else {
      firstName = '-';
      lastName = '-';
    }

    // 1) Upsert Person by email (minimal, schema-correct)
    // NOTE: email_addresses expects objects: { email_address: "x@y.com" }
    const peopleUrl = 'https://api.attio.com/v2/objects/people/records?matching_attribute=email_addresses';
    const personBody = {
      data: {
        values: {
          email_addresses: [{ email_address: email }],
          name: [{ first_name: firstName, last_name: lastName }],
        },
      },
    };

    const pResp = await fetch(peopleUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${attioToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(personBody),
    });
    const pText = await pResp.text();
    console.log('[attio people]', pResp.status, pText);
    if (!pResp.ok) return res.status(502).json({ error: 'Attio people error', detail: pText });

    // 2) Create Deal in initial stage, link by email (minimal)
    const dealsUrl = 'https://api.attio.com/v2/objects/deals/records';
    const dealBody = {
      data: {
        values: {
          name: `Inbound — ${fullName || email}`,
          stage: initialStage,
          associated_people: [
            {
              target_object: 'people',
              email_addresses: [{ email_address: email }],
            },
          ],
        },
      },
    };

    const dResp = await fetch(dealsUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${attioToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(dealBody),
    });
    const dText = await dResp.text();
    console.log('[attio deals]', dResp.status, dText);
    if (!dResp.ok) return res.status(502).json({ error: 'Attio deal error', detail: dText });

    console.log('[webhook] success');
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[webhook] uncaught', e);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
