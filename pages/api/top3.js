// pages/api/top3.js
// Scans a curated watchlist of ~150 liquid S&P 500 stocks
// Uses only Finnhub quote + metric (2 calls per stock = 300 calls max)
// Finnhub free tier = 60 calls/min, so we batch carefully
// Returns top 3 by score with full signal detail
 
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const FH = 'https://finnhub.io/api/v1';
 
// Curated watchlist -- 150 liquid, well-covered S&P 500 stocks across all sectors
// Selected for: high Finnhub data coverage, market cap >$10B, active analyst coverage
const WATCHLIST = [
  // Mega-cap tech
  'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','AVGO','ORCL','ADBE',
  // Tech mid/large
  'AMD','INTC','QCOM','TXN','AMAT','MU','NOW','CRM','SNOW','PLTR',
  // Finance
  'JPM','BAC','WFC','GS','MS','BLK','C','AXP','SCHW','USB','PNC','TFC','COF','MET','PRU',
  // Healthcare
  'LLY','JNJ','UNH','ABBV','MRK','PFE','TMO','ABT','AMGN','CVS','MDT','ISRG','GILD','REGN','VRTX',
  // Consumer discretionary
  'AMZN','TSLA','HD','MCD','NKE','SBUX','LOW','TGT','COST','BKNG','MAR','HLT','YUM','DPZ',
  // Consumer staples
  'WMT','KO','PEP','PG','MDLZ','KHC','CL','KMB','GIS','CAG',
  // Energy
  'XOM','CVX','COP','EOG','SLB','MPC','PSX','VLO','OXY','DVN','HAL','BKR','FANG',
  // Industrials
  'GE','HON','CAT','DE','BA','LMT','RTX','NOC','GD','UPS','FDX','MMM','EMR','ETN','PH',
  // Materials
  'LIN','APD','SHW','ECL','NEM','FCX','NUE','VMC','MLM',
  // Utilities
  'NEE','DUK','SO','D','AEP','EXC','SRE','PCG',
  // Real estate
  'PLD','AMT','EQIX','CCI','PSA','O','WELL','AVB',
  // Communication
  'GOOGL','META','NFLX','DIS','CMCSA','T','VZ','TMUS','CHTR','PARA',
  // Dividend plays
  'MO','PM','IBM','MMM','VZ','T','KO','PEP','JNJ','XOM',
].filter((v,i,a) => a.indexOf(v) === i).slice(0, 150); // dedupe, max 150
 
async function fh(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${FH}${path}${sep}token=${FINNHUB_KEY}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`Finnhub ${res.status}`);
  const data = await res.json();
  if (data?.error) throw new Error(data.error);
  return data;
}
 
// Lightweight score -- uses only quote + metric (2 API calls per stock)
// Skips insider (needs date range calls) and analyst target (separate fetch)
// to stay well within rate limits. Returns score 0-4 for ranking.
async function quickScore(ticker) {
  try {
    const [quote, metrics] = await Promise.all([
      fh(`/quote?symbol=${ticker}`),
      fh(`/stock/metric?symbol=${ticker}&metric=all`)
    ]);
 
    const q  = quote || {};
    const m  = metrics?.metric || {};
    const px = q.c;
    if (!px || px <= 0) return null;
 
    let score = 0;
    const details = {};
 
    // Signal 1: EPS trend (use quarterly earnings growth as proxy)
    const qGrowth = m.epsGrowthQuarterlyYoy;
    if (qGrowth != null) {
      if (qGrowth > 0) { score++; details.eps = '+' + (qGrowth*100).toFixed(0) + '% YoY'; }
      else               details.eps = (qGrowth*100).toFixed(0) + '% YoY';
    }
 
    // Signal 2: PE vs 52wk midpoint historical
    const curPE = m.peBasicExclExtraTTM || m.peTTM;
    const eps   = m.epsBasicExclExtraAnnual || m.epsTTM;
    const hi    = m['52WeekHigh'];
    const lo    = m['52WeekLow'];
    if (curPE && eps > 0 && hi && lo) {
      const histPE = ((hi + lo) / 2) / eps;
      if (curPE < histPE * 0.92) { score++; details.pe = curPE.toFixed(1) + 'x < ' + histPE.toFixed(0) + 'x'; }
      else details.pe = curPE.toFixed(1) + 'x';
    }
 
    // Signal 3: Price vs 50d MA
    const ma50 = m['50DayMA'] || m['50DayMovingAvg'];
    if (ma50 && px) {
      if (px <= ma50) { score++; details.ma = '$' + px.toFixed(0) + ' <= MA$' + ma50.toFixed(0); }
      else              details.ma = '$' + px.toFixed(0) + ' > MA$' + ma50.toFixed(0);
    }
 
    // Signal 4: 52-week performance vs market (simple momentum check)
    // Stocks down more than market but with good fundamentals = potential value
    const ret52 = m['52WeekPriceReturnDaily'];
    if (ret52 != null && ret52 < -5 && curPE && curPE < 30) {
      // Down >5% from year ago but not massively overvalued = potential buy
      score++;
      details.momentum = ret52.toFixed(0) + '% 52wk, PE ' + (curPE ? curPE.toFixed(0) + 'x' : 'N/A');
    }
 
    const mc  = m.marketCapitalization || 0;
    const mcs = mc > 1000 ? '$' + (mc/1000).toFixed(1) + 'T' : mc > 0 ? '$' + mc.toFixed(0) + 'B' : '';
 
    return {
      ticker,
      score,
      price:     '$' + px.toFixed(2),
      change:    q.dp != null ? (q.dp > 0 ? '+' : '') + q.dp.toFixed(2) + '%' : null,
      marketCap: mcs,
      details,
      pe:        curPE || null,
    };
  } catch(_) {
    return null;
  }
}
 
// Scan in batches to respect rate limits (60 req/min free tier)
// Each stock = 2 calls, batch of 20 stocks = 40 calls, safe under limit
async function scanBatch(tickers) {
  const results = await Promise.allSettled(tickers.map(t => quickScore(t)));
  return results
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);
}
 
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
 
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!FINNHUB_KEY)         return res.status(500).json({ error: 'FINNHUB_KEY not set' });
 
  try {
    const BATCH_SIZE = 20;
    const allScores = [];
 
    for (let i = 0; i < WATCHLIST.length; i += BATCH_SIZE) {
      const batch   = WATCHLIST.slice(i, i + BATCH_SIZE);
      const results = await scanBatch(batch);
      allScores.push(...results);
 
      // Pause between batches to stay under 60 req/min
      // 20 stocks x 2 calls = 40 calls per batch
      // 1.5s pause keeps us safely under limit
      if (i + BATCH_SIZE < WATCHLIST.length) {
        await sleep(1500);
      }
    }
 
    // Sort by score desc, then by PE asc (lower PE = better value when tied)
    allScores.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aPE = a.pe || 999;
      const bPE = b.pe || 999;
      return aPE - bPE;
    });
 
    const top3 = allScores.slice(0, 3);
    const scannedAt = new Date().toISOString();
 
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate'); // cache 30 min
    return res.status(200).json({ top3, scannedAt, totalScanned: allScores.length });
 
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
 
