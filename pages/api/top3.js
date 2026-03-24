// pages/api/top3.js
// Step 1: Fast Yahoo Finance scan across full universe (no API key needed)
// Step 2: Top 6 candidates get full Finnhub signal analysis (same as analyse.js)
// Step 3: Results cached 1 hour — repeat loads are instant
 
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const FH = 'https://finnhub.io/api/v1';
 
const UNIVERSE = [
  'AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','BRK.B','JPM','JNJ',
  'V','PG','UNH','HD','MA','XOM','CVX','ABBV','MRK','PEP',
  'KO','AVGO','COST','TMO','MCD','ACN','LIN','DHR','NEE','TXN',
  'QCOM','HON','PM','UNP','SBUX','INTC','AMD','AMGN','IBM','GS',
  'CAT','BA','MMM','GE','F','GM','WMT','TGT','LOW','NKE',
  'TSM','ASML','NVO','SAP','TM','AZN','HSBC','SHEL','BHP','RIO',
];
 
// Exchange for every ticker in the universe
const EXCHANGE_MAP = {
  AAPL:'NASDAQ',MSFT:'NASDAQ',GOOGL:'NASDAQ',AMZN:'NASDAQ',META:'NASDAQ',
  NVDA:'NASDAQ',TSLA:'NASDAQ',AVGO:'NASDAQ',COST:'NASDAQ',INTC:'NASDAQ',
  AMD:'NASDAQ',AMGN:'NASDAQ',QCOM:'NASDAQ',SBUX:'NASDAQ',
  'BRK.B':'NYSE',JPM:'NYSE',JNJ:'NYSE',V:'NYSE',PG:'NYSE',
  UNH:'NYSE',HD:'NYSE',MA:'NYSE',XOM:'NYSE',CVX:'NYSE',
  ABBV:'NYSE',MRK:'NYSE',PEP:'NASDAQ',KO:'NYSE',TMO:'NYSE',
  MCD:'NYSE',ACN:'NYSE',LIN:'NYSE',DHR:'NYSE',NEE:'NYSE',
  TXN:'NASDAQ',HON:'NASDAQ',PM:'NYSE',UNP:'NYSE',IBM:'NYSE',
  GS:'NYSE',CAT:'NYSE',BA:'NYSE',MMM:'NYSE',GE:'NYSE',
  F:'NYSE',GM:'NYSE',WMT:'NYSE',TGT:'NYSE',LOW:'NYSE',NKE:'NYSE',
  TSM:'NYSE',ASML:'NASDAQ',NVO:'NYSE',SAP:'NYSE',TM:'NYSE',
  AZN:'NASDAQ',HSBC:'NYSE',SHEL:'NYSE',BHP:'NYSE',RIO:'NYSE',
};
 
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 60 * 60 * 1000;
 
// ── Yahoo quick quote ─────────────────────────────────────────────────────────
async function fetchYahooQuote(symbol) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta || !meta.regularMarketPrice) return null;
    const price = meta.regularMarketPrice;
    const yearHigh = meta.fiftyTwoWeekHigh;
    const yearLow  = meta.fiftyTwoWeekLow;
    const range    = yearHigh - yearLow;
    return {
      symbol,
      price,
      yearHigh,
      yearLow,
      peRatio:      meta.trailingPE ?? null,
      marketCap:    meta.marketCap  ?? null,
      lowProximity: range > 0 ? ((price - yearLow) / range) * 100 : 50,
    };
  } catch { return null; }
}
 
function quickScore(s) {
  let score = 0;
  if (s.peRatio && s.peRatio > 0 && s.peRatio < 200) score += Math.max(0, 40 - s.peRatio);
  score += Math.max(0, 30 - s.lowProximity * 0.3);
  if (s.marketCap && s.marketCap > 100_000_000_000) score += 10;
  return Math.round(score);
}
 
async function fetchBatch(symbols, delayMs = 0) {
  if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  return Promise.all(symbols.map(fetchYahooQuote));
}
 
