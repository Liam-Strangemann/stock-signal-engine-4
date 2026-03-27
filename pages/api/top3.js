// pages/api/top3.js
//
// TIER 1 — Yahoo Finance scan (free, no key, fast)
//   Fetches price/PE/52-week data for all UNIVERSE symbols in parallel batches.
//   Quick-scores every stock on value + momentum metrics.
//   No Finnhub calls at this stage → no rate-limit risk.
//
// TIER 2 — Delegates to /api/analyse (top 6 candidates only)
//   The full 6-signal analysis lives entirely in analyse.js.
//   This file makes one internal POST to that endpoint and returns the top 3.
//   There is NO duplicated signal logic here — whatever works in custom scan
//   automatically works in Top Picks Today.
//
// Cache: 1 hour in-memory. First load ~15-20 s, subsequent loads instant.
 
const UNIVERSE = [
  'AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','AVGO','ORCL','ADBE',
  'AMD','INTC','QCOM','TXN','AMAT','MU','NOW','CRM','PANW','INTU',
  'CSCO','IBM','ACN','HPQ','KLAC','LRCX','SNPS','CDNS',
  'JPM','BAC','WFC','GS','MS','BLK','C','AXP','SCHW','USB',
  'PNC','TFC','COF','DFS','AIG','MET','PRU','AFL','CB','TRV',
  'CME','ICE','SPGI','MCO','MA','V',
  'LLY','JNJ','UNH','ABBV','MRK','PFE','TMO','ABT','AMGN','CVS',
  'MDT','ISRG','BSX','SYK','REGN','BIIB','VRTX','CI','HUM','ELV',
  'XOM','CVX','COP','EOG','SLB','MPC','PSX','VLO','OXY','DVN',
  'HAL','BKR','HES','TPL',
  'HD','MCD','NKE','SBUX','LOW','TGT','COST','WMT','TJX','ROST',
  'BKNG','MAR','HLT','YUM','CMG','DRI','TSCO','ORLY','AZO',
  'KO','PEP','PG','PM','MO','KHC','GIS','HSY','MDLZ','CL',
  'CLX','CHD','SYY','KR','CAG','MKC','HRL','TSN',
  'CAT','HON','MMM','GE','RTX','LMT','NOC','GD','UPS','FDX',
  'UNP','CSX','NSC','DE','EMR','ROK','ITW','ETN','PH','DOV',
  'LIN','APD','ECL','NEM','FCX','PPG','SHW',
  'T','VZ','TMUS','NEE','DUK','SO','AEP','EXC',
  'AMT','PLD','EQIX','CCI','SPG','O','VICI',
  'TSM','ASML','NVO','SAP','TM','AZN','HSBC','SHEL','BHP','RIO',
  'NVS','UL','DEO','BTI','GSK',
];
 
const UNIQ = [...new Set(UNIVERSE)];
 
// Exchange lookup used by fullAnalyse to enrich results
const XM = {
  AAPL:'NASDAQ',MSFT:'NASDAQ',GOOGL:'NASDAQ',AMZN:'NASDAQ',META:'NASDAQ',
  NVDA:'NASDAQ',TSLA:'NASDAQ',AVGO:'NASDAQ',ORCL:'NYSE',ADBE:'NASDAQ',
  AMD:'NASDAQ',INTC:'NASDAQ',QCOM:'NASDAQ',TXN:'NASDAQ',AMAT:'NASDAQ',
  MU:'NASDAQ',NOW:'NYSE',CRM:'NYSE',PANW:'NASDAQ',INTU:'NASDAQ',
  CSCO:'NASDAQ',IBM:'NYSE',HPQ:'NYSE',KLAC:'NASDAQ',LRCX:'NASDAQ',
  SNPS:'NASDAQ',CDNS:'NASDAQ',
  JPM:'NYSE',BAC:'NYSE',WFC:'NYSE',GS:'NYSE',MS:'NYSE',BLK:'NYSE',
  C:'NYSE',AXP:'NYSE',SCHW:'NYSE',USB:'NYSE',PNC:'NYSE',TFC:'NYSE',
  COF:'NYSE',DFS:'NYSE',AIG:'NYSE',MET:'NYSE',PRU:'NYSE',AFL:'NYSE',
  CB:'NYSE',TRV:'NYSE',CME:'NASDAQ',ICE:'NYSE',SPGI:'NYSE',MCO:'NYSE',
  MA:'NYSE',V:'NYSE',
  LLY:'NYSE',JNJ:'NYSE',UNH:'NYSE',ABBV:'NYSE',MRK:'NYSE',PFE:'NYSE',
  TMO:'NYSE',ABT:'NYSE',AMGN:'NASDAQ',CVS:'NYSE',MDT:'NYSE',
  ISRG:'NASDAQ',BSX:'NYSE',SYK:'NYSE',REGN:'NASDAQ',BIIB:'NASDAQ',
  VRTX:'NASDAQ',CI:'NYSE',HUM:'NYSE',ELV:'NYSE',
  XOM:'NYSE',CVX:'NYSE',COP:'NYSE',EOG:'NYSE',SLB:'NYSE',MPC:'NYSE',
  PSX:'NYSE',VLO:'NYSE',OXY:'NYSE',DVN:'NYSE',HAL:'NYSE',BKR:'NYSE',
  HD:'NYSE',MCD:'NYSE',NKE:'NYSE',SBUX:'NASDAQ',LOW:'NYSE',TGT:'NYSE',
  COST:'NASDAQ',WMT:'NYSE',BKNG:'NASDAQ',MAR:'NASDAQ',
  CAT:'NYSE',HON:'NASDAQ',MMM:'NYSE',GE:'NYSE',RTX:'NYSE',LMT:'NYSE',
  NOC:'NYSE',GD:'NYSE',UPS:'NYSE',FDX:'NYSE',UNP:'NYSE',CSX:'NASDAQ',
  NSC:'NYSE',DE:'NYSE',
  KO:'NYSE',PEP:'NASDAQ',PG:'NYSE',PM:'NYSE',MO:'NYSE',
  T:'NYSE',VZ:'NYSE',TMUS:'NASDAQ',NEE:'NYSE',
  LIN:'NYSE',APD:'NYSE',ECL:'NYSE',NEM:'NYSE',FCX:'NYSE',
  AMT:'NYSE',PLD:'NYSE',EQIX:'NASDAQ',CCI:'NYSE',SPG:'NYSE',
  TSM:'NYSE',ASML:'NASDAQ',NVO:'NYSE',SAP:'NYSE',TM:'NYSE',
  AZN:'NASDAQ',HSBC:'NYSE',SHEL:'NYSE',BHP:'NYSE',RIO:'NYSE',
};
 
