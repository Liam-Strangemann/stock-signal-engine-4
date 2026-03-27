// pages/api/analyse.js
// Runs server-side on Vercel — no CORS, API key hidden from users
 
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const FH = 'https://finnhub.io/api/v1';
 
const YH = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
};
 
async function fh(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${FH}${path}${sep}token=${FINNHUB_KEY}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
  const data = await res.json();
  if (data?.error) throw new Error(data.error);
  return data;
}
 
function fmtShares(n) {
  if (!n || n === 0) return null;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M shares`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K shares`;
  return `${n.toLocaleString()} shares`;
}
function fmtDollars(n) {
  if (!n || n === 0) return null;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
function timeAgo(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 7) return `${days}d ago`;
  if (days < 14) return '1w ago';
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
 
function maFromCloses(closes) {
  if (!Array.isArray(closes) || closes.length < 10) return null;
  const slice = closes.slice(-50);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}
 
async function fetch50dMA(ticker) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&period1=${now - 100 * 86400}&period2=${now}`,
      { headers: YH, signal: AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j = await r.json();
      const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c => c != null && !isNaN(c));
      const ma = maFromCloses(closes);
      if (ma > 0) return ma;
    }
  } catch (_) {}
  try {
    const d = await fh(`/stock/candle?symbol=${ticker}&resolution=D&count=60`);
    if (d?.s === 'ok' && Array.isArray(d.c) && d.c.length >= 10) {
      const ma = maFromCloses(d.c);
      if (ma > 0) return ma;
    }
  } catch (_) {}
  return null;
}
 
async function fetchAnalystTarget(ticker) {
  // Finnhub first
  try {
    const d = await fh(`/stock/price-target?symbol=${ticker}`);
    const t = d?.targetMedian || d?.targetMean;
    if (t && t > 0) return t;
  } catch (_) {}
  // Yahoo fallbacks
  for (const url of [
    `https://query1.finance.yahoo.com/v11/finance/quoteSummary/${ticker}?modules=financialData`,
    `https://query2.finance.yahoo.com/v11/finance/quoteSummary/${ticker}?modules=financialData`,
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData`,
  ]) {
    try {
      const r = await fetch(url, { headers: YH, signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const j = await r.json();
        const fd = j?.quoteSummary?.result?.[0]?.financialData;
        const t = fd?.targetMedianPrice?.raw || fd?.targetMeanPrice?.raw;
        if (t && t > 0) return t;
      }
    } catch (_) {}
  }
  return null;
}
 
async function fetchInsiderTransactions(ticker, curPx) {
  const now = Math.floor(Date.now() / 1000);
  const ago60 = now - 60 * 86400;
  const from = new Date(ago60 * 1000).toISOString().slice(0, 10);
  const to = new Date(now * 1000).toISOString().slice(0, 10);
  const cutoff = new Date(ago60 * 1000);
 
  // Yahoo first (best data)
  for (const url of [
    `https://query1.finance.yahoo.com/v11/finance/quoteSummary/${ticker}?modules=insiderTransactions`,
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=insiderTransactions`,
  ]) {
    try {
      const r = await fetch(url, { headers: YH, signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const j = await r.json();
        const txns = j?.quoteSummary?.result?.[0]?.insiderTransactions?.transactions || [];
        const buys = [], sells = [];
        for (const t of txns) {
          const ts = t.startDate?.raw;
          if (!ts || new Date(ts * 1000) < cutoff) continue;
          const ds = new Date(ts * 1000).toISOString().slice(0, 10);
          const sh = Math.abs(t.shares?.raw || 0);
          const val = Math.abs(t.value?.raw || 0);
          const desc = (t.transactionDescription || '').toLowerCase();
          const entry = { transactionDate: ds, share: sh, value: val, transactionPrice: sh > 0 ? val / sh : curPx };
          if (/purchase|buy/i.test(desc)) buys.push(entry);
          else if (/sale|sell/i.test(desc)) sells.push(entry);
        }
        if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'yahoo' };
      }
    } catch (_) {}
  }
 
  // Finnhub fallback
  try {
    const d = await fh(`/stock/insider-transactions?symbol=${ticker}&from=${from}&to=${to}`);
    const txns = d?.data || [];
    const buys = txns.filter(t => t.transactionCode === 'P');
    const sells = txns.filter(t => t.transactionCode === 'S');
    if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'finnhub' };
  } catch (_) {}
 
  return { buys: [], sells: [], source: null };
}
 
function buildInsiderValue(buys, sells, source) {
  if (buys.length > 0) {
    const totalShares = buys.reduce((s, t) => s + (t.share || 0), 0);
    const totalValue = buys.reduce((s, t) => {
      const v = t.value || Math.abs((t.share || 0) * (t.transactionPrice || 0));
      return s + v;
    }, 0);
    const sharesStr = totalShares > 0 ? fmtShares(totalShares) : null;
    const dollarStr = totalValue > 0 ? fmtDollars(totalValue) : null;
    const dates = buys.map(t => t.transactionDate).filter(Boolean).sort().reverse();
    const recency = dates[0] ? timeAgo(dates[0]) : null;
    const parts = [`${buys.length} buy${buys.length > 1 ? 's' : ''}`];
    if (sharesStr) parts.push(sharesStr);
    if (dollarStr) parts.push(dollarStr);
    if (recency) parts.push(recency);
    return { status: 'pass', value: parts.join(' · ') };
  }
  if (sells.length > 0) {
    const dates = sells.map(t => t.transactionDate).filter(Boolean).sort().reverse();
    const recency = dates[0] ? timeAgo(dates[0]) : null;
    const recentSells = sells.filter(s => (Date.now() - new Date(s.transactionDate).getTime()) < 30 * 86400000);
    const status = recentSells.length > 0 ? 'fail' : 'neutral';
    const parts = [`${sells.length} sell${sells.length > 1 ? 's' : ''}, no buys`];
    if (recency) parts.push(recency);
    return { status, value: parts.join(' · ') };
  }
  return { status: 'neutral', value: source ? 'No activity (60d)' : 'No data' };
}
 
async function fetchPeerPE(ticker, targetPE, targetMC, targetMargin) {
  try {
    let rawPeers = [];
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v6/finance/recommendationsbysymbol/${ticker}`,
        { headers: YH, signal: AbortSignal.timeout(5000) }
      );
      if (r.ok) {
        const j = await r.json();
        const yp = (j?.finance?.result?.[0]?.recommendedSymbols || []).map(s => s.symbol);
        rawPeers = [...rawPeers, ...yp];
      }
    } catch (_) {}
    try {
      const pd = await fh(`/stock/peers?symbol=${ticker}`);
      if (Array.isArray(pd)) rawPeers = [...rawPeers, ...pd.filter(p => p !== ticker)];
    } catch (_) {}
 
    rawPeers = [...new Set(rawPeers)].filter(p => p !== ticker).slice(0, 15);
    if (rawPeers.length === 0) return null;
 
    const peerMetrics = await Promise.allSettled(rawPeers.map(p => fh(`/stock/metric?symbol=${p}&metric=all`)));
    const all = [];
    for (let i = 0; i < rawPeers.length; i++) {
      if (peerMetrics[i].status !== 'fulfilled') continue;
      const pm = peerMetrics[i].value?.metric || {};
      const pe = pm.peBasicExclExtraTTM || pm.peTTM;
      const mc = pm.marketCapitalization || 0;
      const npm = pm.netProfitMarginAnnual || pm.netProfitMarginTTM || null;
      if (!pe || pe <= 0 || pe > 300) continue;
      if (targetMargin > 0 && npm !== null && npm < -10) continue;
      all.push({ ticker: rawPeers[i], pe, mc, npm });
    }
    if (all.length === 0) return null;
 
    let loRatio = 0.25, hiRatio = 4;
    if (targetMC > 500000) { loRatio = 0.15; hiRatio = 6.5; }
    else if (targetMC > 50000) { loRatio = 0.2; hiRatio = 5; }
 
    let comparables = targetMC > 0
      ? all.filter(c => c.mc <= 0 || (c.mc / targetMC >= loRatio && c.mc / targetMC <= hiRatio))
      : all;
    if (comparables.length < 3) comparables = all;
    if (comparables.length === 0) return null;
 
    if (comparables.length >= 5) {
      const sorted = [...comparables].sort((a, b) => a.pe - b.pe);
      const trim = Math.max(1, Math.floor(sorted.length * 0.1));
      comparables = sorted.slice(trim, sorted.length - trim);
    }
    if (comparables.length < 2) return null;
 
    const pes = comparables.map(c => c.pe).sort((a, b) => a - b);
    const mid = Math.floor(pes.length / 2);
    const medianPE = pes.length % 2 === 0 ? (pes[mid - 1] + pes[mid]) / 2 : pes[mid];
    const avgPE = pes.reduce((a, b) => a + b, 0) / pes.length;
 
    return {
      medianPE: parseFloat(medianPE.toFixed(1)),
      avgPE: parseFloat(avgPE.toFixed(1)),
      peerCount: comparables.length,
      diff: targetPE && targetPE > 0 ? parseFloat(((targetPE - avgPE) / avgPE * 100).toFixed(1)) : null,
      peers: comparables.map(c => c.ticker),
    };
  } catch (_) {
    return null;
  }
}
 
