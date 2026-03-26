// pages/api/top3.js
//
// The simplest possible approach: reuse the EXACT same analyse.js logic
// that already works for the custom scan. We just call it internally.
//
// GET  — return cache (instant)
// POST { tickers, totalScanned } — run analyse on top candidates, cache result
 
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
 
export default async function handler(req, res) {
 
  // ── GET: serve cache instantly ────────────────────────────────────────────
  if (req.method === 'GET') {
    if (cache.data && Date.now() - cache.timestamp < CACHE_TTL) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(cache.data);
    }
    return res.status(200).json({ top3: [], totalScanned: 0, empty: true });
  }
 
  // ── POST: analyse tickers using the same endpoint as custom scan ──────────
  if (req.method === 'POST') {
    const { tickers, totalScanned } = req.body;
    if (!Array.isArray(tickers) || !tickers.length) {
      return res.status(400).json({ error: 'tickers required' });
    }
 
    try {
      // Build the absolute base URL for the internal call
      const proto    = req.headers['x-forwarded-proto'] || 'https';
      const host     = req.headers['x-forwarded-host'] || req.headers.host;
      const base     = `${proto}://${host}`;
 
      // Call /api/analyse — the SAME endpoint that powers the custom scan
      // This guarantees identical signal logic and data sources
      const analyseRes = await fetch(`${base}/api/analyse`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ tickers: tickers.slice(0, 6) }),
      });
 
      if (!analyseRes.ok) {
        const err = await analyseRes.json().catch(() => ({}));
        return res.status(500).json({ error: err.error || 'analyse failed' });
      }
 
      const analyseData = await analyseRes.json();
 
      // analyse.js returns { results: { AAPL: {...}, MSFT: {...} }, fetchedAt }
      const all = Object.values(analyseData.results || {})
        .filter(r => r && !r.error && r.score != null)
        .sort((a, b) => (b.score || 0) - (a.score || 0));
 
      // Remap field names: analyse.js uses `ticker`, top3 cards expect `ticker`
      // (they're the same — just ensure shape is correct)
      const top3 = all.slice(0, 3).map(r => ({
        ticker:    r.ticker,
        company:   r.company,
        exchange:  r.exchange || guessExchange(r.ticker),
        price:     r.price,
        change:    r.change,
        marketCap: r.marketCap,
        score:     r.score,
        signals:   r.signals,
        summary:   r.summary,
        rating:    r.rating,
        updatedAt: r.updatedAt,
      }));
 
      const data = {
        top3,
        totalScanned: totalScanned || 0,
        generatedAt:  new Date().toISOString(),
      };
 
      cache = { data, timestamp: Date.now() };
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json(data);
 
    } catch (err) {
      console.error('top3 error:', err);
      return res.status(500).json({ error: err.message });
    }
  }
 
  return res.status(405).json({ error: 'Method not allowed' });
}
 
// Fallback exchange lookup (analyse.js already sets this but just in case)
const XM = {AAPL:'NASDAQ',MSFT:'NASDAQ',GOOGL:'NASDAQ',AMZN:'NASDAQ',META:'NASDAQ',NVDA:'NASDAQ',AVGO:'NASDAQ',ORCL:'NYSE',ADBE:'NASDAQ',INTU:'NASDAQ',AMD:'NASDAQ',INTC:'NASDAQ',QCOM:'NASDAQ',TXN:'NASDAQ',AMAT:'NASDAQ',MU:'NASDAQ',NOW:'NYSE',CRM:'NYSE',PANW:'NASDAQ',CSCO:'NASDAQ',IBM:'NYSE',JPM:'NYSE',BAC:'NYSE',WFC:'NYSE',GS:'NYSE',MS:'NYSE',BLK:'NYSE',C:'NYSE',AXP:'NYSE',SCHW:'NYSE',MA:'NYSE',V:'NYSE',LLY:'NYSE',JNJ:'NYSE',UNH:'NYSE',ABBV:'NYSE',MRK:'NYSE',PFE:'NYSE',TMO:'NYSE',ABT:'NYSE',AMGN:'NASDAQ',CVS:'NYSE',MDT:'NYSE',ISRG:'NASDAQ',XOM:'NYSE',CVX:'NYSE',COP:'NYSE',EOG:'NYSE',SLB:'NYSE',MPC:'NYSE',HD:'NYSE',MCD:'NYSE',NKE:'NYSE',SBUX:'NASDAQ',LOW:'NYSE',TGT:'NYSE',COST:'NASDAQ',WMT:'NYSE',KO:'NYSE',PEP:'NASDAQ',PG:'NYSE',PM:'NYSE',MO:'NYSE',T:'NYSE',VZ:'NYSE',TMUS:'NASDAQ',NEE:'NYSE',LIN:'NYSE',CAT:'NYSE',HON:'NASDAQ',GE:'NYSE',RTX:'NYSE',LMT:'NYSE',UPS:'NYSE',UNP:'NYSE',TSM:'NYSE',ASML:'NASDAQ',NVO:'NYSE',AZN:'NASDAQ',HSBC:'NYSE',SHEL:'NYSE',BHP:'NYSE',RIO:'NYSE'};
function guessExchange(ticker) { return XM[ticker] || 'NYSE'; }
 
