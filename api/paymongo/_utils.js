const crypto = require('crypto');

const PAYMONGO_API_BASE = 'https://api.paymongo.com';

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getOptionalEnv(name) {
  return process.env[name] || '';
}

function getPayMongoAuthHeader() {
  const secretKey = getRequiredEnv('PAYMONGO_SECRET_KEY');
  return `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`;
}

function pesosToCentavos(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return Math.round(amount * 100);
}

function getBaseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const raw = await readRawBody(req);
  if (!raw.length) return {};
  return JSON.parse(raw.toString('utf8'));
}

async function updateRegistration(registrationId, fields) {
  if (!registrationId) return null;

  const supabaseUrl = getRequiredEnv('SUPABASE_URL').replace(/\/$/, '');
  const serviceKey = getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');

  const response = await fetch(`${supabaseUrl}/rest/v1/registrations?id=eq.${encodeURIComponent(registrationId)}`, {
    method: 'PATCH',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(fields),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase update failed: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

async function getSupabaseRows(table, query) {
  const supabaseUrl = getRequiredEnv('SUPABASE_URL').replace(/\/$/, '');
  const serviceKey = getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(`${supabaseUrl}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase read failed: ${text}`);
  }

  return text ? JSON.parse(text) : [];
}

function parsePayMongoSignature(signatureHeader) {
  return String(signatureHeader || '')
    .split(',')
    .map(part => part.trim().split('='))
    .reduce((acc, [key, value]) => {
      if (key) acc[key] = value || '';
      return acc;
    }, {});
}

function verifyPayMongoSignature(rawBody, signatureHeader) {
  const webhookSecret = process.env.PAYMONGO_WEBHOOK_SECRET;
  if (!webhookSecret) return true;

  const parts = parsePayMongoSignature(signatureHeader);
  const timestamp = parts.t;
  const providedSignature = parts.li || parts.te;

  if (!timestamp || !providedSignature) return false;

  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(providedSignature);

  if (expectedBuffer.length !== providedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

module.exports = {
  PAYMONGO_API_BASE,
  sendJson,
  getPayMongoAuthHeader,
  getOptionalEnv,
  pesosToCentavos,
  getBaseUrl,
  readRawBody,
  readJsonBody,
  getSupabaseRows,
  updateRegistration,
  verifyPayMongoSignature,
};
