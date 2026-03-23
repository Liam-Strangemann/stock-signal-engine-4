// pages/api/analyse.js
// Runs server-side on Vercel — no CORS, API key hidden from users
 
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const FH = 'https://finnhub.io/api/v1';
 
// ── Finnhub fetch ─────────────────────────────────────────────────────────────
async function fh(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${FH}${path}${sep}token=${FINNHUB_KEY}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
  const data = await res.json();
  if (data?.error) throw new Error(data.error);
  return data;
}
 
// ── Format helpers ────────────────────────────────────────────────────────────
function fmtShares(n) {
  if (!n || n === 0) return null;
  if (n >= 1e6) return `${(n/1e6).toFixed(2)}M shares`;
  if (n >= 1e3) return `${(n/1e3).toFixed(1)}K shares`;
  return `${n.toLocaleString()} shares`;
}
function fmtDollars(n) {
  if (!n || n === 0) return null;
  if (n >= 1e9) return `$${(n/1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
function timeAgo(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 7)   return `${days}d ago`;
  if (days < 14)  return '1w ago';
  if (days < 30)  return `${Math.floor(days/7)}w ago`;
  return `${Math.floor(days/30)}mo ago`;
}
 
// ── 50d MA — 3 sources ────────────────────────────────────────────────────────
function maFromCloses(closes) {
  if (!Array.isArray(closes) || closes.length < 10) return null;
  const slice = closes.slice(-50);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
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
    const r   = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&period1=${now-100*86400}&period2=${now}`,
      { headers:{'User-Agent':'Mozilla/5.0'}, signal:AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j      = await r.json();
      const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c=>c!=null&&!isNaN(c));
      const ma     = maFromCloses(closes);
      if (ma > 0) return ma;
    }
  } catch (_) {}
  return null;
}
 
// ── Analyst target — Yahoo then Stockanalysis ─────────────────────────────────
async function fetchAnalystTarget(ticker) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData`,
      { headers:{'User-Agent':'Mozilla/5.0'}, signal:AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j  = await r.json();
      const fd = j?.quoteSummary?.result?.[0]?.financialData;
      const t  = fd?.targetMedianPrice?.raw || fd?.targetMeanPrice?.raw;
      if (t > 0) return t;
    }
  } catch (_) {}
  try {
    const r = await fetch(
      `https://stockanalysis.com/stocks/${ticker.toLowerCase()}/forecast/`,
      { headers:{'User-Agent':'Mozilla/5.0'}, signal:AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const html = await r.text();
      for (const p of [/price\s+target[^$]*\$\s*([\d,]+\.?\d*)/i,/consensus[^$]*\$\s*([\d,]+\.?\d*)/i,/mean\s+target[^$]*\$\s*([\d,]+\.?\d*)/i]) {
        const m = html.match(p);
        if (m) { const v = parseFloat(m[1].replace(/,/g,'')); if (v>0&&v<100000) return v; }
      }
    }
  } catch (_) {}
  return null;
}
 
