// pages/api/top3.js
//
// Returns top 8 candidate tickers for full signal analysis.
// Strategy (in order of preference):
//   1. Yahoo Finance chart scan across ~200 stocks (fast, free, no key)
//   2. If Yahoo scan returns fewer than 4 results → use pre-scored fallback list
//
// GUARANTEE: always returns at least 8 candidates.
// The browser then POSTs those 8 to /api/analyse for full 6-signal analysis.
// No server-to-server calls. No Finnhub here.
 
const YH = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
};
 
// ~200 tickers across all sectors
const UNIVERSE = [
  'AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','AVGO','ORCL','ADBE',
  'AMD','INTC','QCOM','TXN','AMAT','MU','NOW','CRM','PANW','INTU',
  'CSCO','IBM','ACN','KLAC','LRCX','SNPS','CDNS','FTNT','WDAY','TTD',
  'JPM','BAC','WFC','GS','MS','BLK','C','AXP','SCHW','USB',
  'PNC','TFC','COF','AIG','MET','PRU','AFL','CB','TRV',
  'CME','ICE','SPGI','MCO','MA','V','BX','KKR','PYPL',
  'LLY','JNJ','UNH','ABBV','MRK','PFE','TMO','ABT','AMGN','CVS',
  'MDT','ISRG','BSX','SYK','REGN','BIIB','VRTX','CI','HUM','ELV',
  'GEHC','ZBH','BAX','BDX','IQV','IDXX','DXCM','RMD',
  'XOM','CVX','COP','EOG','SLB','MPC','PSX','VLO','OXY','DVN',
  'HAL','BKR','HES','TPL','FANG','MRO',
  'HD','MCD','NKE','SBUX','LOW','TGT','COST','BKNG','MAR','HLT',
  'YUM','CMG','DRI','ORLY','AZO','TSCO','ULTA','TJX','ROST',
  'F','GM','RCL','CCL','LVS','MGM',
  'KO','PEP','PG','PM','MO','KHC','GIS','HSY','MDLZ','CL',
  'CLX','CHD','SYY','KR','CAG','MKC','TSN','HRL',
  'CAT','HON','GE','RTX','LMT','NOC','GD','UPS','FDX',
  'UNP','CSX','NSC','DE','EMR','ROK','ITW','ETN','PH','DOV',
  'MMM','CARR','OTIS','WM','RSG','CTAS',
  'LIN','APD','ECL','NEM','FCX','PPG','SHW','ALB',
  'NEE','DUK','SO','AEP','EXC','D','PCG','XEL','WEC',
  'AMT','PLD','EQIX','CCI','SPG','O','VICI','PSA',
  'T','VZ','TMUS','CMCSA','NFLX','DIS',
  'TSM','ASML','NVO','SAP','TM','AZN','HSBC','SHEL','BHP','RIO',
  'NVS','UL','GSK','BTI','DEO','BP','TTE','BABA','JD','PDD',
];
 
// Pre-scored fallback — always-available candidates chosen for:
// • Large cap (good Finnhub data quality)
// • Diverse sectors  
// • Historically likely to have interesting signals
// Used when Yahoo scan fails or returns too few results.
const FALLBACK_CANDIDATES = [
  'JPM','XOM','CVX','KO','VZ','ABBV','MRK','CAT','HON','IBM',
  'PFE','T','LMT','UPS','MMM','GS','BAC','WMT','MCD','PEP',
];
 
const UNIQ = [...new Set(UNIVERSE)];
 
let cache = { data: null, ts: 0 };
const TTL = 30 * 60 * 1000; // 30 min
 
async function fetchQuick(symbol) {
  // Try query1 then query2 — Vercel IPs sometimes get routed differently
  for (const base of [
    'https://query1.finance.yahoo.com',
    'https://query2.finance.yahoo.com',
  ]) {
    try {
      const r = await fetch(
        `${base}/v8/finance/chart/${symbol}?interval=1d&range=1y`,
        { headers: YH, signal: AbortSignal.timeout(6000) }
      );
      if (!r.ok) continue;
      const j    = await r.json();
      const meta = j?.chart?.result?.[0]?.meta;
      if (!meta?.regularMarketPrice) continue;
 
      const price  = meta.regularMarketPrice;
      const hi     = meta.fiftyTwoWeekHigh;
      const lo     = meta.fiftyTwoWeekLow;
      const pe     = meta.trailingPE;
      const mc     = meta.marketCap || 0;
 
      if (!hi || !lo || hi <= lo) return { symbol, price, pe, mc, fromHi: 0, loPct: 50, valid: true };
 
      const fromHi = ((hi - price) / hi * 100);
      const loPct  = ((price - lo) / (hi - lo) * 100);
 
      return { symbol, price, hi, lo, pe, mc, fromHi, loPct, valid: true };
    } catch (_) {}
  }
  return null;
}
 
function quickScore(s) {
  let n = 0;
  if (s.pe && s.pe > 3 && s.pe < 200) n += Math.max(0, 35 - s.pe * 0.6);
  if (s.fromHi > 5 && s.fromHi < 55) n += Math.min(25, s.fromHi * 0.65);
  if (s.loPct > 20 && s.loPct < 85)  n += 8;
  if (s.mc > 500e9)      n += 12;
  else if (s.mc > 100e9) n += 8;
  else if (s.mc > 10e9)  n += 4;
  return Math.round(n);
}
 
export default async function handler(req, res) {
  // Serve cache
  if (cache.data && Date.now() - cache.ts < TTL) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cache.data);
  }
 
  let candidates = [];
  let totalScanned = 0;
 
  try {
    // Scan in batches of 20 — concurrency cap avoids overwhelming Yahoo
    const BATCH = 20;
    const batches = [];
    for (let i = 0; i < UNIQ.length; i += BATCH) {
      batches.push(UNIQ.slice(i, i + BATCH));
    }
 
    const allStocks = (
      await Promise.all(batches.map(b => Promise.all(b.map(fetchQuick))))
    ).flat().filter(Boolean);
 
    totalScanned = allStocks.length;
 
    if (allStocks.length >= 4) {
      candidates = allStocks
        .map(s => ({ ...s, qs: quickScore(s) }))
        .sort((a, b) => b.qs - a.qs)
        .slice(0, 8)
        .map(s => s.symbol);
    }
  } catch (_) {}
 
  // GUARANTEE: if scan failed or returned too few, use fallback
  if (candidates.length < 4) {
    candidates = FALLBACK_CANDIDATES.slice(0, 8);
    totalScanned = totalScanned || FALLBACK_CANDIDATES.length;
  }
 
  // Ensure exactly 8 unique candidates
  candidates = [...new Set(candidates)].slice(0, 8);
 
  const result = {
    candidates,
    totalScanned,
    usedFallback: candidates.some(c => FALLBACK_CANDIDATES.includes(c)),
    generatedAt: new Date().toISOString(),
  };
 
  cache = { data: result, ts: Date.now() };
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
  return res.status(200).json(result);
}
 
