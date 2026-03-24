// pages/api/top3.js

// ===== CONFIG =====
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const MAX_RUNTIME = 9000; // 9 seconds safety

// ===== SIMPLE IN-MEMORY CACHE =====
let CACHE = {
  data: null,
  timestamp: 0
};

// ===== TICKERS =====
const TICKERS = [
  'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','AVGO','ORCL','ADBE',
  'CRM','AMD','QCOM','TXN','INTC','MU','AMAT','KLAC','LRCX','MCHP',
  'ADI','NXPI','CDNS','SNPS','FTNT','PANW','CRWD','NOW','SNOW','PLTR',
  'JPM','BAC','WFC','GS','MS','BLK','C','AXP','SCHW','USB',
  'LLY','JNJ','UNH','XOM','CVX','WMT','KO','PEP','PG','COST',
  'HD','MCD','NKE','SBUX','DIS','NFLX','V','MA','PYPL','UBER'
];

const UNIQ_TICKERS = [...new Set(TICKERS)];

// ===== YAHOO BULK FETCH =====
async function yahooBatch(tickers) {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickers.join(',')}`;
  
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(5000)
  });

  if (!res.ok) throw new Error('Yahoo error');

  const json = await res.json();
  return json?.quoteResponse?.result || [];
}

// ===== SCORING ENGINE =====
function scoreStock(q) {
  if (!q || !q.symbol) return null;

  const px = q.regularMarketPrice;
  const pe = q.trailingPE;
  const ma50 = q.fiftyDayAverage;
  const hi = q.fiftyTwoWeekHigh;
  const lo = q.fiftyTwoWeekLow;

  if (!px) return null;

  let score = 0;

  if (pe && pe < 25) score++;
  if (ma50 && px <= ma50) score++;
  if (hi && lo && px < (hi + lo) / 2) score++;

  return {
    ticker: q.symbol,
    price: px,
    score
  };
}

// ===== LIGHTWEIGHT TOP 3 =====
function getTop3(quotes) {
  const scored = quotes
    .map(scoreStock)
    .filter(Boolean)
    .sort((a,b) => b.score - a.score);

  return scored.slice(0,3);
}

// ===== OPTIONAL DETAIL FETCH =====
async function getExtra(ticker) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData`,
      { signal: AbortSignal.timeout(4000) }
    );
    const json = await res.json();
    const fd = json?.quoteSummary?.result?.[0]?.financialData;

    return {
      target: fd?.targetMeanPrice?.raw || null
    };
  } catch {
    return {};
  }
}

// ===== MAIN HANDLER =====
export default async function handler(req, res) {
  const now = Date.now();

  // ✅ RETURN CACHE
  if (CACHE.data && (now - CACHE.timestamp < CACHE_TTL)) {
    return res.status(200).json({
      ...CACHE.data,
      cached: true
    });
  }

  const start = Date.now();

  try {
    // ===== STEP 1: BULK FETCH =====
    const quotes = await yahooBatch(UNIQ_TICKERS);

    if (!quotes.length) {
      return res.status(200).json({ top3: [], error: 'No data' });
    }

    // ===== STEP 2: SCORE =====
    const top3 = getTop3(quotes);

    // ===== STEP 3: ADD LIGHT DETAILS (SAFE) =====
    const enriched = await Promise.all(
      top3.map(async (s) => {
        if (Date.now() - start > MAX_RUNTIME) return s;

        const extra = await getExtra(s.ticker);
        return { ...s, ...extra };
      })
    );

    const result = {
      top3: enriched,
      scanned: quotes.length,
      generatedAt: new Date().toISOString()
    };

    // ✅ SAVE CACHE
    CACHE = {
      data: result,
      timestamp: Date.now()
    };

    return res.status(200).json(result);

  } catch (e) {
    return res.status(500).json({
      error: e.message,
      fallback: CACHE.data || null
    });
  }
}
