// TEMPORARY diagnostics — delete after use.
// GET /api/kvdiag?key=<STATS_KEY> — returns non-secret KV connectivity diagnostics.
module.exports = async (req, res) => {
  const key = (req.query && req.query.key) || '';
  if (!process.env.STATS_KEY || key !== process.env.STATS_KEY) {
    res.status(403).json({ error: 'forbidden' }); return;
  }
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  let host = '';
  try { host = new URL(url).host; } catch (e) { host = 'INVALID_URL:' + String(url).slice(0, 40); }
  const diag = { hasUrl: !!url, hasToken: !!token, tokenLen: token.length, urlHost: host };
  if (!url || !token) { res.status(200).json({ ...diag, probe: 'skipped' }); return; }
  const EVENTS = ['play', 'over', 'share', 'ad_click', 'ad_done', 'stars_click', 'stars_done'];
  const mode = (req.query && req.query.mode) || 'ping';
  const cmds = mode === 'stats'
    ? EVENTS.map(e => ['GET', `pw:stats:2026-09-24:${e}`])
    : [['PING']];
  try {
    const r = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
    });
    const text = await r.text();
    diag.probe = { mode, httpStatus: r.status, bodySnippet: text.slice(0, 300) };
  } catch (err) {
    diag.probe = { fetchThrew: String(err && err.message || err).slice(0, 200) };
  }
  res.status(200).json(diag);
};