function getRating(score) {
  if (score >= 5) return { label: 'Strong Buy', color: '#14532d', bg: '#dcfce7', border: '#86efac' };
  if (score === 4) return { label: 'Buy', color: '#15803d', bg: '#f0fdf4', border: '#bbf7d0' };
  if (score === 3) return { label: 'Watch', color: '#92400e', bg: '#fffbeb', border: '#fde68a' };
  return { label: 'Ignore', color: '#6b7280', bg: '#f9fafb', border: '#d1d5db' };
}
 
async function fetchStockData(ticker) {
  const [quote, profile, metrics, earnings] = await Promise.allSettled([
    fh(`/quote?symbol=${ticker}`),
    fh(`/stock/profile2?symbol=${ticker}`),
    fh(`/stock/metric?symbol=${ticker}&metric=all`),
    fh(`/stock/earnings?symbol=${ticker}&limit=4`),
  ]);
 
  const curPx = quote.status === 'fulfilled' ? quote.value?.c : null;
  const m = metrics.status === 'fulfilled' ? metrics.value?.metric || {} : {};
  const targetPE = m.peBasicExclExtraTTM || m.peTTM || null;
  const targetMC = m.marketCapitalization || 0;
  const targetMargin = m.netProfitMarginAnnual || m.netProfitMarginTTM || 0;
 
  const [ma50, insiderData, analystTarget, peerPE] = await Promise.all([
    fetch50dMA(ticker),
    fetchInsiderTransactions(ticker, curPx),
    fetchAnalystTarget(ticker),
    fetchPeerPE(ticker, targetPE, targetMC, targetMargin),
  ]);
 
  return {
    quote: quote.status === 'fulfilled' ? quote.value : null,
    profile: profile.status === 'fulfilled' ? profile.value : null,
    metrics: metrics.status === 'fulfilled' ? metrics.value : null,
    earnings: earnings.status === 'fulfilled' ? earnings.value : null,
    ma50, insiderData, analystTarget, peerPE,
  };
}
 
