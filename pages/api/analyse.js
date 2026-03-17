// pages/api/analyse.js
// Runs server-side on Vercel — no CORS issues, API key is hidden from users
 
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const BASE = 'https://finnhub.io/api/v1';
 
// ── Finnhub fetch helper ──────────────────────────────────────────────────────
async function fh(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${BASE}${path}${sep}token=${FINNHUB_KEY}`);
  if (!res.ok) throw new Error(`Finnhub ${res.status}`);
  const data = await res.json();
  if (data?.error) throw new Error(data.error);
  return data;
}
 
// ── Compute real 50-day MA from Finnhub daily candles ────────────────────────
function calc50dMA(candles) {
  if (!candles || !Array.isArray(candles.c) || candles.c.length < 10) return null;
  const closes = candles.c; // oldest → newest
  const last50 = closes.slice(-50);
  return last50.reduce((a, b) => a + b, 0) / last50.length;
}
 
// ── Scrape analyst price target from Macrotrends (public, no key needed) ─────
// Falls back to Stockanalysis, then Wisesheets summary if first fails
async function fetchAnalystTarget(ticker) {
  const sources = [
    // Macrotrends — has analyst consensus price target in page metadata
    `https://www.macrotrends.net/stocks/charts/${ticker}/price-target`,
    // Stockanalysis — clean JSON-like data in page
    `https://stockanalysis.com/stocks/${ticker.toLowerCase()}/forecast/`,
  ];
 
  for (const url of sources) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; StockBot/1.0)',
          'Accept': 'text/html'
        },
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) continue;
      const html = await res.text();
 
      // Look for price target patterns in the HTML
      // Pattern 1: "price target" followed by a dollar amount
      const patterns = [
        /consensus[^$]*\$\s*([\d,]+\.?\d*)/i,
        /price\s+target[^$]*\$\s*([\d,]+\.?\d*)/i,
        /analyst[^$]*target[^$]*\$\s*([\d,]+\.?\d*)/i,
        /target\s+price[^$]*\$\s*([\d,]+\.?\d*)/i,
        /"targetMeanPrice"[^:]*:\s*([\d.]+)/i,
        /"priceTarget"[^:]*:\s*([\d.]+)/i,
        /mean\s+target[^$]*\$\s*([\d,]+\.?\d*)/i,
        /12.month[^$]*\$\s*([\d,]+\.?\d*)/i,
      ];
 
      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) {
          const val = parseFloat(match[1].replace(/,/g, ''));
          if (val > 0 && val < 100000) return val;
        }
      }
    } catch (_) {}
  }
 
  // Final fallback: Yahoo Finance summary page (very reliable)
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(5000)
      }
    );
    if (res.ok) {
      const json = await res.json();
      const target = json?.quoteSummary?.result?.[0]?.financialData?.targetMedianPrice?.raw
                  || json?.quoteSummary?.result?.[0]?.financialData?.targetMeanPrice?.raw;
      if (target && target > 0) return target;
    }
  } catch (_) {}
 
  return null;
}
 
// ── Fetch all data for one ticker ─────────────────────────────────────────────
async function fetchStockData(ticker) {
  const now    = Math.floor(Date.now() / 1000);
  const ago90  = now - 90 * 24 * 3600;  // 90 days back for 50d MA calc
  const ago30  = now - 30 * 24 * 3600;  // 30 days back for insider txns
  const from30 = new Date(ago30 * 1000).toISOString().slice(0, 10);
  const to30   = new Date(now   * 1000).toISOString().slice(0, 10);
 
  const [quote, profile, metrics, earnings, insider, candles, analystTarget] = await Promise.allSettled([
    fh(`/quote?symbol=${ticker}`),
    fh(`/stock/profile2?symbol=${ticker}`),
    fh(`/stock/metric?symbol=${ticker}&metric=all`),
    fh(`/stock/earnings?symbol=${ticker}&limit=4`),
    fh(`/stock/insider-transactions?symbol=${ticker}&from=${from30}&to=${to30}`),
    fh(`/stock/candle?symbol=${ticker}&resolution=D&from=${ago90}&to=${now}`),
    fetchAnalystTarget(ticker),  // web scrape — no key needed
  ]);
 
  return {
    quote:         quote.status         === 'fulfilled' ? quote.value         : null,
    profile:       profile.status       === 'fulfilled' ? profile.value       : null,
    metrics:       metrics.status       === 'fulfilled' ? metrics.value       : null,
    earnings:      earnings.status      === 'fulfilled' ? earnings.value      : null,
    insider:       insider.status       === 'fulfilled' ? insider.value       : null,
    candles:       candles.status       === 'fulfilled' ? candles.value       : null,
    analystTarget: analystTarget.status === 'fulfilled' ? analystTarget.value : null,
  };
}
 
