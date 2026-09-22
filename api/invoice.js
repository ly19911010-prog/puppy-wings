// Vercel Serverless Function — POST /api/invoice
// Creates a Telegram Stars invoice link for the game client.
//
// Setup:
//   1. In Vercel project Settings -> Environment Variables, add:
//        BOT_TOKEN = <the token @BotFather gave you for /newbot>
//   2. Deploy this repo (index.html at root + this file at api/invoice.js).
//
// Security:
//   - The client sends Telegram.WebApp.initData with the request; the server
//     validates its HMAC-SHA256 signature (Telegram WebApp validation scheme)
//     so only real players inside your Telegram Mini App can mint invoices.
//     Requests without valid initData are rejected (the game client falls back
//     to its free preview revive in that case).
//   - Light per-IP rate limit (60 req/min) to protect the bot's
//     createInvoiceLink quota from abuse.
//
// Pricing: amount is in Telegram Stars. 25 Stars ≈ $0.33.
// Telegram's cut + 21-day payout hold + 1000 Stars ($13) minimum withdrawal apply.
// Do a Fragment KYC in advance so payouts aren't blocked later.

const crypto = require('crypto');

const PRICES = {
  revive: { stars: 25, title: 'Puppy Wings — Revive', label: 'Revive' },
};

// --- Telegram WebApp initData validation ------------------------------------
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function validateInitData(initData, botToken) {
  if (!initData || typeof initData !== 'string') return false;
  let params;
  try {
    params = new URLSearchParams(initData);
  } catch (e) {
    return false;
  }
  const hash = params.get('hash');
  if (!hash) return false;
  params.delete('hash');
  const pairs = [];
  params.forEach((value, key) => pairs.push(key + '=' + value));
  pairs.sort();
  const dataCheckString = pairs.join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calcHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  // timing-safe compare to avoid leaking hash bytes through timing
  const a = Buffer.from(calcHash, 'utf8');
  const b = Buffer.from(hash, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- Simple per-IP rate limit (best-effort on warm serverless instances) ------
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 60;
const rateBuckets = new Map(); // ip -> array of timestamps
function isRateLimited(ip) {
  const now = Date.now();
  let hits = rateBuckets.get(ip) || [];
  hits = hits.filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  rateBuckets.set(ip, hits);
  // occasional cleanup so the map doesn't grow forever
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (v.length === 0 || now - v[v.length - 1] > RATE_WINDOW_MS) rateBuckets.delete(k);
    }
  }
  return hits.length > RATE_MAX;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) {
    res.status(500).json({ error: 'BOT_TOKEN not configured' });
    return;
  }

  if (isRateLimited(clientIp(req))) {
    res.status(429).json({ error: 'too many requests' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  // Only genuine Telegram Mini App sessions may mint invoice links.
  if (!validateInitData(body && body.initData, BOT_TOKEN)) {
    res.status(403).json({ error: 'invalid initData' });
    return;
  }

  const item = PRICES[(body && body.type) || ''];
  if (!item) {
    res.status(400).json({ error: 'unknown item type' });
    return;
  }

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: item.title,
        description: 'Continue your run right where you crashed, with a fresh shield.',
        payload: `revive:${Date.now()}`,
        provider_token: '',          // empty = Telegram Stars
        currency: 'XTR',             // XTR = Telegram Stars
        prices: [{ label: item.label, amount: item.stars }],
      }),
    });
    const data = await tgRes.json();
    if (!data.ok) {
      res.status(502).json({ error: 'telegram api error', detail: data.description });
      return;
    }
    res.status(200).json({ invoiceLink: data.result });
  } catch (e) {
    res.status(502).json({ error: 'invoice creation failed' });
  }
};

// Exported for unit tests (node -e "require('./api/invoice.js')" smoke checks).
module.exports.validateInitData = validateInitData;
module.exports.isRateLimited = isRateLimited;
module.exports.__resetRateBuckets = () => rateBuckets.clear();