// Full browser headers — required for Yahoo not to block server-side requests
const YH = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
};
 
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
 
// ── TIER 1: Yahoo quick scan ─────────────────────────────────────────────────
async function fetchYahooQuote(symbol) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`,
      { headers: YH, signal: AbortSignal.timeout(7000) }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;
    const price = meta.regularMarketPrice;
    const hi    = meta.fiftyTwoWeekHigh;
    const lo    = meta.fiftyTwoWeekLow;
    const range = (hi && lo) ? hi - lo : 0;
    return {
      symbol,
      price,
      yearHigh:     hi,
      yearLow:      lo,
      peRatio:      meta.trailingPE  ?? null,
      marketCap:    meta.marketCap   ?? null,
      lowProximity: range > 0 ? ((price - lo) / range) * 100 : 50,
    };
  } catch {
    return null;
  }
}
 
function quickScore(s) {
  let n = 0;
  if (s.peRatio && s.peRatio > 0 && s.peRatio < 200) n += Math.max(0, 40 - s.peRatio);
  n += Math.max(0, 30 - (s.lowProximity || 50) * 0.3);
  if (s.marketCap && s.marketCap > 50e9)  n += 8;
  if (s.marketCap && s.marketCap > 200e9) n += 4;
  return Math.round(n);
}
 
// ── TIER 2: Delegate full analysis to /api/analyse ───────────────────────────
async function runFullAnalysis(tickers, req) {
  // Build the absolute URL so we can call our own endpoint server-side.
  // On Vercel: VERCEL_URL is set automatically (e.g. my-app.vercel.app).
  // Locally:   fallback to localhost:3000.
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';
 
  const res = await fetch(`${base}/api/analyse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tickers }),
    signal: AbortSignal.timeout(55000), // Vercel Pro limit is 60 s
  });
 
  if (!res.ok) {
    const text = await res.text().catch(() => res.status.toString());
    throw new Error(`analyse returned ${res.status}: ${text}`);
  }
 
  const data = await res.json();
  // data.results is { TICKER: stockObject, ... }
  return Object.values(data.results || {}).filter(Boolean);
}
 
// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Serve cache immediately if fresh
  if (cache.data && Date.now() - cache.timestamp < CACHE_TTL) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cache.data);
  }
 
  try {
    // ── TIER 1: Yahoo quick-scan ─────────────────────────────────────────────
    const BATCH = 20;
    const batches = [];
    for (let i = 0; i < UNIQ.length; i += BATCH) batches.push(UNIQ.slice(i, i + BATCH));
    const allStocks = (
      await Promise.all(batches.map(b => Promise.all(b.map(fetchYahooQuote))))
    ).flat().filter(Boolean);
 
    // Pick top 6 candidates by quick-score
    const candidates = allStocks
      .map(s => ({ ...s, qs: quickScore(s) }))
      .sort((a, b) => b.qs - a.qs)
      .slice(0, 6)
      .map(s => s.symbol);
 
    // ── TIER 2: Full signal analysis via /api/analyse ────────────────────────
    let top3 = [];
    if (process.env.FINNHUB_KEY && candidates.length > 0) {
      const analysed = await runFullAnalysis(candidates, req);
 
      // Sort by score descending, take top 3, and inject exchange if missing
      top3 = analysed
        .filter(s => s && !s.error && s.score != null)
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 3)
        .map(s => ({
          ...s,
          // analyse.js doesn't return exchange — add it from the lookup table
          exchange: s.exchange || XM[s.ticker] || 'NYSE',
        }));
    }
 
    const result = {
      top3,
      totalScanned: allStocks.length,
      generatedAt:  new Date().toISOString(),
    };
 
    cache = { data: result, timestamp: Date.now() };
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    return res.status(200).json(result);
 
  } catch (err) {
    console.error('top3 error:', err);
    return res.status(500).json({ error: 'Failed to fetch stock data', detail: err.message });
  }
}
 
