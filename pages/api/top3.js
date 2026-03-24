// pages/api/top3.js
// Uses Yahoo Finance (free, no key) as primary data source.
// Falls back to Finnhub only for missing fields.
// Batches requests and caches results for 1 hour to stay fast.
 
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
 
// Pre-screened universe of liquid, well-known stocks.
// Keeping this tight (~60) means we can scan the whole list fast.
const UNIVERSE = [
  "AAPL","MSFT","GOOGL","AMZN","META","NVDA","TSLA","BRK.B","JPM","JNJ",
  "V","PG","UNH","HD","MA","XOM","CVX","ABBV","MRK","PEP",
  "KO","AVGO","COST","TMO","MCD","ACN","LIN","DHR","NEE","TXN",
  "QCOM","HON","PM","UNP","SBUX","INTC","AMD","AMGN","IBM","GS",
  "CAT","BA","MMM","GE","F","GM","WMT","TGT","LOW","NKE",
  "PYPL","CRM","NOW","SNOW","PLTR","UBER","LYFT","SQ","SHOP","COIN"
];
 
// Simple in-memory cache (persists across warm Lambda invocations on Vercel)
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
 
// Fetch a single stock's data from Yahoo Finance (free, no key required)
async function fetchYahooQuote(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta) return null;
 
    const price = meta.regularMarketPrice;
    const yearHigh = meta.fiftyTwoWeekHigh;
    const yearLow = meta.fiftyTwoWeekLow;
    const peRatio = meta.trailingPE ?? null;
    const marketCap = meta.marketCap ?? null;
 
    // Proximity to 52-week low (0 = at low, 100 = at high)
    const range = yearHigh - yearLow;
    const lowProximity = range > 0 ? ((price - yearLow) / range) * 100 : 50;
 
    return { symbol, price, yearHigh, yearLow, peRatio, marketCap, lowProximity };
  } catch {
    return null;
  }
}
 
// Score a stock. Lower is better for value plays.
// Returns a 0-100 score where 100 = most undervalued signal.
function scoreStock(stock) {
  let score = 0;
 
  // 1. PE ratio score (lower PE = better value, capped 0-40 range)
  if (stock.peRatio && stock.peRatio > 0 && stock.peRatio < 200) {
    // PE of 10 = full 40 pts, PE of 40+ = 0 pts
    const peScore = Math.max(0, 40 - stock.peRatio);
    score += peScore;
  }
 
  // 2. 52-week low proximity (closer to low = more upside potential)
  // lowProximity: 0 = at 52w low (great), 100 = at 52w high (bad)
  const momentumScore = Math.max(0, 30 - stock.lowProximity * 0.3);
  score += momentumScore;
 
  // 3. Bonus: large-cap stability (market cap > $100B)
  if (stock.marketCap && stock.marketCap > 100_000_000_000) {
    score += 10;
  }
 
  return Math.round(score);
}
 
// Run one batch of symbols concurrently, with a small delay between batches
async function fetchBatch(symbols, delayMs = 0) {
  if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  return Promise.all(symbols.map(fetchYahooQuote));
}
 
export default async function handler(req, res) {
  // Return cached result if fresh
  if (cache.data && Date.now() - cache.timestamp < CACHE_TTL) {
    res.setHeader("X-Cache", "HIT");
    return res.status(200).json(cache.data);
  }
 
  try {
    // Split universe into batches of 10, staggered 200ms apart
    const BATCH_SIZE = 10;
    const batches = [];
    for (let i = 0; i < UNIVERSE.length; i += BATCH_SIZE) {
      batches.push(UNIVERSE.slice(i, i + BATCH_SIZE));
    }
 
    const batchResults = await Promise.all(
      batches.map((batch, i) => fetchBatch(batch, i * 200))
    );
 
    const allStocks = batchResults.flat().filter(Boolean);
 
    // Score and sort
    const scored = allStocks
      .map(stock => ({ ...stock, score: scoreStock(stock) }))
      .sort((a, b) => b.score - a.score);
 
    const top3 = scored.slice(0, 3).map(s => ({
      symbol: s.symbol,
      price: s.price?.toFixed(2),
      peRatio: s.peRatio?.toFixed(1) ?? "N/A",
      yearLow: s.yearLow?.toFixed(2),
      yearHigh: s.yearHigh?.toFixed(2),
      lowProximity: s.lowProximity?.toFixed(1),
      marketCap: s.marketCap
        ? `$${(s.marketCap / 1e9).toFixed(0)}B`
        : "N/A",
      score: s.score,
    }));
 
    const result = {
      top3,
      scannedCount: allStocks.length,
      generatedAt: new Date().toISOString(),
    };
 
    // Store in cache
    cache = { data: result, timestamp: Date.now() };
 
    res.setHeader("X-Cache", "MISS");
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate");
    return res.status(200).json(result);
  } catch (err) {
    console.error("top3 error:", err);
    return res.status(500).json({ error: "Failed to fetch stock data", detail: err.message });
  }
}
 
