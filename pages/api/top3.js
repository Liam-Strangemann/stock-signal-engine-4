// pages/api/top3.js
//
// Does ONE thing: broad Yahoo Finance scan across ~180 stocks (no API key needed).
// Returns the top 8 candidates ranked by quick-score.
// The browser then POSTs those 8 to /api/analyse to get the full signal data.
//
// This split means:
//   - top3.js is fast (pure Yahoo, no Finnhub, parallel batches of 20)
//   - analyse.js is the single source of truth for all signal logic
//   - No server-to-server calls (which break on Vercel free tier)
//
// Cache: 30 minutes in-memory.
 
const UNIVERSE = [
  'AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','AVGO','ORCL','ADBE',
  'AMD','INTC','QCOM','TXN','AMAT','MU','NOW','CRM','PANW','INTU',
  'CSCO','IBM','ACN','KLAC','LRCX','SNPS','CDNS','FTNT','WDAY','TTD',
  'JPM','BAC','WFC','GS','MS','BLK','C','AXP','SCHW','USB',
  'PNC','TFC','COF','DFS','AIG','MET','PRU','AFL','CB','TRV',
  'CME','ICE','SPGI','MCO','MA','V','BX','KKR','APO',
  'LLY','JNJ','UNH','ABBV','MRK','PFE','TMO','ABT','AMGN','CVS',
  'MDT','ISRG','BSX','SYK','REGN','BIIB','VRTX','CI','HUM','ELV',
  'GEHC','ZBH','BAX','BDX','IQV','IDXX','DXCM','PODD',
  'XOM','CVX','COP','EOG','SLB','MPC','PSX','VLO','OXY','DVN',
  'HAL','BKR','HES','TPL','FANG',
  'HD','MCD','NKE','SBUX','LOW','TGT','COST','WMT','TJX','ROST',
  'BKNG','MAR','HLT','YUM','CMG','DRI','TSCO','ORLY','AZO','ULTA',
  'KO','PEP','PG','PM','MO','KHC','GIS','HSY','MDLZ','CL',
  'CLX','CHD','SYY','KR','CAG','MKC','TSN','HRL',
  'CAT','HON','GE','RTX','LMT','NOC','GD','UPS','FDX',
  'UNP','CSX','NSC','DE','EMR','ROK','ITW','ETN','PH','DOV',
  'LIN','APD','ECL','NEM','FCX','PPG','SHW','ALB',
  'T','VZ','TMUS','NEE','DUK','SO','AEP','EXC','D','PCG',
  'AMT','PLD','EQIX','CCI','SPG','O','VICI','PSA','EQR',
  'TSM','ASML','NVO','SAP','TM','AZN','HSBC','SHEL','BHP','RIO',
  'NVS','UL','GSK','BTI','DEO','BP','TTE','SAN',
];
 
const UNIQ = [...new Set(UNIVERSE)];
 
const YH = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
};
 
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
 
async function fetchYahooQuote(symbol) {
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const res = await fetch(
        `${base}/v8/finance/chart/${symbol}?interval=1d&range=1y`,
        { headers: YH, signal: AbortSignal.timeout(6000) }
      );
      if (!res.ok) continue;
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (!meta?.regularMarketPrice) continue;
 
      const price = meta.regularMarketPrice;
      const hi    = meta.fiftyTwoWeekHigh || 0;
      const lo    = meta.fiftyTwoWeekLow  || 0;
      const range = hi - lo;
      const pe    = meta.trailingPE || null;
      const mc    = meta.marketCap  || 0;
 
      // pctFromHigh: how far below 52w high (higher = deeper discount = more interesting)
      const pctFromHigh = hi > 0 ? ((hi - price) / hi) * 100 : 0;
      // lowProximity: 0 = at 52w low, 100 = at 52w high
      const lowProximity = range > 0 ? ((price - lo) / range) * 100 : 50;
 
      return { symbol, price, yearHigh: hi, yearLow: lo, pe, mc, pctFromHigh, lowProximity };
    } catch (_) {}
  }
  return null;
}
 
// Quick score — pure value/momentum metrics, no Finnhub needed
function quickScore(s) {
  let n = 0;
 
  // PE value signal (lower PE relative to 30 = better)
  if (s.pe && s.pe > 0 && s.pe < 200) {
    n += Math.max(0, 35 - s.pe);          // max 35 pts for PE=0, 0 pts for PE≥35
  }
 
  // Price distance from 52w high (deeper pullback = more interesting)
  if (s.pctFromHigh > 10) n += Math.min(20, s.pctFromHigh * 0.5);
 
  // Not at 52w low (avoid distressed names)
  if (s.lowProximity > 15 && s.lowProximity < 80) n += 5;
 
  // Size premium (large caps = more liquid, better data)
  if (s.mc > 200e9) n += 10;
  else if (s.mc > 50e9) n += 6;
  else if (s.mc > 10e9) n += 3;
 
  return Math.round(n);
}
 
export default async function handler(req, res) {
  // Serve cache if fresh
  if (cache.data && Date.now() - cache.timestamp < CACHE_TTL) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cache.data);
  }
 
  try {
    // Fetch all symbols in parallel batches of 25
    const BATCH = 25;
    const batches = [];
    for (let i = 0; i < UNIQ.length; i += BATCH) batches.push(UNIQ.slice(i, i + BATCH));
 
    const allStocks = (
      await Promise.all(batches.map(b => Promise.all(b.map(fetchYahooQuote))))
    ).flat().filter(Boolean);
 
    // Quick-score and return top 8 candidates for full analysis
    const candidates = allStocks
      .map(s => ({ ...s, qs: quickScore(s) }))
      .sort((a, b) => b.qs - a.qs)
      .slice(0, 8)
      .map(s => s.symbol);
 
    const result = {
      candidates,          // browser will POST these to /api/analyse
      totalScanned: allStocks.length,
      generatedAt: new Date().toISOString(),
    };
 
    cache = { data: result, timestamp: Date.now() };
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json(result);
 
  } catch (err) {
    console.error('top3 scan error:', err);
    return res.status(500).json({ error: 'Scan failed', detail: err.message });
  }
}
 