// ── Evaluate all 5 signals ────────────────────────────────────────────────────
function evaluate(ticker, d) {
  const q   = d.quote   || {};
  const p   = d.profile || {};
  const m   = d.metrics?.metric || {};
  const curPx = q.c;
  if (!curPx) return null;
 
  const company = p.name || ticker;
  const mc  = p.marketCapitalization ? p.marketCapitalization * 1e6 : 0;
  const mcs = mc > 1e12 ? `$${(mc/1e12).toFixed(2)}T`
            : mc > 1e9  ? `$${(mc/1e9).toFixed(1)}B`
            : mc > 1e6  ? `$${(mc/1e6).toFixed(0)}M` : '';
 
  // ── Signal 1: EPS beat ──────────────────────────────────────────────────────
  let s1 = { status: 'neutral', value: 'No data' };
  try {
    const earns = Array.isArray(d.earnings) ? d.earnings : [];
    if (earns.length > 0) {
      const e    = earns[0];
      const diff = e.actual - e.estimate;
      const beat = diff >= 0;
      const ds   = Math.abs(diff) < 0.005 ? 'in-line'
                 : beat ? `+$${Math.abs(diff).toFixed(2)}` : `-$${Math.abs(diff).toFixed(2)}`;
      s1 = { status: beat ? 'pass' : 'fail', value: beat ? `Beat by ${ds}` : `Missed ${ds}` };
    }
  } catch(_) {}
 
  // ── Signal 2: PE vs historical average ─────────────────────────────────────
  let s2 = { status: 'neutral', value: 'No data' };
  try {
    const curPE = m.peBasicExclExtraTTM || m.peTTM;
    const eps   = m.epsBasicExclExtraAnnual || m.epsTTM;
    const hi    = m['52WeekHigh'];
    const lo    = m['52WeekLow'];
    if (curPE && eps > 0 && hi && lo) {
      const histPE = ((hi + lo) / 2) / eps;
      if (curPE < histPE * 0.92)
        s2 = { status: 'pass',    value: `PE ${curPE.toFixed(1)}x < hist ~${histPE.toFixed(0)}x` };
      else if (curPE > histPE * 1.08)
        s2 = { status: 'fail',    value: `PE ${curPE.toFixed(1)}x > hist ~${histPE.toFixed(0)}x` };
      else
        s2 = { status: 'neutral', value: `PE ${curPE.toFixed(1)}x ≈ hist ~${histPE.toFixed(0)}x` };
    } else if (curPE) {
      s2 = { status: 'neutral', value: `PE ${curPE.toFixed(1)}x` };
    }
  } catch(_) {}
 
  // ── Signal 3: Price vs real 50-day MA (computed from daily candles) ─────────
  let s3 = { status: 'neutral', value: 'No data' };
  try {
    const ma50 = calc50dMA(d.candles);   // computed from real price history
    if (ma50 && curPx) {
      const pct = ((curPx - ma50) / ma50 * 100).toFixed(1);
      s3 = curPx <= ma50
        ? { status: 'pass', value: `$${curPx.toFixed(2)} ≤ MA $${ma50.toFixed(2)} (${pct}%)` }
        : { status: 'fail', value: `$${curPx.toFixed(2)} > MA $${ma50.toFixed(2)} (+${pct}%)` };
    }
  } catch(_) {}
 
  // ── Signal 4: Insider buying last 30 days ───────────────────────────────────
  let s4 = { status: 'neutral', value: 'No data' };
  try {
    const txns = d.insider?.data || [];
    const buys  = txns.filter(t => t.transactionCode === 'P');
    const sells = txns.filter(t => t.transactionCode === 'S');
    const bv = buys.reduce((s, t) => s + Math.abs((t.share||0) * (t.transactionPrice||curPx||0)), 0);
    if (buys.length > 0) {
      const fv = bv > 1e6 ? `$${(bv/1e6).toFixed(1)}M`
               : bv > 1e3 ? `$${(bv/1e3).toFixed(0)}K`
               : `$${bv.toFixed(0)}`;
      s4 = { status: 'pass', value: `${buys.length} buy${buys.length>1?'s':''} ≈ ${fv}` };
    } else if (sells.length > 0) {
      s4 = { status: 'fail', value: `${sells.length} sell${sells.length>1?'s':''}, no buys` };
    } else {
      s4 = { status: 'neutral', value: 'No insider txns (30d)' };
    }
  } catch(_) {}
 
  // ── Signal 5: Analyst price target ≥ +25% above current price ──────────────
  // Target comes from web scrape — much more reliable than Finnhub free tier
  let s5 = { status: 'neutral', value: 'No data' };
  try {
    const tgt = d.analystTarget;
    if (tgt && curPx) {
      const upside = ((tgt - curPx) / curPx * 100).toFixed(1);
      s5 = parseFloat(upside) >= 25
        ? { status: 'pass', value: `Target $${tgt.toFixed(2)}, +${upside}% upside` }
        : { status: 'fail', value: `Target $${tgt.toFixed(2)}, +${upside}% upside` };
    }
  } catch(_) {}
 
  const signals = [s1, s2, s3, s4, s5];
  const score   = signals.filter(s => s.status === 'pass').length;
  const passes  = signals.map((s, i) => s.status === 'pass'
    ? ['EPS beat', 'Low PE', 'Below 50d MA', 'Insider buying', 'Analyst upside'][i]
    : null).filter(Boolean);
  const fails = signals.map((s, i) => s.status === 'fail'
    ? ['EPS beat', 'Low PE', 'Below 50d MA', 'Insider buying', 'Analyst upside'][i]
    : null).filter(Boolean);
 
  let summary;
  if (score >= 4)       summary = `Strong value candidate — ${score}/5 signals pass. Strengths: ${passes.join(', ')}.`;
  else if (score === 3) summary = `Moderate signals (3/5). Passes: ${passes.join(', ')}.`;
  else if (score > 0)   summary = `Weak signals (${score}/5). Fails: ${fails.join(', ')}.`;
  else                  summary = `No signals pass currently. Fails: ${fails.join(', ')}.`;
 
  return {
    ticker, company,
    price:     `$${curPx.toFixed(2)}`,
    change:    q.dp != null ? `${q.dp > 0 ? '+' : ''}${q.dp.toFixed(2)}%` : null,
    marketCap: mcs,
    score, signals, summary,
    updatedAt: new Date().toISOString()
  };
}
 
// ── API route handler ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });
  if (!FINNHUB_KEY)
    return res.status(500).json({ error: 'FINNHUB_KEY environment variable not set' });
 
  const { tickers } = req.body;
  if (!Array.isArray(tickers) || tickers.length === 0)
    return res.status(400).json({ error: 'tickers array required' });
 
  const results = {};
  const cleaned = tickers.slice(0, 20).map(t => t.toUpperCase().trim());
 
  await Promise.allSettled(
    cleaned.map(async ticker => {
      try {
        const raw = await fetchStockData(ticker);
        const ev  = evaluate(ticker, raw);
        results[ticker] = ev || { ticker, error: 'No quote data — check ticker symbol' };
      } catch(e) {
        results[ticker] = { ticker, error: e.message };
      }
    })
  );
 
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
  return res.status(200).json({ results, fetchedAt: new Date().toISOString() });
}
 
