// api/tally-webhook.js
// Tally → Attio: Company upsert → Person upsert (full_name) → Deal create
// Fixes: record-reference shapes use target_record_id / strings (not record_ids)

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
  const last  = parts.length ? parts.join(' ') : '-';
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
  const core = domain.split('.').slice(0, -1).join(' ') || domain.split('.')[0] || '';
  return titleCase(core.replace(/-/g, ' '));
}

const PERSONAL_DOMAINS = new Set([
  'gmail.com','yahoo.com','outlook.com','hotmail.com','icloud.com',
  'aol.com','proton.me','protonmail.com','live.com','me.com','mail.com'
]);

async function readBody(resp) {
  const raw = await resp.text();
  try { return { raw, json: JSON.parse(raw) }; }
  catch { return { raw, json: null }; }
}
function getId(payload) {
  if (!payload) return null;
  const d = payload.data || payload.record || payload;
  if (!d) return null;
  if (typeof d.id === 'string') return d.id;
  if (d.record && typeof d.record.id === 'string') return d.record.id;
  if (Array.isArray(d.records) && typeof d.records[0]?.id === 'string') return d.records[0].id;
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const attioToken   = process.env.ATTIO_TOKEN;
    const initialStage = process.env.ATTIO_INITIAL_STAGE || 'Prospect'; // stage accepts the title string
    if (!attioToken) return res.status(500).json({ error: 'Missing ATTIO_TOKEN' });

    const fields = req.body?.data?.fields || [];

    // Your Tally labels
    const fullName       = pickField(fields, 'Full Name').trim();
    const companyName    = pickField(fields, 'Company Nam