// ── Multi-source insider transactions (30 days) ───────────────────────────────
async function fetchInsiderTransactions(ticker, curPx) {
  const now    = Math.floor(Date.now()/1000);
  const ago30  = now - 30*86400;
  const from30 = new Date(ago30*1000).toISOString().slice(0,10);
  const to30   = new Date(now*1000).toISOString().slice(0,10);
  const cutoff = new Date(ago30*1000);
 
  // Source 1: Finnhub
  try {
    const d    = await fh(`/stock/insider-transactions?symbol=${ticker}&from=${from30}&to=${to30}`);
    const txns = d?.data || [];
    if (txns.length > 0) {
      const buys  = txns.filter(t => t.transactionCode === 'P');
      const sells = txns.filter(t => t.transactionCode === 'S');
      if (buys.length > 0 || sells.length > 0) return { buys, sells, source:'finnhub' };
    }
  } catch (_) {}
 
  // Source 2: OpenInsider
  try {
    const r = await fetch(
      `https://openinsider.com/screener?s=${ticker}&fd=-30&td=0&xs=1&vl=0&grp=0&cnt=20&action=1`,
      { headers:{'User-Agent':'Mozilla/5.0'}, signal:AbortSignal.timeout(7000) }
    );
    if (r.ok) {
      const html  = await r.text();
      const rows  = [...html.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/gi)];
      const buys  = [], sells = [];
      for (const row of rows) {
        const cells = [...row[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c=>c[1].replace(/<[^>]+>/g,'').trim());
        if (cells.length < 10) continue;
        const [,dateStr,,,type,,,,sharesRaw,valueRaw] = cells;
        if (!dateStr||!type) continue;
        const txDate = new Date(dateStr);
        if (isNaN(txDate)||txDate<cutoff) continue;
        const shares = parseInt((sharesRaw||'').replace(/[^0-9]/g,''))||0;
        const value  = parseInt((valueRaw||'').replace(/[^0-9]/g,''))||0;
        const entry  = { transactionDate:dateStr, share:shares, value, transactionPrice:shares>0?value/shares:curPx };
        if (/P\s*-\s*Purchase/i.test(type)) buys.push(entry);
        else if (/S\s*-\s*Sale/i.test(type)) sells.push(entry);
      }
      if (buys.length>0||sells.length>0) return { buys, sells, source:'openinsider' };
    }
  } catch (_) {}
 
  // Source 3: Yahoo Finance
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=insiderTransactions`,
      { headers:{'User-Agent':'Mozilla/5.0'}, signal:AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j    = await r.json();
      const txns = j?.quoteSummary?.result?.[0]?.insiderTransactions?.transactions || [];
      const buys = [], sells = [];
      for (const t of txns) {
        const dateTs = t.startDate?.raw;
        if (!dateTs) continue;
        const txDate = new Date(dateTs*1000);
        if (txDate<cutoff) continue;
        const dateStr = txDate.toISOString().slice(0,10);
        const shares  = Math.abs(t.shares?.raw||0);
        const value   = Math.abs(t.value?.raw||0);
        const desc    = (t.transactionDescription||'').toLowerCase();
        const entry   = { transactionDate:dateStr, share:shares, value, transactionPrice:shares>0?value/shares:curPx };
        if (/purchase|buy/i.test(desc)) buys.push(entry);
        else if (/sale|sell/i.test(desc)) sells.push(entry);
      }
      if (buys.length>0||sells.length>0) return { buys, sells, source:'yahoo' };
    }
  } catch (_) {}
 
  // Source 4: SEC EDGAR Form 4
  try {
    const r = await fetch(
      `https://efts.sec.gov/LATEST/search-index?q=%22${ticker}%22&dateRange=custom&startdt=${from30}&enddt=${to30}&forms=4`,
      { headers:{'User-Agent':'signal-engine/1.0'}, signal:AbortSignal.timeout(7000) }
    );
    if (r.ok) {
      const j    = await r.json();
      const hits = j?.hits?.hits || [];
      const buys = [];
      for (const hit of hits.slice(0,10)) {
        const src     = hit._source||{};
        const dateStr = src.file_date||src.period_of_report;
        if (!dateStr) continue;
        const txDate  = new Date(dateStr);
        if (isNaN(txDate)||txDate<cutoff) continue;
        if ((src.form_type||'').toUpperCase()!=='4') continue;
        buys.push({ transactionDate:dateStr, share:0, value:0, transactionPrice:curPx });
      }
      if (buys.length>0) return { buys, sells:[], source:'sec' };
    }
  } catch (_) {}
 
  return { buys:[], sells:[], source:null };
}
 
// ── Build insider signal value string ─────────────────────────────────────────
function buildInsiderValue(buys, sells, source) {
  if (buys.length > 0) {
    const totalShares = buys.reduce((s,t)=>s+(t.share||0),0);
    const totalValue  = buys.reduce((s,t)=>{
      const v = t.value || Math.abs((t.share||0)*(t.transactionPrice||0));
      return s+v;
    },0);
    const sharesStr = totalShares > 0 ? fmtShares(totalShares) : null;
    const dollarStr = totalValue  > 0 ? fmtDollars(totalValue)  : null;
 
    const dates   = buys.map(t=>t.transactionDate).filter(Boolean).sort().reverse();
    const recency = dates[0] ? timeAgo(dates[0]) : null;
 
    const parts = [`${buys.length} buy${buys.length>1?'s':''}`];
    if (sharesStr) parts.push(sharesStr);
    if (dollarStr) parts.push(dollarStr);
    if (recency)   parts.push(recency);
    return { status:'pass', value: parts.join(' · ') };
  }
  if (sells.length > 0) {
    const totalShares = sells.reduce((s,t)=>s+(t.share||0),0);
    const totalValue  = sells.reduce((s,t)=>{
      const v = t.value || Math.abs((t.share||0)*(t.transactionPrice||0));
      return s+v;
    },0);
    const sharesStr = totalShares > 0 ? fmtShares(totalShares) : null;
    const dollarStr = totalValue  > 0 ? fmtDollars(totalValue) : null;
    const dates   = sells.map(t=>t.transactionDate).filter(Boolean).sort().reverse();
    const recency = dates[0] ? timeAgo(dates[0]) : null;
    const parts   = [`${sells.length} sell${sells.length>1?'s':''}, no buys`];
    if (sharesStr) parts.push(sharesStr);
    if (dollarStr) parts.push(dollarStr);
    if (recency)   parts.push(recency);
    return { status:'fail', value: parts.join(' · ') };
  }
  return { status:'neutral', value: source ? 'No activity (30d)' : 'No data' };
}
 