// ── Finnhub helpers (mirrored from analyse.js) ────────────────────────────────
function fmtShares(n) {
  if (!n) return null;
  if (n >= 1e6) return `${(n/1e6).toFixed(2)}M shares`;
  if (n >= 1e3) return `${(n/1e3).toFixed(1)}K shares`;
  return `${n.toLocaleString()} shares`;
}
function fmtDollars(n) {
  if (!n) return null;
  if (n >= 1e9) return `$${(n/1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
  return `$${n.toFixed(0)}`;
}
function timeAgo(dateStr) {
  if (!dateStr) return null;
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 7)  return `${days}d ago`;
  if (days < 14) return '1w ago';
  if (days < 30) return `${Math.floor(days/7)}w ago`;
  return `${Math.floor(days/30)}mo ago`;
}
 
async function fh(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${FH}${path}${sep}token=${FINNHUB_KEY}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
  const d = await res.json();
  if (d?.error) throw new Error(d.error);
  return d;
}
 
function maFromCloses(closes) {
  if (!Array.isArray(closes) || closes.length < 10) return null;
  const s = closes.slice(-50);
  return s.reduce((a,b) => a+b, 0) / s.length;
}
 
async function fetch50dMA(ticker) {
  try {
    const d = await fh(`/stock/candle?symbol=${ticker}&resolution=D&count=60`);
    if (d?.s === 'ok' && Array.isArray(d.c) && d.c.length >= 10) {
      const ma = maFromCloses(d.c);
      if (ma > 0) return ma;
    }
  } catch (_) {}
  try {
    const now = Math.floor(Date.now()/1000);
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&period1=${now-100*86400}&period2=${now}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j      = await r.json();
      const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c => c!=null && !isNaN(c));
      const ma     = maFromCloses(closes);
      if (ma > 0) return ma;
    }
  } catch (_) {}
  return null;
}
 
async function fetchAnalystTarget(ticker) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j  = await r.json();
      const fd = j?.quoteSummary?.result?.[0]?.financialData;
      const t  = fd?.targetMedianPrice?.raw || fd?.targetMeanPrice?.raw;
      if (t > 0) return t;
    }
  } catch (_) {}
  return null;
}
 
async function fetchInsiderTransactions(ticker, curPx) {
  const now    = Math.floor(Date.now()/1000);
  const ago30  = now - 30*86400;
  const from30 = new Date(ago30*1000).toISOString().slice(0,10);
  const to30   = new Date(now*1000).toISOString().slice(0,10);
  const cutoff = new Date(ago30*1000);
  try {
    const d    = await fh(`/stock/insider-transactions?symbol=${ticker}&from=${from30}&to=${to30}`);
    const txns = d?.data || [];
    const buys  = txns.filter(t => t.transactionCode === 'P');
    const sells = txns.filter(t => t.transactionCode === 'S');
    if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'finnhub' };
  } catch (_) {}
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=insiderTransactions`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j    = await r.json();
      const txns = j?.quoteSummary?.result?.[0]?.insiderTransactions?.transactions || [];
      const buys = [], sells = [];
      for (const t of txns) {
        const dateTs = t.startDate?.raw;
        if (!dateTs) continue;
        const txDate  = new Date(dateTs*1000);
        if (txDate < cutoff) continue;
        const dateStr = txDate.toISOString().slice(0,10);
        const shares  = Math.abs(t.shares?.raw||0);
        const value   = Math.abs(t.value?.raw||0);
        const desc    = (t.transactionDescription||'').toLowerCase();
        const entry   = { transactionDate: dateStr, share: shares, value, transactionPrice: shares>0?value/shares:curPx };
        if (/purchase|buy/i.test(desc)) buys.push(entry);
        else if (/sale|sell/i.test(desc)) sells.push(entry);
      }
      if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'yahoo' };
    }
  } catch (_) {}
  return { buys: [], sells: [], source: null };
}
 
