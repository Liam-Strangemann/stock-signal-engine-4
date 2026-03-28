// pages/api/top3.js
//
// Broad Yahoo Finance scan — ~200 stocks, no API key needed, pure Yahoo.
// Returns the top 8 candidates by quick-score for the browser to analyse.
// The browser then POSTs those 8 tickers to /api/analyse.
//
// This file contains ZERO signal logic — it only quick-scores on public
// price/PE/52w data. All real signal work stays in analyse.js.
//
// Cache: 45 minutes. First load ~4-6 seconds (batched parallel Yahoo fetches).
 
const YH = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
};
 
// ~200 large/mid cap stocks across all sectors
const UNIVERSE = [
  // Mega-cap tech
  'AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','AVGO','ORCL','ADBE',
  'AMD','INTC','QCOM','TXN','AMAT','MU','NOW','CRM','PANW','INTU',
  'CSCO','IBM','ACN','KLAC','LRCX','SNPS','CDNS','FTNT','WDAY','SNOW',
  // Financials
  'JPM','BAC','WFC','GS','MS','BLK','C','AXP','SCHW','USB',
  'PNC','TFC','COF','DFS','AIG','MET','PRU','AFL','CB','TRV',
  'CME','ICE','SPGI','MCO','MA','V','BX','KKR','PYPL','SQ',
  // Healthcare
  'LLY','JNJ','UNH','ABBV','MRK','PFE','TMO','ABT','AMGN','CVS',
  'MDT','ISRG','BSX','SYK','REGN','BIIB','VRTX','CI','HUM','ELV',
  'GEHC','ZBH','BAX','BDX','IQV','IDXX','DXCM','PODD','HOLX','RMD',
  // Energy
  'XOM','CVX','COP','EOG','SLB','MPC','PSX','VLO','OXY','DVN',
  'HAL','BKR','HES','TPL','FANG','MRO','APA','CTRA','PR',
  // Consumer discretionary
  'AMZN','TSLA','HD','MCD','NKE','SBUX','LOW','TGT','COST','BKNG',
  'MAR','HLT','YUM','CMG','DRI','ORLY','AZO','TSCO','ULTA','BBY',
  'TJX','ROST','RCL','CCL','LVS','MGM','WYNN','F','GM','RIVN',
  // Consumer staples
  'KO','PEP','PG','PM','MO','KHC','GIS','HSY','MDLZ','CL',
  'CLX','CHD','SYY','KR','CAG','MKC','TSN','HRL','K','SJM',
  // Industrials
  'CAT','HON','GE','RTX','LMT','NOC','GD','UPS','FDX',
  'UNP','CSX','NSC','DE','EMR','ROK','ITW','ETN','PH','DOV',
  'MMM','CARR','OTIS','WM','RSG','CTAS','VRSK','LDOS','SAIC',
  // Materials
  'LIN','APD','ECL','NEM','FCX','PPG','SHW','ALB','MOS','CF',
  // Utilities
  'NEE','DUK','SO','AEP','EXC','D','PCG','XEL','WEC','ES',
  // REITs
  'AMT','PLD','EQIX','CCI','SPG','O','VICI','PSA','EQR','AVB',
  // Communications
  'T','VZ','TMUS','CMCSA','CHTR','NFLX','DIS','WBD','PARA',
  // International (US-listed)
  'TSM','ASML','NVO','SAP','TM','AZN','HSBC','SHEL','BHP','RIO',
  'NVS','UL','GSK','BTI','DEO','BP','TTE','BABA','JD','PDD',
];
 
const UNIQ = [...new Set(UNIVERSE)];
 
let cache = { data: null, ts: 0 };
const TTL = 45 * 60 * 1000;
 
async function fetchQuick(symbol) {
  for (const base of ['https://query1.finance.yahoo.com','https://query2.finance.yahoo.com']) {
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
      const hi     = meta.fiftyTwoWeekHigh || price * 1.2;
      const lo     = meta.fiftyTwoWeekLow  || price * 0.8;
      const pe     = meta.trailingPE || null;
      const mc     = meta.marketCap  || 0;
      const range  = hi - lo;
      const fromHi = hi > 0 ? ((hi - price) / hi * 100) : 0;   // % below 52w high
      const loPct  = range > 0 ? ((price - lo) / range * 100) : 50; // position in range
 
      return { symbol, price, hi, lo, pe, mc, fromHi, loPct };
    } catch (_) {}
  }
  return null;
}
 
// Value-oriented quick score (no Finnhub, pure Yahoo meta)
function quickScore(s) {
  let n = 0;
 
  // Low PE is good (max 30 pts)
  if (s.pe && s.pe > 3 && s.pe < 200) {
    n += Math.max(0, 30 - s.pe * 0.5);
  }
 
  // Pulled back from 52w high but not in freefall (max 25 pts)
  if (s.fromHi > 5 && s.fromHi < 60) {
    n += Math.min(25, s.fromHi * 0.7);
  }
 
  // Not at 52w low (avoid distressed names)
  if (s.loPct > 20 && s.loPct < 85) n += 8;
 
  // Large cap preference (better data, more liquid)
  if (s.mc > 500e9)       n += 12;
  else if (s.mc > 100e9)  n += 8;
  else if (s.mc > 10e9)   n += 4;
 
  return Math.round(n);
}
 
export default async function handler(req, res) {
  if (cache.data && Date.now() - cache.ts < TTL) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cache.data);
  }
 
  try {
    // Parallel batches of 25 — Yahoo can handle this
    const BATCH = 25;
    const all = [];
    const batches = [];
    for (let i = 0; i < UNIQ.length; i += BATCH) batches.push(UNIQ.slice(i, i + BATCH));
    const settled = await Promise.all(batches.map(b => Promise.all(b.map(fetchQuick))));
    settled.flat().forEach(r => r && all.push(r));
 
    // Top 8 by quick-score — these go to /api/analyse for full signal analysis
    const candidates = all
      .map(s => ({ ...s, qs: quickScore(s) }))
      .sort((a, b) => b.qs - a.qs)
      .slice(0, 8)
      .map(s => s.symbol);
 
    const result = { candidates, totalScanned: all.length, generatedAt: new Date().toISOString() };
    cache = { data: result, ts: Date.now() };
    res.setHeader('Cache-Control', 's-maxage=2700, stale-while-revalidate');
    return res.status(200).json(result);
  } catch (err) {
    console.error('top3 scan error:', err);
    return res.status(500).json({ error: 'Scan failed', detail: err.message });
  }
}
 
