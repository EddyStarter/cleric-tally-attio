// /api/tally-webhook.js

// This function handles incoming webhook requests from Tally.
// It's designed to be deployed as a Vercel Serverless Function.
// Using CommonJS syntax (`require` and `module.exports`) for compatibility.
const fetch = require('node-fetch');

// --- Environment Variables ---
// Ensure these are set in your Vercel project settings.
const ATTIO_TOKEN = process.env.ATTIO_TOKEN;
// The UUID of the pipeline stage you want new deals to be created in (e.g., "Prospect").
const ATTIO_INITIAL_STAGE_ID = process.env.ATTIO_INITIAL_STAGE_ID;
// The UUID of the user you want to assign new deals to.
const ATTIO_OWNER_ID = process.env.ATTIO_OWNER_ID;

// --- Attio API Configuration ---
const ATTIO_API_BASE = 'https://api.attio.com/v2';

/**
 * A helper function to make authenticated requests to the Attio API.
 * @param {string} endpoint - The API endpoint to call (e.g., '/objects/people/records').
 * @param {string} method - The HTTP method (e.g., 'POST', 'GET').
 * @param {object} [body=null] - The JSON payload for the request.
 * @returns {Promise<object>} - The JSON response from the API.
 */
const attioApiRequest = async (endpoint, method, body = null) => {
    const options = {
        method: method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${ATTIO_TOKEN}`,
        },
    };
    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(`${ATTIO_API_BASE}${endpoint}`, options);

    if (!response.ok) {
        const errorBody = await response.text();
        console.error(`Attio API Error (${response.status}):`, errorBody);
        throw new Error(`Failed Attio API request to ${endpoint} with status ${response.status}`);
    }

    return response.json();
};

/**
 * Finds an existing Person in Attio by email or creates a new one.
 * @param {string} email - The person's email address.
 * @param {string} firstName - The person's first name.
 * @param {string} lastName - The person's last name.
 * @returns {Promise<object>} - The Attio record object for the person.
 */
const findOrCreatePerson = async (email, firstName, lastName) => {
    console.log(`Searching for person with email: ${email}`);
    // First, try to find an existing person by their email address to avoid duplicates.
    const queryResponse = await attioApiRequest('/objects/people/records/query', 'POST', {
        query: {
            and: [
                {
                    attribute: 'email_addresses',
                    condition: 'contains',
                    value: email,
                },
            ],
        },
    });

    if (queryResponse.data && queryResponse.data.length > 0) {
        const existingPerson = queryResponse.data[0];
        console.log(`Found existing person with ID: ${existingPerson.id}`);
        return existingPerson;
    }

    // If no person is found, create a new one.
    console.log('No existing person found. Creating a new one.');
    const createResponse = await attioApiRequest('/objects/people/records', 'POST', {
        data: {
            values: {
                'first_name': [{ value: firstName }],
                'last_name': [{ value: lastName }],
                'email_addresses': [{
                    email_address: email,
                }],
            },
        },
    });
    console.log(`Created new person with ID: ${createResponse.data.id}`);
    return createResponse.data;
};

/**
 * Finds an existing Company in Attio by domain or creates a new one.
 * @param {string} companyName - The name of the company.
 * @param {string} companyDomain - The company's website domain.
 * @returns {Promise<object>} - The Attio record object for the company.
 */
const findOrCreateCompany = async (companyName, companyDomain) => {
    console.log(`Searching for company with domain: ${companyDomain}`);
    // First, try to find an existing company by domain to avoid duplicates.
    const queryResponse = await attioApiRequest('/objects/companies/records/query', 'POST', {
        query: {
            and: [{
                attribute: 'domains',
                condition: 'is',
                value: companyDomain
            }],
        },
    });

    if (queryResponse.data && queryResponse.data.length > 0) {
        const existingCompany = queryResponse.data[0];
        console.log(`Found existing company with ID: ${existingCompany.id}`);
        return existingCompany;
    }

    // If no company is found, create a new one.
    console.log('No existing company found. Creating a new one.');
    const createResponse = await attioApiRequest('/objects/companies/records', 'POST', {
        data: {
            values: {
                'name': [{ value: companyName }],
                'domains': [{ value: companyDomain }],
            },
        },
    });
    console.log(`Created new company with ID: ${createResponse.data.id}`);
    return createResponse.data;
};


/**
 * Creates a new Deal in Attio and associates it with a Person and Company.
 * @param {object} personRecord - The Attio person record object.
 * @param {object} companyRecord - The Attio company record object.
 * @returns {Promise<object>} - The Attio record object for the new deal.
 */
const createDeal = async (personRecord, companyRecord) => {
    console.log('Creating a new deal.');
    const dealName = `New Prospect - ${companyRecord.values.name[0].value}`;

    const dealPayload = {
        data: {
            values: {
                // --- Standard Attributes ---
                // These use special system-wide IDs
                'name': [{ value: dealName }],
                'deal-stage': [{
                    target_record_id: ATTIO_INITIAL_STAGE_ID,
                }],
                'assigned': [{
                    target_record_id: ATTIO_OWNER_ID,
                }],
                
                // --- FIX: Add required custom attributes with their specific API IDs ---
                // The IDs you provided are for your custom attributes.
                'e222e29e-a386-496f-94ac-e15e2f5bd99a': [{ currency: "USD", amount: 0 }], // Deal Value
                'fe9e8b49-1413-4520-83be-eb27482f2eb3': [{ value: new Date().toISOString().split('T')[0] }], // Close Date
                '6fd89118-1810-4e70-bd09-ee9c019f7f2c': [{ value: new Date().toISOString().split('T')[0] }], // Demo Date

                // --- Associations ---
                'companies': [{
                    target_record_id: companyRecord.id,
                }],
                'people': [{
                    target_record_id: personRecord.id,
                }],
            },
        },
    };

    const createResponse = await attioApiRequest('/objects/deals/records', 'POST', dealPayload);
    console.log(`Successfully created deal with ID: ${createResponse.data.id}`);
    return createResponse.data;
};


/**
 * The main handler for the Vercel Serverless Function.
 */
module.exports = async (req, res) => {
    console.log('--- TALLY WEBHOOK INVOCATION START ---');
    console.log(`Request received at: ${new Date().toISOString()}`);
    console.log('Raw Request Body:', JSON.stringify(req.body, null, 2));

    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).end('Method Not Allowed');
    }

    try {
        const payload = req.body;

        if (!payload || !payload.data || !payload.data.fields) {
            console.error('Invalid or empty payload received from Tally.');
            return res.status(400).json({ status: 'error', message: 'Payload is missing or malformed.' });
        }
        const fields = payload.data.fields;

        const getFieldValue = (label) => {
            const field = fields.find((f) => f.label === label);
            return field ? field.value : null;
        };

        const fullName = getFieldValue('Full Name');
        const email = getFieldValue('Email Address');
        const companyName = getFieldValue('Company Name');
        const companyWebsite = getFieldValue('Company Website');

        if (!fullName || !email || !companyName || !companyWebsite) {
            console.error('Missing required fields from Tally payload:', { fullName, email, companyName, companyWebsite });
            return res.status(400).json({ status: 'error', message: 'Missing required form fields.' });
        }
        
        const nameParts = fullName.split(' ');
        const firstName = nameParts.shift() || 'N/A';
        const lastName = nameParts.join(' ') || 'N/A';
        
        const fullUrl = companyWebsite.startsWith('http') ? companyWebsite : `https://${companyWebsite}`;
        const domain = new URL(fullUrl).hostname.replace('www.', '');

        const personRecord = await findOrCreatePerson(email, firstName, lastName);
        const companyRecord = await findOrCreateCompany(companyName, domain);
        await createDeal(personRecord, companyRecord);

        console.log('Workflow completed successfully.');
        res.status(200).json({ status: 'success', message: 'Person, Company, and Deal processed in Attio.' });

    } catch (error) {
        console.error('Webhook processing failed:', error);
        res.status(500).json({ status: 'error', message: 'An internal error occurred.', details: error.message });
    }
};
