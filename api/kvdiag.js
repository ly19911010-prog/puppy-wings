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
  try {
    const r = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['PING']]),
    });
    const text = await r.text();
    diag.probe = { httpStatus: r.status, bodySnippet: text.slice(0, 200) };
  } catch (err) {
    diag.probe = { fetchThrew: String(err && err.message || err).slice(0, 200) };
  }
  res.status(200).json(diag);
};