function buildInsiderValue(buys, sells, source) {
  if (buys.length > 0) {
    const totalShares = buys.reduce((s,t) => s+(t.share||0), 0);
    const totalValue  = buys.reduce((s,t) => s+(t.value||Math.abs((t.share||0)*(t.transactionPrice||0))), 0);
    const parts       = [`${buys.length} buy${buys.length>1?'s':''}`];
    const sh          = fmtShares(totalShares); if (sh) parts.push(sh);
    const dl          = fmtDollars(totalValue); if (dl) parts.push(dl);
    const dates       = buys.map(t=>t.transactionDate).filter(Boolean).sort().reverse();
    const rc          = dates[0] ? timeAgo(dates[0]) : null; if (rc) parts.push(rc);
    return { status: 'pass', value: parts.join(' · ') };
  }
  if (sells.length > 0) {
    return { status: 'fail', value: `${sells.length} sell${sells.length>1?'s':''}, no buys` };
  }
  return { status: 'neutral', value: source ? 'No activity (30d)' : 'No data' };
}
 
async function fetchPeerPE(ticker, targetPE, targetMC) {
  try {
    let rawPeers = [];
    try { const pd = await fh(`/stock/peers?symbol=${ticker}`); if (Array.isArray(pd)) rawPeers = pd.filter(p => p !== ticker).slice(0, 15); } catch (_) {}
    if (rawPeers.length === 0) return null;
    const pm = await Promise.allSettled(rawPeers.map(p => fh(`/stock/metric?symbol=${p}&metric=all`)));
    const all = [];
    for (let i = 0; i < rawPeers.length; i++) {
      if (pm[i].status !== 'fulfilled') continue;
      const m  = pm[i].value?.metric || {};
      const pe = m.peBasicExclExtraTTM || m.peTTM;
      if (!pe || pe <= 0 || pe > 300) continue;
      all.push({ ticker: rawPeers[i], pe });
    }
    if (all.length < 2) return null;
    const pes   = all.map(c => c.pe).sort((a,b) => a-b);
    const mid   = Math.floor(pes.length / 2);
    const medPE = pes.length % 2 === 0 ? (pes[mid-1]+pes[mid])/2 : pes[mid];
    const avgPE = pes.reduce((a,b) => a+b, 0) / pes.length;
    const diff  = targetPE && targetPE > 0 ? parseFloat(((targetPE - avgPE) / avgPE * 100).toFixed(1)) : null;
    return { medianPE: parseFloat(medPE.toFixed(1)), avgPE: parseFloat(avgPE.toFixed(1)), peerCount: all.length, diff };
  } catch (_) { return null; }
}
 
function getRating(score) {
  if (score >= 5) return { label: 'Strong Buy', color: '#14532d', bg: '#dcfce7', border: '#86efac' };
  if (score === 4) return { label: 'Buy',        color: '#15803d', bg: '#f0fdf4', border: '#bbf7d0' };
  if (score === 3) return { label: 'Watch',      color: '#92400e', bg: '#fffbeb', border: '#fde68a' };
  return                  { label: 'Ignore',     color: '#6b7280', bg: '#f9fafb', border: '#d1d5db' };
}
 
