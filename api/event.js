// Vercel Serverless Function — POST /api/event
// Tiny own-analytics beacon sink backed by Vercel KV (Upstash REST, zero deps).
//
// Setup (one time, in the Vercel dashboard):
//   1. Project -> Storage -> Create Database -> KV -> Create -> connect to this project
//      (Vercel auto-adds KV_REST_API_URL and KV_REST_API_TOKEN), then redeploy.
//   2. Add env var STATS_KEY = <random string> (used by /api/stats only).
//
// Events are anonymous per-day counters: pw:stats:<YYYY-MM-DD (Asia/Shanghai)>:<event>
// Events: play, over, share, ad_click, ad_done, stars_click, stars_done
// No user IDs, no IP logging, no PII. Keys get a 90-day TTL.
//
// The beacon is fire-and-forget from the game: this endpoint always returns 200
// (ok:false when KV isn't configured yet), so gameplay never depends on it.

const ALLOWED = new Set(['play', 'over', 'share', 'ad_click', 'ad_done', 'stars_click', 'stars_done', 'daily_play', 'lb_view']);

// Light best-effort per-IP rate limit (same pattern as api/invoice.js).
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 180;
const rateBuckets = new Map();
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function isRateLimited(ip) {
  const now = Date.now();
  const b = rateBuckets.get(ip);
  if (!b || now - b.t0 > RATE_WINDOW_MS) { rateBuckets.set(ip, { t0: now, n: 1 }); return false; }
  b.n += 1;
  return b.n > RATE_MAX;
}
function shanghaiDay() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const e = body && body.e;
  if (!url || !token || !ALLOWED.has(e) || isRateLimited(clientIp(req))) {
    res.status(200).json({ ok: false });
    return;
  }
  const key = `pw:stats:${shanghaiDay()}:${e}`;
  try {
    const r = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([[ 'INCR', key ], [ 'EXPIRE', key, String(90 * 86400) ]]),
    });
    if (!r.ok) throw new Error('kv ' + r.status);
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(200).json({ ok: false });
  }
};
