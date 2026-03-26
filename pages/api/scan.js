// pages/api/scan.js
//
// Lightweight proxy: browser calls this once per stock symbol.
// Returns the quick Yahoo data needed for scoring.
// No Finnhub calls here — just Yahoo. Runs in <300ms per call.
// Vercel's 10s limit is per-invocation, and each call only fetches ONE stock,
// so it can never time out.
 
export default async function handler(req, res) {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
 
  // Allow browser to call this endpoint
  res.setHeader('Access-Control-Allow-Origin', '*');
 
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol.toUpperCase()}?interval=1d&range=1y`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return res.status(200).json({ symbol, error: 'not found' });
 
    const json = await r.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return res.status(200).json({ symbol, error: 'no data' });
 
    const price = meta.regularMarketPrice;
    const hi    = meta.fiftyTwoWeekHigh || price * 1.2;
    const lo    = meta.fiftyTwoWeekLow  || price * 0.8;
    const range = hi - lo;
 
    return res.status(200).json({
      symbol:       symbol.toUpperCase(),
      price,
      yearHigh:     hi,
      yearLow:      lo,
      peRatio:      meta.trailingPE  ?? null,
      marketCap:    meta.marketCap   ?? null,
      lowProximity: range > 0 ? ((price - lo) / range) * 100 : 50,
      pctFromHigh:  hi > 0 ? ((hi - price) / hi) * 100 : 0,
    });
  } catch (err) {
    return res.status(200).json({ symbol, error: err.message });
  }
}
 
