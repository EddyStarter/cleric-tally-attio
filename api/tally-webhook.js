// /api/tally-webhook.js  (TEMP smoke test)
// CommonJS (no ESM). Proves the webhook is reachable and logs env + payload.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    // This lets you check the route exists by visiting in a browser (405 is expected).
    return res.status(405).json({ ok: false, note: 'Method Not Allowed' });
  }

  const hasToken = !!process.env.ATTIO_TOKEN;
  const stage = process.env.ATTIO_INITIAL_STAGE;

  try {
    // Log the essentials so we can see them in Vercel -> Logs
    console.log('[smoke] method:', req.method);
    console.log('[smoke] has ATTIO_TOKEN:', hasToken);
    console.log('[smoke] ATTIO_INITIAL_STAGE:', stage);
    console.log('[smoke] headers content-type:', req.headers['content-type']);
    console.log('[smoke] body keys:', Object.keys(req.body || {}));

    // Also log a small preview of Tally payload fields if present
    const fields = req.body?.data?.fields || [];
    console.log('[smoke] Tally fields:', fields.map(f => ({ label: f.label, value: f.value })));

    return res.status(200).json({ ok: true, received: true });
  } catch (e) {
    console.error('[smoke] error:', e);
    return res.status(500).json({ ok: false, error: 'Smoke test failed' });
  }
};
