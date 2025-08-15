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
                    // Note: The 'type' key was removed as per your findings.
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
                // --- Standard & Required Attributes ---
                'deal_name': [{ value: dealName }],
                'deal_stage': [{
                    target_record_id: ATTIO_INITIAL_STAGE_ID,
                }],
                'owner': [{
                    target_record_id: ATTIO_OWNER_ID,
                }],

                // --- Associations ---
                // Link the deal to the company record.
                'associated_company': [{
                    target_record_id: companyRecord.id,
                }],
                // Link the deal to the person record.
                'associated_people': [{
                    target_record_id: personRecord.id,
                }],

                // --- Optional / Custom Attributes ---
                // Add any other required custom attributes for your deals here.
                // Example for a "Source" select attribute:
                // 'source': [{ option: "Website" }],
                // Example for a "Value" currency attribute:
                // 'value': [{ currency: "USD", amount: 10000 }],
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
    // Only allow POST requests
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).end('Method Not Allowed');
    }

    try {
        console.log('Received Tally webhook.');
        const payload = req.body;
        const fields = payload.data.fields;

        // --- Helper function to find a field by its label ---
        const getFieldValue = (label) => {
            const field = fields.find((f) => f.label === label);
            return field ? field.value : null;
        };

        // --- Extract data from Tally form fields ---
        // IMPORTANT: These labels must exactly match the labels in your Tally form.
        const fullName = getFieldValue('Full Name');
        const email = getFieldValue('Email Address');
        const companyName = getFieldValue('Company Name');
        const companyWebsite = getFieldValue('Company Website');

        // Basic validation
        if (!fullName || !email || !companyName || !companyWebsite) {
            console.error('Missing required fields from Tally payload:', { fullName, email, companyName, companyWebsite });
            return res.status(400).json({ status: 'error', message: 'Missing required form fields.' });
        }
        
        // --- Process Data ---
        const nameParts = fullName.split(' ');
        const firstName = nameParts.shift() || 'N/A';
        const lastName = nameParts.join(' ') || 'N/A';
        
        // Extract domain from URL
        const domain = new URL(companyWebsite).hostname.replace('www.', '');

        // --- Attio Workflow ---
        // 1. Find or create the Person
        const personRecord = await findOrCreatePerson(email, firstName, lastName);

        // 2. Find or create the Company
        const companyRecord = await findOrCreateCompany(companyName, domain);

        // 3. Create the Deal and link it
        await createDeal(personRecord, companyRecord);

        // --- Success Response ---
        console.log('Workflow completed successfully.');
        res.status(200).json({ status: 'success', message: 'Person, Company, and Deal processed in Attio.' });

    } catch (error) {
        console.error('Webhook processing failed:', error);
        res.status(500).json({ status: 'error', message: 'An internal error occurred.' });
    }
};
