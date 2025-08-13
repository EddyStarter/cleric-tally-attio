// 1) Upsert Person by email — MINIMAL (no name yet)
const peopleUrl = 'https://api.attio.com/v2/objects/people/records?matching_attribute=email_addresses';
const personBody = {
  data: {
    values: {
      // Attio accepts an array of objects with "email_address"
      email_addresses: [{ email_address: email }],
      // (no "name" for now — we'll add it after we get a 200 here)
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