async function fullAnalyse(ticker) {
  const [quote, profile, metrics, earnings, analystTarget] = await Promise.allSettled([
    fh(`/quote?symbol=${ticker}`),
    fh(`/stock/profile2?symbol=${ticker}`),
    fh(`/stock/metric?symbol=${ticker}&metric=all`),
    fh(`/stock/earnings?symbol=${ticker}&limit=4`),
    fetchAnalystTarget(ticker),
  ]);
 
  const q      = quote.status   === 'fulfilled' ? quote.value   || {} : {};
  const p      = profile.status === 'fulfilled' ? profile.value || {} : {};
  const m      = metrics.status === 'fulfilled' ? metrics.value?.metric || {} : {};
  const curPx  = q.c;
  if (!curPx) return null;
 
  const targetPE = m.peBasicExclExtraTTM || m.peTTM || null;
  const targetMC = m.marketCapitalization || 0;
 
  const [ma50, insiderData, peerPE] = await Promise.all([
    fetch50dMA(ticker),
    fetchInsiderTransactions(ticker, curPx),
    fetchPeerPE(ticker, targetPE, targetMC),
  ]);
 
  const mc  = p.marketCapitalization ? p.marketCapitalization*1e6 : 0;
  const mcs = mc>1e12?`$${(mc/1e12).toFixed(2)}T`:mc>1e9?`$${(mc/1e9).toFixed(1)}B`:mc>1e6?`$${(mc/1e6).toFixed(0)}M`:'';
 
  let s1 = { status:'neutral', value:'No data' };
  try {
    const earns = Array.isArray(earnings.value) ? earnings.value : [];
    if (earns.length > 0) {
      const e    = earns[0];
      const diff = e.actual - e.estimate;
      const beat = diff >= 0;
      const ds   = Math.abs(diff)<0.005?'in-line':beat?`+$${Math.abs(diff).toFixed(2)}`:`-$${Math.abs(diff).toFixed(2)}`;
      s1 = { status: beat?'pass':'fail', value: beat?`Beat by ${ds}`:`Missed ${ds}` };
    }
  } catch(_) {}
 
  let s2 = { status:'neutral', value:'No data' };
  try {
    const curPE = m.peBasicExclExtraTTM || m.peTTM;
    const eps   = m.epsBasicExclExtraAnnual || m.epsTTM;
    const hi    = m['52WeekHigh'], lo = m['52WeekLow'];
    if (curPE && eps>0 && hi && lo) {
      const histPE = ((hi+lo)/2)/eps;
      if      (curPE < histPE*0.92) s2 = { status:'pass',    value:`PE ${curPE.toFixed(1)}x < hist ~${histPE.toFixed(0)}x` };
      else if (curPE > histPE*1.08) s2 = { status:'fail',    value:`PE ${curPE.toFixed(1)}x > hist ~${histPE.toFixed(0)}x` };
      else                          s2 = { status:'neutral', value:`PE ${curPE.toFixed(1)}x ≈ hist ~${histPE.toFixed(0)}x` };
    } else if (curPE) s2 = { status:'neutral', value:`PE ${curPE.toFixed(1)}x` };
  } catch(_) {}
 
  let s3 = { status:'neutral', value:'No data' };
  try {
    if (ma50 && curPx) {
      const pct = ((curPx-ma50)/ma50*100).toFixed(1);
      s3 = curPx <= ma50
        ? { status:'pass', value:`$${curPx.toFixed(2)} ≤ MA $${ma50.toFixed(2)} (${pct}%)` }
        : { status:'fail', value:`$${curPx.toFixed(2)} > MA $${ma50.toFixed(2)} (+${pct}%)` };
    }
  } catch(_) {}
 
  const { buys, sells, source } = insiderData || { buys:[], sells:[], source:null };
  const s4 = buildInsiderValue(buys, sells, source);
 
  let s5 = { status:'neutral', value:'No data' };
  try {
    const tgt = analystTarget.status === 'fulfilled' ? analystTarget.value : null;
    if (tgt && curPx) {
      const up = ((tgt-curPx)/curPx*100).toFixed(1);
      s5 = parseFloat(up)>=25
        ? { status:'pass', value:`Target $${tgt.toFixed(2)}, +${up}% upside` }
        : { status:'fail', value:`Target $${tgt.toFixed(2)}, +${up}% upside` };
    }
  } catch(_) {}
 
  let s6 = { status:'neutral', value:'No data' };
  try {
    if (peerPE && peerPE.diff !== null) {
      if      (peerPE.diff < -8) s6 = { status:'pass',    value:`${Math.abs(peerPE.diff).toFixed(0)}% < peer avg ${peerPE.avgPE}x` };
      else if (peerPE.diff > 8)  s6 = { status:'fail',    value:`${Math.abs(peerPE.diff).toFixed(0)}% > peer avg ${peerPE.avgPE}x` };
      else                       s6 = { status:'neutral', value:`In line, avg ${peerPE.avgPE}x` };
    } else if (peerPE?.medianPE) {
      s6 = { status:'neutral', value:`Peer avg ${peerPE.avgPE}x` };
    }
  } catch(_) {}
 
  const signals   = [s1,s2,s3,s4,s5,s6];
  const score     = signals.filter(s => s.status === 'pass').length;
  const SIG_NAMES = ['EPS beat','Low PE','Below 50d MA','Insider buying','Analyst upside','PE vs peers'];
  const passes    = signals.map((s,i) => s.status==='pass'?SIG_NAMES[i]:null).filter(Boolean);
  const fails     = signals.map((s,i) => s.status==='fail'?SIG_NAMES[i]:null).filter(Boolean);
 
  let summary;
  if      (score>=5)  summary=`Strong value candidate — ${score}/6 signals pass. Strengths: ${passes.join(', ')}.`;
  else if (score===4) summary=`Good signals (4/6). Passes: ${passes.join(', ')}.`;
  else if (score===3) summary=`Moderate signals (3/6). Passes: ${passes.join(', ')}.`;
  else if (score>0)   summary=`Weak signals (${score}/6). Fails: ${fails.join(', ')}.`;
  else                summary=`No signals pass. Fails: ${fails.join(', ')}.`;
 
  // Exchange: prefer Finnhub profile exchange, fall back to our map
  const exchange = EXCHANGE_MAP[ticker] || (p.exchange ? p.exchange.replace('NASDAQ NMS','NASDAQ').replace('New York Stock Exchange','NYSE') : 'NYSE');
 
  return {
    ticker,
    company:   p.name || ticker,
    exchange,
    price:     `$${curPx.toFixed(2)}`,
    change:    q.dp != null ? `${q.dp>0?'+':''}${q.dp.toFixed(2)}%` : null,
    marketCap: mcs,
    score,
    signals,
    summary,
    rating:    getRating(score),
    updatedAt: new Date().toISOString(),
  };
}
 
// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (cache.data && Date.now() - cache.timestamp < CACHE_TTL) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cache.data);
  }
 
  try {
    // Step 1: Yahoo scan — fast, no rate limits
    const BATCH_SIZE = 10;
    const batches = [];
    for (let i = 0; i < UNIVERSE.length; i += BATCH_SIZE) {
      batches.push(UNIVERSE.slice(i, i + BATCH_SIZE));
    }
    const allStocks = (await Promise.all(batches.map((b, i) => fetchBatch(b, i * 150)))).flat().filter(Boolean);
 
    // Step 2: Quick-score, pick top 6 for full analysis
    const candidates = allStocks
      .map(s => ({ ...s, qs: quickScore(s) }))
      .sort((a, b) => b.qs - a.qs)
      .slice(0, 6)
      .map(s => s.symbol);
 
    // Step 3: Full Finnhub analysis on candidates
    let top3 = [];
    if (FINNHUB_KEY) {
      const full = await Promise.allSettled(candidates.map(t => fullAnalyse(t)));
      top3 = full
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value)
        .sort((a, b) => (b.score||0) - (a.score||0))
        .slice(0, 3);
    } else {
      // No Finnhub key — return Yahoo data with placeholder signals
      top3 = allStocks
        .map(s => ({ ...s, qs: quickScore(s) }))
        .sort((a, b) => b.qs - a.qs)
        .slice(0, 3)
        .map(s => ({
          ticker:    s.symbol,
          company:   s.symbol,
          exchange:  EXCHANGE_MAP[s.symbol] || 'NYSE',
          price:     `$${s.price?.toFixed(2)}`,
          marketCap: s.marketCap ? `$${(s.marketCap/1e9).toFixed(0)}B` : 'N/A',
          score:     0,
          signals:   Array(6).fill({ status:'neutral', value:'Set FINNHUB_KEY in Vercel for full signals' }),
          summary:   'Add FINNHUB_KEY to Vercel environment variables to enable full signal analysis.',
          rating:    { label:'Watch', color:'#92400e', bg:'#fffbeb', border:'#fde68a' },
          updatedAt: new Date().toISOString(),
        }));
    }
 
    const result = { top3, totalScanned: allStocks.length, generatedAt: new Date().toISOString() };
    cache = { data: result, timestamp: Date.now() };
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    return res.status(200).json(result);
  } catch (err) {
    console.error('top3 error:', err);
    return res.status(500).json({ error: 'Failed to fetch stock data', detail: err.message });
  }
}
 