function evaluate(ticker, d) {
  const q = d.quote || {};
  const p = d.profile || {};
  const m = d.metrics?.metric || {};
  const curPx = q.c;
  if (!curPx) return null;
 
  const company = p.name || ticker;
  const mc = p.marketCapitalization ? p.marketCapitalization * 1e6 : 0;
  const mcs = mc > 1e12 ? `$${(mc / 1e12).toFixed(2)}T` : mc > 1e9 ? `$${(mc / 1e9).toFixed(1)}B` : mc > 1e6 ? `$${(mc / 1e6).toFixed(0)}M` : '';
  const rawEx = (p.exchange || '').replace(/NASDAQ.*/i, 'NASDAQ').replace(/New York Stock Exchange.*/i, 'NYSE').toUpperCase().trim();
 
  let s1 = { status: 'neutral', value: 'No data' };
  try {
    const earns = Array.isArray(d.earnings) ? d.earnings : [];
    if (earns.length > 0) {
      const e = earns[0];
      const diff = e.actual - e.estimate;
      const beat = diff >= 0;
      const ds = Math.abs(diff) < 0.005 ? 'in-line' : beat ? `+$${Math.abs(diff).toFixed(2)}` : `-$${Math.abs(diff).toFixed(2)}`;
      s1 = { status: beat ? 'pass' : 'fail', value: beat ? `Beat by ${ds}` : `Missed ${ds}` };
    }
  } catch (_) {}
 
  let s2 = { status: 'neutral', value: 'No data' };
  try {
    const curPE = m.peBasicExclExtraTTM || m.peTTM;
    const eps = m.epsBasicExclExtraAnnual || m.epsTTM;
    const hi = m['52WeekHigh'], lo = m['52WeekLow'];
    if (curPE && eps > 0 && hi && lo) {
      const histPE = ((hi + lo) / 2) / eps;
      if (curPE < histPE * 0.92) s2 = { status: 'pass', value: `PE ${curPE.toFixed(1)}x < hist ~${histPE.toFixed(0)}x` };
      else if (curPE > histPE * 1.08) s2 = { status: 'fail', value: `PE ${curPE.toFixed(1)}x > hist ~${histPE.toFixed(0)}x` };
      else s2 = { status: 'neutral', value: `PE ${curPE.toFixed(1)}x ≈ hist ~${histPE.toFixed(0)}x` };
    } else if (curPE) s2 = { status: 'neutral', value: `PE ${curPE.toFixed(1)}x` };
  } catch (_) {}
 
  let s3 = { status: 'neutral', value: 'No data' };
  try {
    const ma50 = d.ma50;
    if (ma50 && curPx) {
      const pct = ((curPx - ma50) / ma50 * 100).toFixed(1);
      s3 = curPx <= ma50
        ? { status: 'pass', value: `$${curPx.toFixed(2)} ≤ MA $${ma50.toFixed(2)} (${pct}%)` }
        : { status: 'fail', value: `$${curPx.toFixed(2)} > MA $${ma50.toFixed(2)} (+${pct}%)` };
    }
  } catch (_) {}
 
  const { buys, sells, source } = d.insiderData || { buys: [], sells: [], source: null };
  const s4 = buildInsiderValue(buys, sells, source);
 
  let s5 = { status: 'neutral', value: 'No data' };
  try {
    const tgt = d.analystTarget;
    if (tgt && curPx) {
      const up = ((tgt - curPx) / curPx * 100).toFixed(1);
      s5 = parseFloat(up) >= 25
        ? { status: 'pass', value: `Target $${tgt.toFixed(2)}, +${up}% upside` }
        : { status: 'fail', value: `Target $${tgt.toFixed(2)}, +${up}% upside` };
    }
  } catch (_) {}
 
  let s6 = { status: 'neutral', value: 'No data' };
  try {
    const pp = d.peerPE;
    if (pp && pp.diff !== null) {
      if (pp.diff < -8) s6 = { status: 'pass', value: `${Math.abs(pp.diff).toFixed(0)}% < peer avg ${pp.avgPE}x` };
      else if (pp.diff > 8) s6 = { status: 'fail', value: `${Math.abs(pp.diff).toFixed(0)}% > peer avg ${pp.avgPE}x` };
      else s6 = { status: 'neutral', value: `In line, avg ${pp.avgPE}x` };
    } else if (pp?.medianPE) {
      s6 = { status: 'neutral', value: `Peer avg ${pp.avgPE}x` };
    }
  } catch (_) {}
 
  const signals = [s1, s2, s3, s4, s5, s6];
  const score = signals.filter(s => s.status === 'pass').length;
  const SIG_NAMES = ['EPS beat', 'Low PE', 'Below 50d MA', 'Insider buying', 'Analyst upside', 'PE vs peers'];
  const passes = signals.map((s, i) => s.status === 'pass' ? SIG_NAMES[i] : null).filter(Boolean);
  const fails = signals.map((s, i) => s.status === 'fail' ? SIG_NAMES[i] : null).filter(Boolean);
 
  let summary;
  if (score >= 5) summary = `Strong value candidate — ${score}/6 signals pass. Strengths: ${passes.join(', ')}.`;
  else if (score === 4) summary = `Good signals (4/6). Passes: ${passes.join(', ')}.`;
  else if (score === 3) summary = `Moderate signals (3/6). Passes: ${passes.join(', ')}.`;
  else if (score > 0) summary = `Weak signals (${score}/6). Passes: ${passes.join(', ')}. Fails: ${fails.join(', ')}.`;
  else summary = `No signals pass. Fails: ${fails.join(', ')}.`;
 
  return {
    ticker, company,
    exchange: rawEx || 'NYSE',
    price: `$${curPx.toFixed(2)}`,
    change: q.dp != null ? `${q.dp > 0 ? '+' : ''}${q.dp.toFixed(2)}%` : null,
    marketCap: mcs,
    score, signals, summary,
    rating: getRating(score),
    updatedAt: new Date().toISOString(),
  };
}
 
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!FINNHUB_KEY) return res.status(500).json({ error: 'FINNHUB_KEY not set' });
  const { tickers } = req.body;
  if (!Array.isArray(tickers) || tickers.length === 0) return res.status(400).json({ error: 'tickers array required' });
 
  const results = {};
  const cleaned = tickers.slice(0, 20).map(t => t.toUpperCase().trim());
  await Promise.allSettled(cleaned.map(async ticker => {
    try {
      const raw = await fetchStockData(ticker);
      const ev = evaluate(ticker, raw);
      results[ticker] = ev || { ticker, error: 'No quote data' };
    } catch (e) {
      results[ticker] = { ticker, error: e.message };
    }
  }));
 
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
  return res.status(200).json({ results, fetchedAt: new Date().toISOString() });
}
 
