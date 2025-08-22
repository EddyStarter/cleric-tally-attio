// /api/tally-webhook.js
// /api/tally-webhook.js
// Vercel Serverless Function (Node.js 18+, CommonJS). Uses built-in fetch.

const ATTIO_TOKEN = process.env.ATTIO_TOKEN;                         // REQUIRED
const ATTIO_OWNER_EMAIL = process.env.ATTIO_OWNER_EMAIL || null;     // RECOMMENDED
const ATTIO_INITIAL_STAGE_TITLE = process.env.ATTIO_INITIAL_STAGE_TITLE || "Prospect"; // Stage title string

const ATTIO_API_BASE = "https://api.attio.com/v2";

// ---- Safe JSON
async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

// ---- Low-level Attio caller (propagates error JSON; never throws unhandled)
async function attioApiRequest(endpoint, method, body = null) {
  const res = await fetch(`${ATTIO_API_BASE}${endpoint}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ATTIO_TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const errBody = await safeJson(res);
    console.error("--- ATTIO API ERROR RESPONSE ---");
    console.error(JSON.stringify(errBody || {}, null, 2));
    console.error("--------------------------------");
    const e = new Error(`Attio ${endpoint} failed with status ${res.status}`);
    e.details = errBody;
    throw e;
  }
  return safeJson(res);
}

// ---- Assert helpers (UPSERT) using natural keys (email/domain/external id)

// People by email
async function assertPersonByEmail(email, firstName, lastName) {
  const values = {
    email_addresses: [{ email_address: email }],
  };
  if (firstName || lastName) {
    values.name = [{
      full_name: [firstName, lastName].filter(Boolean).join(" "),
      first_name: firstName || undefined,
      last_name: lastName || undefined,
    }];
  }
  const resp = await attioApiRequest(
    "/objects/people/records?matching_attribute=email_addresses",
    "PUT",
    { data: { values } }
  );
  return resp?.data;
}

// Companies by domain
async function assertCompanyByDomain(companyName, domain) {
  const values = {
    name: [{ value: companyName }],
    // domains can be passed as plain strings; Attio normalizes
    domains: [domain],
  };
  const resp = await attioApiRequest(
    "/objects/companies/records?matching_attribute=domains",
    "PUT",
    { data: { values } }
  );
  return resp?.data;
}

// Deals by unique external_source_id
async function assertDealByExternalId({ externalId, dealName, stageTitle, ownerEmail, personEmail, companyDomain }) {
  const values = {
    name: [{ value: dealName }],
    stage: stageTitle, // write stage as STRING
    // Associate by natural keys (no IDs)
    associated_people: [
      {
        target_object: "people",
        email_addresses: [{ email_address: personEmail }],
      }
    ],
    associated_company: {
      target_object: "companies",
      // domains may be array of strings or objects; send string for simplicity
      domains: [companyDomain],
    },
    external_source_id: [{ value: externalId }],
  };

  if (ownerEmail) {
    // owner as plain email string
    values.owner = ownerEmail;
  }

  const resp = await attioApiRequest(
    "/objects/deals/records?matching_attribute=external_source_id",
    "PUT",
    { data: { values } }
  );
  return resp?.data;
}

// ---- Main handler
module.exports = async (req, res) => {
  try {
    console.log("--- TALLY WEBHOOK INVOCATION START ---", new Date().toISOString());

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).end("Method Not Allowed");
    }

    const payload = req.body;
    console.log("Raw Request Body:", JSON.stringify(payload || {}, null, 2));

    if (!payload || !payload.data || !Array.isArray(payload.data.fields)) {
      return res.status(400).json({ status: "error", message: "Payload is missing or malformed." });
    }

    const fields = payload.data.fields;
    const getField = (label) => (fields.find(f => f.label === label) || {}).value || null;

    const fullName = getField("Full Name") || "";
    const email = getField("Email Address");
    const companyName = getField("Company Name");
    const companyWebsite = getField("Company Website");

    if (!email || !companyName || !companyWebsite) {
      return res.status(400).json({ status: "error", message: "Missing required form fields." });
    }

    // Split name safely
    const parts = fullName.trim().split(/\s+/).filter(Boolean);
    const firstName = parts[0] || "";
    const lastName = parts.slice(1).join(" ") || "";

    // Normalize domain
    const fullUrl = companyWebsite.startsWith("http") ? companyWebsite : `https://${companyWebsite}`;
    let domain = "";
    try {
      domain = new URL(fullUrl).hostname.replace(/^www\./i, "");
    } catch {
      return res.status(400).json({ status: "error", message: "Invalid Company Website URL." });
    }

    // Stable external id (use Tally’s ids if present)
    const externalId = payload?.data?.responseId || payload?.data?.submissionId || `tally-${Date.now()}`;

    // 1) Upsert person & company
    const person = await assertPersonByEmail(email, firstName, lastName);
    const company = await assertCompanyByDomain(companyName, domain);
    console.log("Upserted person:", person?.id, "company:", company?.id);

    // 2) Upsert deal by unique id
    const dealName = `New Prospect - ${companyName}`;
    const deal = await assertDealByExternalId({
      externalId,
      dealName,
      stageTitle: ATTIO_INITIAL_STAGE_TITLE,
      ownerEmail: ATTIO_OWNER_EMAIL,
      personEmail: email,
      companyDomain: domain,
    });

    console.log("Upserted deal:", deal?.id);
    return res.status(200).json({ status: "success", message: "Person, Company, and Deal processed in Attio." });
  } catch (err) {
    // Never crash the function: always return JSON, include Attio error when debug=1
    console.error("Webhook processing failed:", err);
    const debug = (req.query && (req.query.debug === "1" || req.query.debug === "true"));
    const body = {
      status: "error",
      message: "An internal error occurred.",
      details: String(err?.message || err),
    };
    if (debug && err && err.details) body.attio_error = err.details;
    return res.status(500).json(body);
  }
};
