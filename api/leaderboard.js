// Vercel Serverless Function — /api/leaderboard
// Global + daily leaderboards for Puppy Wings, backed by Vercel KV (Upstash REST, zero deps).
//
// POST { initData?, anonId?, name?, score, mode } -> { ok, allRank, dailyRank }
//   Identity: a validated Telegram initData (HMAC, BOT_TOKEN — same scheme as
//   api/invoice.js) maps to member "tg:<user_id>" with the Telegram display name.
//   Otherwise the client sends its anonymous id ("anon:<uuid>", minted once and
//   kept in localStorage) plus a chosen nickname.
//   Only each player's best score is kept (ZADD GT). Daily board keyed by the
//   Asia/Shanghai date, expires after 45 days. Names live in one hash (90d TTL).
// GET ?board=all|daily&limit=20&me=<member> -> { board, day, entries, total }
//   entries: [{ rank, name, score, me }], rank is 1-based.
//
// Abuse guards: score must be an integer 0..2000, names are sanitized to 20 chars,
// light per-IP rate limit. Gameplay never depends on this endpoint.

const crypto = require('crypto');

// --- Telegram WebApp initData validation (same as api/invoice.js) ----------------
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function validateInitData(initData, botToken) {
  if (!initData || typeof initData !== 'string') return null;
  let params;
  try { params = new URLSearchParams(initData); } catch (e) { return null; }
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const pairs = [];
  params.forEach((value, key) => pairs.push(key + '=' + value));
  pairs.sort();
  const dataCheckString = pairs.join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calcHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const a = Buffer.from(calcHash, 'utf8');
  const b = Buffer.from(hash, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return params;
}

function cleanName(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20);
}

// --- Light per-IP rate limit ------------------------------------------------------
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 120;
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

function kv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function pipeline(k, cmds) {
  const r = await fetch(`${k.url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${k.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('kv ' + r.status);
  const data = await r.json();
  // Upstash /pipeline returns a top-level array: [{result:...}, ...]
  if (!Array.isArray(data)) throw new Error('kv shape');
  return data.map((d) => (d ? d.result : null));
}

// ZRANGE ... WITHSCORES -> [[member, score], ...], tolerating flat or nested shapes
function pairsOf(result) {
  if (!Array.isArray(result) || result.length === 0) return [];
  const out = [];
  if (Array.isArray(result[0])) {
    for (const p of result) out.push([String(p[0]), parseInt(p[1], 10) || 0]);
  } else {
    for (let i = 0; i + 1 < result.length; i += 2) {
      out.push([String(result[i]), parseInt(result[i + 1], 10) || 0]);
    }
  }
  return out;
}

const ALL_KEY = 'pw:lb:all';
const NAMES_KEY = 'pw:lb:names';
const DAY_TTL = 45 * 86400;
const NAMES_TTL = 90 * 86400;

module.exports = async (req, res) => {
  const k = kv();
  if (!k) { res.status(200).json({ ok: false, error: 'kv not configured' }); return; }
  if (isRateLimited(clientIp(req))) { res.status(200).json({ ok: false, error: 'rate' }); return; }

  try {
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }

      const score = Math.floor(Number(body && body.score));
      if (!Number.isFinite(score) || score < 0 || score > 2000) {
        res.status(200).json({ ok: false, error: 'bad score' }); return;
      }
      const dailyMode = body && body.mode === 'daily';

      // --- resolve identity ---
      let member = null;
      let name = '';
      const botToken = process.env.BOT_TOKEN;
      if (botToken) {
        const params = validateInitData(body && body.initData, botToken);
        if (params) {
          try {
            const u = JSON.parse(params.get('user') || '{}');
            if (u && u.id) {
              member = 'tg:' + String(u.id);
              name = cleanName([u.first_name, u.last_name].filter(Boolean).join(' ')) || '小飞狗';
            }
          } catch (e) { /* fall through to anon */ }
        }
      }
      if (!member) {
        const anonId = cleanName(body && body.anonId).replace(/[^a-zA-Z0-9-]/g, '');
        if (!anonId || anonId.length < 8 || anonId.length > 64) {
          res.status(200).json({ ok: false, error: 'bad identity' }); return;
        }
        member = 'anon:' + anonId;
        name = cleanName(body && body.name) || '小飞狗';
      }

      const day = shanghaiDay();
      const dailyKey = `pw:lb:daily:${day}`;
      const cmds = [
        ['ZADD', ALL_KEY, 'GT', String(score), member],
        ['HSET', NAMES_KEY, member, name],
        ['EXPIRE', NAMES_KEY, String(NAMES_TTL)],
      ];
      if (dailyMode) {
        cmds.push(['ZADD', dailyKey, 'GT', String(score), member]);
        cmds.push(['EXPIRE', dailyKey, String(DAY_TTL)]);
      }
      await pipeline(k, cmds);

      const ranks = await pipeline(k, [
        ['ZREVRANK', ALL_KEY, member],
        ...(dailyMode ? [['ZREVRANK', dailyKey, member]] : []),
      ]);
      res.status(200).json({
        ok: true,
        allRank: ranks[0] == null ? null : Number(ranks[0]),
        dailyRank: dailyMode ? (ranks[1] == null ? null : Number(ranks[1])) : null,
      });
      return;
    }

    if (req.method === 'GET') {
      const board = (req.query && req.query.board) === 'daily' ? 'daily' : 'all';
      const limit = Math.min(Math.max(parseInt((req.query && req.query.limit) || '20', 10) || 20, 1), 50);
      const me = cleanName((req.query && req.query.me) || '').slice(0, 80);
      const day = shanghaiDay();
      const key = board === 'daily' ? `pw:lb:daily:${day}` : ALL_KEY;

      const [rangeRes, totalRes, meRankRes] = await pipeline(k, [
        ['ZREVRANGE', key, '0', String(limit - 1), 'WITHSCORES'],
        ['ZCARD', key],
        ...(me ? [['ZREVRANK', key, me]] : []),
      ]);
      const pairs = pairsOf(rangeRes);
      let names = [];
      if (pairs.length) {
        const nameRes = await pipeline(k, [['HMGET', NAMES_KEY, ...pairs.map((p) => p[0])]]);
        names = Array.isArray(nameRes[0]) ? nameRes[0] : [];
      }
      const entries = pairs.map((p, i) => ({
        rank: i + 1,
        name: cleanName(names[i]) || '小飞狗',
        score: p[1],
        me: me ? p[0] === me : false,
      }));
      res.status(200).json({
        board, day, total: Number(totalRes) || 0, entries,
        meRank: me && meRankRes != null ? Number(meRankRes) : null,
      });
      return;
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    res.status(200).json({ ok: false, error: 'kv failed' });
  }
};
