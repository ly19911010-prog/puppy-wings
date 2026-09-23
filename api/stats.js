// Vercel Serverless Function — GET /api/stats?key=...&days=N
// Reads the anonymous counters written by POST /api/event.
// Guarded by the STATS_KEY env var: wrong/missing key -> 403. Keep the key out of the repo;
// the daily digest cron holds it in its (private) job instructions.

const EVENTS = ['play', 'over', 'share', 'ad_click', 'ad_done', 'stars_click', 'stars_done'];

function shanghaiDay(offsetDays) {
  return new Date(Date.now() + 8 * 3600 * 1000 - offsetDays * 86400000).toISOString().slice(0, 10);
}

module.exports = async (req, res) => {
  const key = (req.query && req.query.key) || '';
  if (!process.env.STATS_KEY || key !== process.env.STATS_KEY) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) { res.status(500).json({ error: 'kv not configured' }); return; }
  const days = Math.min(Math.max(parseInt((req.query && req.query.days) || '7', 10) || 7, 1), 31);
  const cmds = [];
  const dayList = [];
  for (let d = 0; d < days; d++) {
    const day = shanghaiDay(d);
    dayList.push(day);
    for (const e of EVENTS) cmds.push(['GET', `pw:stats:${day}:${e}`]);
  }
  try {
    const r = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
    });
    if (!r.ok) throw new Error('kv ' + r.status);
    const data = await r.json();
    // Upstash /pipeline returns a top-level array: [{result:...}, ...]
    const out = {};
    let i = 0;
    for (const day of dayList) {
      out[day] = {};
      for (const e of EVENTS) {
        const item = Array.isArray(data) ? data[i++] : null;
        const v = item ? item.result : null;
        out[day][e] = v == null ? 0 : (parseInt(v, 10) || 0);
      }
    }
    res.status(200).json({ days: out });
  } catch (err) {
    res.status(502).json({ error: 'kv read failed' });
  }
};
