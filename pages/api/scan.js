// pages/api/scan.js
//
// Receives ALL ticker symbols in one POST request.
// Fetches Yahoo Finance data for all of them concurrently (capped at 30 at once)
// and returns the full results array in a single response.
//
// Why POST not GET: URL length limit on GET would cap us at ~100 symbols.
// Why one call not many: eliminates sequential batch overhead that was causing timeouts.
//
// Typical timing: 183 stocks @ 30 concurrent = ~4-6 seconds total.
// Well within Vercel's 10s limit.
 
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
 
  const { symbols } = req.body;
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return res.status(400).json({ error: 'symbols array required' });
  }
 
  const clean = [...new Set(symbols.map(s => s.toUpperCase().trim()).filter(Boolean))];
 
  async function fetchOne(symbol) {
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }
      );
      if (!r.ok) return null;
      const json = await r.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (!meta?.regularMarketPrice) return null;
      const price = meta.regularMarketPrice;
      const hi    = meta.fiftyTwoWeekHigh || price * 1.2;
      const lo    = meta.fiftyTwoWeekLow  || price * 0.8;
      const range = hi - lo;
      return {
        symbol,
        price,
        yearHigh:     hi,
        yearLow:      lo,
        peRatio:      meta.trailingPE ?? null,
        marketCap:    meta.marketCap  ?? null,
        lowProximity: range > 0 ? ((price - lo) / range) * 100 : 50,
        pctFromHigh:  hi > 0 ? ((hi - price) / hi) * 100 : 0,
      };
    } catch { return null; }
  }
 
  // Fetch all in parallel with a concurrency cap of 30
  // (avoids overwhelming Yahoo while still being much faster than sequential)
  const CONCURRENCY = 30;
  const results = [];
  for (let i = 0; i < clean.length; i += CONCURRENCY) {
    const batch = clean.slice(i, i + CONCURRENCY);
    const batchRes = await Promise.all(batch.map(fetchOne));
    results.push(...batchRes.filter(Boolean));
  }
 
  return res.status(200).json({ results, total: clean.length });
}
 