// ── Peer PE comparison ────────────────────────────────────────────────────────
// ── Peer PE comparison ────────────────────────────────────────────────────────
// NOTE: Finnhub marketCapitalization in /stock/metric is in MILLIONS already
// So targetMC passed in must also be in millions (no *1e6)
async function fetchPeerPE(ticker, targetPE, targetMC, targetMargin) {
  try {
    // Step 1: get peer tickers — Finnhub first, Yahoo Finance as fallback
    let rawPeers = [];
    try {
      const pd = await fh(`/stock/peers?symbol=${ticker}`);
      if (Array.isArray(pd)) rawPeers = pd.filter(p => p !== ticker).slice(0, 15);
    } catch (_) {}
 
    if (rawPeers.length < 3) {
      try {
        const r = await fetch(
          `https://query1.finance.yahoo.com/v6/finance/recommendationsbysymbol/${ticker}`,
          { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
        );
        if (r.ok) {
          const j      = await r.json();
          const yPeers = (j?.finance?.result?.[0]?.recommendedSymbols || []).map(s => s.symbol);
          rawPeers = [...new Set([...rawPeers, ...yPeers])].filter(p => p !== ticker).slice(0, 15);
        }
      } catch (_) {}
    }
 
    if (rawPeers.length === 0) return null;
 
    // Step 2: fetch metrics for each peer in parallel
    const peerMetrics = await Promise.allSettled(
      rawPeers.map(p => fh(`/stock/metric?symbol=${p}&metric=all`))
    );
 
    const comparables = [];
    for (let i = 0; i < rawPeers.length; i++) {
      if (peerMetrics[i].status !== 'fulfilled') continue;
      const pm  = peerMetrics[i].value?.metric || {};
      const pe  = pm.peBasicExclExtraTTM || pm.peTTM;
      // marketCapitalization from Finnhub metric is already in MILLIONS — no conversion needed
      const mc  = pm.marketCapitalization || 0;
      const npm = pm.netProfitMarginAnnual || pm.netProfitMarginTTM;
 
      if (!pe || pe <= 0 || pe > 200) continue;
 
      // Market cap filter: 0.25x–4x of target (both values are in millions)
      if (targetMC > 0 && mc > 0) {
        const ratio = mc / targetMC;
        if (ratio < 0.25 || ratio > 4) continue;
      }
 
      if (targetMargin > 0 && npm !== null && npm < -5) continue;
      comparables.push({ ticker: rawPeers[i], pe, mc, npm });
    }
 
    if (comparables.length < 2) return null;
 
    // Step 3: remove PE outliers via IQR
    const pes   = comparables.map(c => c.pe).sort((a, b) => a - b);
    const q1    = pes[Math.floor(pes.length * 0.25)];
    const q3    = pes[Math.floor(pes.length * 0.75)];
    const iqr   = q3 - q1;
    const clean = comparables.filter(c => c.pe >= q1 - 1.5 * iqr && c.pe <= q3 + 1.5 * iqr);
    if (clean.length < 2) return null;
 
    // Step 4: median + average
    const cleanPes = clean.map(c => c.pe).sort((a, b) => a - b);
    const mid      = Math.floor(cleanPes.length / 2);
    const medianPE = cleanPes.length % 2 === 0
      ? (cleanPes[mid - 1] + cleanPes[mid]) / 2
      : cleanPes[mid];
    const avgPE = cleanPes.reduce((a, b) => a + b, 0) / cleanPes.length;
 
    if (!targetPE || targetPE <= 0) {
      return { medianPE: parseFloat(medianPE.toFixed(1)), avgPE: parseFloat(avgPE.toFixed(1)), peerCount: clean.length, diff: null, peers: clean.map(c => c.ticker) };
    }
 
    const diffPct = ((targetPE - medianPE) / medianPE * 100);
    return {
      medianPE:  parseFloat(medianPE.toFixed(1)),
      avgPE:     parseFloat(avgPE.toFixed(1)),
      peerCount: clean.length,
      diff:      parseFloat(diffPct.toFixed(1)),
      peers:     clean.map(c => c.ticker)
    };
  } catch (_) {
    return null;
  }
}
 
 
// ── Rating ────────────────────────────────────────────────────────────────────
function getRating(score) {
  if (score === 5) return { label:'Strong buy', color:'#14532d', bg:'#dcfce7', border:'#86efac' };
  if (score === 4) return { label:'Buy',         color:'#15803d', bg:'#f0fdf4', border:'#bbf7d0' };
  if (score === 3) return { label:'Watch',       color:'#92400e', bg:'#fffbeb', border:'#fde68a' };
  return             { label:'Ignore',           color:'#6b7280', bg:'#f9fafb', border:'#d1d5db' };
}
 
// ── Fetch all data ────────────────────────────────────────────────────────────
async function fetchStockData(ticker) {
  const [quote, profile, metrics, earnings, analystTarget] = await Promise.allSettled([
    fh(`/quote?symbol=${ticker}`),
    fh(`/stock/profile2?symbol=${ticker}`),
    fh(`/stock/metric?symbol=${ticker}&metric=all`),
    fh(`/stock/earnings?symbol=${ticker}&limit=4`),
    fetchAnalystTarget(ticker),
  ]);
 
  const curPx   = quote.status === 'fulfilled' ? quote.value?.c : null;
  const m       = metrics.status === 'fulfilled' ? metrics.value?.metric || {} : {};
  const targetPE = m.peBasicExclExtraTTM || m.peTTM || null;
  const targetMC = (m.marketCapitalization||0);
  const targetMargin = m.netProfitMarginAnnual || m.netProfitMarginTTM || 0;
 
  // Parallel: MA + insider + peer PE
  const [ma50, insiderData, peerPE] = await Promise.all([
    fetch50dMA(ticker),
    fetchInsiderTransactions(ticker, curPx),
    fetchPeerPE(ticker, targetPE, targetMC, targetMargin),
  ]);
 
  return {
    quote:         quote.status         === 'fulfilled' ? quote.value         : null,
    profile:       profile.status       === 'fulfilled' ? profile.value       : null,
    metrics:       metrics.status       === 'fulfilled' ? metrics.value       : null,
    earnings:      earnings.status      === 'fulfilled' ? earnings.value      : null,
    analystTarget: analystTarget.status === 'fulfilled' ? analystTarget.value : null,
    ma50,
    insiderData,
    peerPE,
  };
}
 
// ── Evaluate ──────────────────────────────────────────────────────────────────
function evaluate(ticker, d) {
  const q   = d.quote   || {};
  const p   = d.profile || {};
  const m   = d.metrics?.metric || {};
  const curPx = q.c;
  if (!curPx) return null;
 
  const company = p.name || ticker;
  const mc  = p.marketCapitalization ? p.marketCapitalization*1e6 : 0;
  const mcs = mc>1e12?`$${(mc/1e12).toFixed(2)}T`:mc>1e9?`$${(mc/1e9).toFixed(1)}B`:mc>1e6?`$${(mc/1e6).toFixed(0)}M`:'';
 
  // Signal 1 — EPS beat
  let s1 = { status:'neutral', value:'No data' };
  try {
    const earns = Array.isArray(d.earnings) ? d.earnings : [];
    if (earns.length > 0) {
      const e    = earns[0];
      const diff = e.actual - e.estimate;
      const beat = diff >= 0;
      const ds   = Math.abs(diff)<0.005?'in-line':beat?`+$${Math.abs(diff).toFixed(2)}`:`-$${Math.abs(diff).toFixed(2)}`;
      s1 = { status:beat?'pass':'fail', value:beat?`Beat by ${ds}`:`Missed ${ds}` };
    }
  } catch(_) {}
 
  // Signal 2 — PE vs historical average
  let s2 = { status:'neutral', value:'No data' };
  try {
    const curPE = m.peBasicExclExtraTTM || m.peTTM;
    const eps   = m.epsBasicExclExtraAnnual || m.epsTTM;
    const hi    = m['52WeekHigh'], lo = m['52WeekLow'];
    if (curPE && eps>0 && hi && lo) {
      const histPE = ((hi+lo)/2)/eps;
      if      (curPE < histPE*0.92) s2={ status:'pass',    value:`PE ${curPE.toFixed(1)}x < hist ~${histPE.toFixed(0)}x` };
      else if (curPE > histPE*1.08) s2={ status:'fail',    value:`PE ${curPE.toFixed(1)}x > hist ~${histPE.toFixed(0)}x` };
      else                          s2={ status:'neutral', value:`PE ${curPE.toFixed(1)}x ≈ hist ~${histPE.toFixed(0)}x` };
    } else if (curPE) s2={ status:'neutral', value:`PE ${curPE.toFixed(1)}x` };
  } catch(_) {}
 
  // Signal 3 — Price vs 50d MA
  let s3 = { status:'neutral', value:'No data' };
  try {
    const ma50 = d.ma50;
    if (ma50 && curPx) {
      const pct = ((curPx-ma50)/ma50*100).toFixed(1);
      s3 = curPx<=ma50
        ? { status:'pass', value:`$${curPx.toFixed(2)} ≤ MA $${ma50.toFixed(2)} (${pct}%)` }
        : { status:'fail', value:`$${curPx.toFixed(2)} > MA $${ma50.toFixed(2)} (+${pct}%)` };
    }
  } catch(_) {}
 
  // Signal 4 — Insider buying (multi-source, full detail)
  const { buys, sells, source } = d.insiderData || { buys:[], sells:[], source:null };
  const s4 = buildInsiderValue(buys, sells, source);
 
  // Signal 5 — Analyst price target ≥ +25%
  let s5 = { status:'neutral', value:'No data' };
  try {
    const tgt = d.analystTarget;
    if (tgt && curPx) {
      const up = ((tgt-curPx)/curPx*100).toFixed(1);
      s5 = parseFloat(up)>=25
        ? { status:'pass', value:`Target $${tgt.toFixed(2)}, +${up}% upside` }
        : { status:'fail', value:`Target $${tgt.toFixed(2)}, +${up}% upside` };
    }
  } catch(_) {}
 
  const signals = [s1,s2,s3,s4,s5];
  const score   = signals.filter(s=>s.status==='pass').length;
  const passes  = signals.map((s,i)=>s.status==='pass'?['EPS beat','Low PE','Below 50d MA','Insider buying','Analyst upside'][i]:null).filter(Boolean);
  const fails   = signals.map((s,i)=>s.status==='fail'?['EPS beat','Low PE','Below 50d MA','Insider buying','Analyst upside'][i]:null).filter(Boolean);
 
  let summary;
  if (score>=4)      summary=`Strong value candidate — ${score}/5 signals pass. Strengths: ${passes.join(', ')}.`;
  else if (score===3)summary=`Moderate signals (3/5). Passes: ${passes.join(', ')}.`;
  else if (score>0)  summary=`Weak signals (${score}/5). Fails: ${fails.join(', ')}.`;
  else               summary=`No signals pass. Fails: ${fails.join(', ')}.`;
 
  return {
    ticker, company,
    price:     `$${curPx.toFixed(2)}`,
    change:    q.dp!=null?`${q.dp>0?'+':''}${q.dp.toFixed(2)}%`:null,
    marketCap: mcs,
    score, signals, summary,
    rating:    getRating(score),
    peerPE:    d.peerPE || null,
    updatedAt: new Date().toISOString()
  };
}
 
// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error:'Method not allowed' });
  if (!FINNHUB_KEY)          return res.status(500).json({ error:'FINNHUB_KEY not set' });
  const { tickers } = req.body;
  if (!Array.isArray(tickers)||tickers.length===0) return res.status(400).json({ error:'tickers array required' });
 
  const results = {};
  const cleaned = tickers.slice(0,20).map(t=>t.toUpperCase().trim());
  await Promise.allSettled(cleaned.map(async ticker => {
    try {
      const raw = await fetchStockData(ticker);
      const ev  = evaluate(ticker, raw);
      results[ticker] = ev || { ticker, error:'No quote data' };
    } catch(e) { results[ticker] = { ticker, error:e.message }; }
  }));
 
  res.setHeader('Cache-Control','s-maxage=300, stale-while-revalidate');
  return res.status(200).json({ results, fetchedAt:new Date().toISOString() });
}
 
