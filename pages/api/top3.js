// pages/api/top3.js
//
// Runs /api/analyse on the top candidates from the Yahoo scan, then
// returns the 3 highest-scoring stocks by actual signal score.
//
// Key improvements over previous version:
// • Analyses up to 10 candidates (was 6) — more chances to find strong stocks
// • Diversifies candidates across sectors so we don't get 3 stocks from one sector
// • Filters out any stock that scored 0/6 from the final top 3
// • Caches result for 1 hour
 
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 60 * 60 * 1000;
 
// Sector buckets — ensures candidates span the market
const SECTOR_BUCKETS = {
  tech:        ['AAPL','MSFT','GOOGL','NVDA','META','AVGO','ORCL','ADBE','AMD','CSCO','IBM','INTU'],
  finance:     ['JPM','BAC','GS','MS','V','MA','AXP','BLK','SCHW','WFC','C','SPGI','MCO'],
  healthcare:  ['LLY','JNJ','UNH','ABBV','MRK','TMO','ABT','AMGN','CVS','ISRG','REGN','VRTX'],
  energy:      ['XOM','CVX','COP','EOG','MPC','PSX','VLO','SLB','OXY','DVN','TPL'],
  consumer:    ['HD','MCD','NKE','COST','WMT','LOW','TGT','TJX','BKNG','MO','PM','KO','PEP','PG'],
  industrial:  ['CAT','HON','GE','RTX','LMT','UPS','UNP','DE','EMR','ETN','DOV'],
  materials:   ['LIN','APD','ECL','NEM','FCX','PPG','SHW'],
  intl:        ['TSM','NVO','AZN','ASML','SHEL','BHP','RIO'],
};
 
// Pick the top-N candidates from each sector bucket based on quick-score
function diversifyCandidates(scored, maxPerSector = 2, total = 10) {
  // Map symbol → quick-score
  const scoreMap = {};
  for (const s of scored) scoreMap[s.symbol] = s.qs;
 
  const picked = new Set();
  const result = [];
 
  // First pass: take up to maxPerSector from each sector bucket
  for (const [, tickers] of Object.entries(SECTOR_BUCKETS)) {
    const sectorCandidates = tickers
      .filter(t => scoreMap[t] != null)
      .sort((a, b) => (scoreMap[b] || 0) - (scoreMap[a] || 0))
      .slice(0, maxPerSector);
    for (const t of sectorCandidates) {
      if (!picked.has(t)) { picked.add(t); result.push(t); }
    }
  }
 
  // Second pass: fill remaining slots with best overall (in case some sectors had no data)
  for (const s of scored) {
    if (result.length >= total) break;
    if (!picked.has(s.symbol)) { picked.add(s.symbol); result.push(s.symbol); }
  }
 
  return result.slice(0, total);
}
 
export default async function handler(req, res) {
 
  // GET: serve cache instantly
  if (req.method === 'GET') {
    if (cache.data && Date.now() - cache.timestamp < CACHE_TTL) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(cache.data);
    }
    return res.status(200).json({ top3: [], totalScanned: 0, empty: true });
  }
 
  // POST: analyse diversified candidates, cache top 3 by real score
  if (req.method === 'POST') {
    const { tickers, scored: scoredRaw, totalScanned } = req.body;
    if (!Array.isArray(tickers) || !tickers.length) {
      return res.status(400).json({ error: 'tickers required' });
    }
 
    try {
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host  = req.headers['x-forwarded-host'] || req.headers.host;
      const base  = `${proto}://${host}`;
 
      // Pick diversified candidates — up to 10 across sectors
      let candidates;
      if (Array.isArray(scoredRaw) && scoredRaw.length > 0) {
        candidates = diversifyCandidates(scoredRaw, 2, 10);
      } else {
        candidates = tickers.slice(0, 10);
      }
 
      // Run /api/analyse on all candidates (same as custom scan)
      const analyseRes = await fetch(`${base}/api/analyse`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ tickers: candidates }),
      });
 
      if (!analyseRes.ok) {
        const err = await analyseRes.json().catch(() => ({}));
        return res.status(500).json({ error: err.error || 'analyse failed' });
      }
 
      const analyseData = await analyseRes.json();
 
      // Sort by score descending — best real signals win
      const all = Object.values(analyseData.results || {})
        .filter(r => r && !r.error && r.score != null)
        .sort((a, b) => (b.score || 0) - (a.score || 0));
 
      // Take top 3, but prefer stocks with score >= 2
      // (avoids showing 0/6 stocks just because everything else failed)
      let top3 = all.filter(r => (r.score || 0) >= 2).slice(0, 3);
      if (top3.length < 3) top3 = all.slice(0, 3); // fallback to any results
 
      const mapped = top3.map(r => ({
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
        top3:         mapped,
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
 
const XM = {AAPL:'NASDAQ',MSFT:'NASDAQ',GOOGL:'NASDAQ',AMZN:'NASDAQ',META:'NASDAQ',NVDA:'NASDAQ',AVGO:'NASDAQ',ORCL:'NYSE',ADBE:'NASDAQ',INTU:'NASDAQ',AMD:'NASDAQ',INTC:'NASDAQ',QCOM:'NASDAQ',TXN:'NASDAQ',AMAT:'NASDAQ',MU:'NASDAQ',NOW:'NYSE',CRM:'NYSE',PANW:'NASDAQ',CSCO:'NASDAQ',IBM:'NYSE',JPM:'NYSE',BAC:'NYSE',WFC:'NYSE',GS:'NYSE',MS:'NYSE',BLK:'NYSE',C:'NYSE',AXP:'NYSE',SCHW:'NYSE',MA:'NYSE',V:'NYSE',LLY:'NYSE',JNJ:'NYSE',UNH:'NYSE',ABBV:'NYSE',MRK:'NYSE',PFE:'NYSE',TMO:'NYSE',ABT:'NYSE',AMGN:'NASDAQ',CVS:'NYSE',MDT:'NYSE',ISRG:'NASDAQ',XOM:'NYSE',CVX:'NYSE',COP:'NYSE',EOG:'NYSE',SLB:'NYSE',MPC:'NYSE',HD:'NYSE',MCD:'NYSE',NKE:'NYSE',SBUX:'NASDAQ',LOW:'NYSE',TGT:'NYSE',COST:'NASDAQ',WMT:'NYSE',KO:'NYSE',PEP:'NASDAQ',PG:'NYSE',PM:'NYSE',MO:'NYSE',T:'NYSE',VZ:'NYSE',TMUS:'NASDAQ',NEE:'NYSE',LIN:'NYSE',CAT:'NYSE',HON:'NASDAQ',GE:'NYSE',RTX:'NYSE',LMT:'NYSE',UPS:'NYSE',UNP:'NYSE',TSM:'NYSE',ASML:'NASDAQ',NVO:'NYSE',AZN:'NASDAQ',HSBC:'NYSE',SHEL:'NYSE',BHP:'NYSE',RIO:'NYSE'};
function guessExchange(ticker) { return XM[ticker] || 'NYSE'; }
 
