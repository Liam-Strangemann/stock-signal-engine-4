// pages/api/analyse.js
// Runs server-side on Vercel — no CORS, API key hidden from users
 
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const FH = 'https://finnhub.io/api/v1';
 
const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
};
 
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
 
async function yahooFetch(url) {
  const r = await fetch(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  return r.json();
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
 
// ── 50d MA — Yahoo primary, Finnhub fallback ──────────────────────────────────
function maFromCloses(closes) {
  if (!Array.isArray(closes) || closes.length < 10) return null;
  const slice = closes.slice(-50);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}
async function fetch50dMA(ticker) {
  try {
    const now = Math.floor(Date.now()/1000);
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&period1=${now-100*86400}&period2=${now}`,
      { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j      = await r.json();
      const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c=>c!=null&&!isNaN(c));
      const ma     = maFromCloses(closes);
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
 
// ── Analyst target — Finnhub primary, Yahoo v11 fallback ──────────────────────
async function fetchAnalystTarget(ticker) {
  // Source 1: Finnhub price-target (free tier)
  try {
    const d = await fh(`/stock/price-target?symbol=${ticker}`);
    const t = d?.targetMedian || d?.targetMean;
    if (t && t > 0) return t;
  } catch (_) {}
 
  // Source 2: Yahoo v11 quoteSummary financialData
  try {
    const j = await yahooFetch(
      `https://query1.finance.yahoo.com/v11/finance/quoteSummary/${ticker}?modules=financialData`
    );
    const fd = j?.quoteSummary?.result?.[0]?.financialData;
    const t  = fd?.targetMedianPrice?.raw || fd?.targetMeanPrice?.raw;
    if (t && t > 0) return t;
  } catch (_) {}
 
  // Source 3: Yahoo query2 subdomain
  try {
    const j = await yahooFetch(
      `https://query2.finance.yahoo.com/v11/finance/quoteSummary/${ticker}?modules=financialData`
    );
    const fd = j?.quoteSummary?.result?.[0]?.financialData;
    const t  = fd?.targetMedianPrice?.raw || fd?.targetMeanPrice?.raw;
    if (t && t > 0) return t;
  } catch (_) {}
 
  // Source 4: Yahoo v10 fallback
  try {
    const j = await yahooFetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData`
    );
    const fd = j?.quoteSummary?.result?.[0]?.financialData;
    const t  = fd?.targetMedianPrice?.raw || fd?.targetMeanPrice?.raw;
    if (t && t > 0) return t;
  } catch (_) {}
 
  return null;
}
 
// ── Insider transactions ──────────────────────────────────────────────────────
async function fetchInsiderTransactions(ticker, curPx) {
  const now    = Math.floor(Date.now()/1000);
  const ago90  = now - 90*86400;
  const from90 = new Date(ago90*1000).toISOString().slice(0,10);
  const to90   = new Date(now*1000).toISOString().slice(0,10);
  const cutoff = new Date(ago90*1000);
  const seen   = new Set();
  const buys   = [], sells = [];
 
  // Source 1: Yahoo insiderTransactions (v11, full headers)
  try {
    const j    = await yahooFetch(`https://query1.finance.yahoo.com/v11/finance/quoteSummary/${ticker}?modules=insiderTransactions`);
    const txns = j?.quoteSummary?.result?.[0]?.insiderTransactions?.transactions || [];
    for (const t of txns) {
      const ts = t.startDate?.raw;
      if (!ts || new Date(ts*1000) < cutoff) continue;
      const ds   = new Date(ts*1000).toISOString().slice(0,10);
      const sh   = Math.abs(t.shares?.raw||0);
      const val  = Math.abs(t.value?.raw||0);
      const desc = (t.transactionDescription||'').toLowerCase();
      const key  = `${ds}-${sh}-${desc.slice(0,3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = { transactionDate:ds, share:sh, value:val, transactionPrice:sh>0?val/sh:curPx };
      if (/purchase|buy/i.test(desc)) buys.push(entry);
      else if (/sale|sell/i.test(desc)) sells.push(entry);
    }
    if (buys.length > 0 || sells.length > 0) return { buys, sells, source:'yahoo' };
  } catch (_) {}
 
  // Source 2: Finnhub
  try {
    const d    = await fh(`/stock/insider-transactions?symbol=${ticker}&from=${from90}&to=${to90}`);
    const txns = d?.data || [];
    for (const t of txns) {
      if (!t.transactionDate || new Date(t.transactionDate) < cutoff) continue;
      const sh  = Math.abs(t.share||0);
      const key = `${t.transactionDate}-${sh}-${t.transactionCode}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const val   = Math.abs(sh*(t.transactionPrice||curPx));
      const entry = { transactionDate:t.transactionDate, share:sh, value:val, transactionPrice:t.transactionPrice||curPx };
      if (t.transactionCode==='P') buys.push(entry);
      else if (t.transactionCode==='S') sells.push(entry);
    }
    if (buys.length > 0 || sells.length > 0) return { buys, sells, source:'finnhub' };
  } catch (_) {}
 
  // Source 3: SEC EDGAR Form 4
  try {
    const r = await fetch(
      `https://efts.sec.gov/LATEST/search-index?q=%22${ticker}%22&dateRange=custom&startdt=${from90}&enddt=${to90}&forms=4`,
      { headers:{'User-Agent':'signal-engine/1.0'}, signal:AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j    = await r.json();
      const hits = (j?.hits?.hits||[]).filter(h=>(h._source?.form_type||'').toUpperCase()==='4'&&new Date(h._source?.file_date)>=cutoff);
      if (hits.length > 0) {
        const secBuys = hits.slice(0,6).map(h=>({transactionDate:h._source.file_date,share:0,value:0,transactionPrice:curPx}));
        return { buys:secBuys, sells:[], source:'sec' };
      }
    }
  } catch (_) {}
 
  return { buys:[], sells:[], source:null };
}
 
function buildInsiderValue(buys, sells, source) {
  if (buys.length > 0) {
    if (source==='sec') {
      const rc = timeAgo(buys[0].transactionDate);
      return { status:'pass', value:`Form 4 · ${buys.length} filing${buys.length>1?'s':''}${rc?' · '+rc:''}` };
    }
    const totalShares = buys.reduce((s,t)=>s+(t.share||0),0);
    const totalValue  = buys.reduce((s,t)=>s+(t.value||Math.abs((t.share||0)*(t.transactionPrice||0))),0);
    const sharesStr   = fmtShares(totalShares);
    const dollarStr   = fmtDollars(totalValue);
    const dates       = buys.map(t=>t.transactionDate).filter(Boolean).sort().reverse();
    const recency     = dates[0] ? timeAgo(dates[0]) : null;
    const parts       = [`${buys.length} buy${buys.length>1?'s':''}`];
    if (sharesStr) parts.push(sharesStr);
    if (dollarStr) parts.push(dollarStr);
    if (recency)   parts.push(recency);
    return { status:'pass', value:parts.join(' · ') };
  }
  if (sells.length > 0) {
    const dates   = sells.map(t=>t.transactionDate).filter(Boolean).sort().reverse();
    const recency = dates[0] ? timeAgo(dates[0]) : null;
    // Only "fail" if there are recent sells (within 30d)
    const recentSells = sells.filter(s=>(Date.now()-new Date(s.transactionDate).getTime())<30*86400000);
    const status = recentSells.length > 0 ? 'fail' : 'neutral';
    const parts  = [`${sells.length} sell${sells.length>1?'s':''}, no buys`];
    if (recency) parts.push(recency);
    return { status, value:parts.join(' · ') };
  }
  return { status:'neutral', value:source?'No activity (90d)':'No data' };
}
 
// ── Peer PE comparison ────────────────────────────────────────────────────────
// Uses Yahoo recommendations as PRIMARY source — much more reliable than
// Finnhub peers for getting stocks with available PE data on the free tier
async function fetchPeerPE(ticker, targetPE, targetMC) {
  try {
    let rawPeers = [];
 
    // Source A: Yahoo recommended symbols (primary — tends to be same-sector profitable companies)
    try {
      const j = await yahooFetch(
        `https://query1.finance.yahoo.com/v6/finance/recommendationsbysymbol/${ticker}`
      );
      const yp = (j?.finance?.result?.[0]?.recommendedSymbols || []).map(s => s.symbol);
      rawPeers = [...rawPeers, ...yp];
    } catch (_) {}
 
    // Source B: Finnhub peers (supplement Yahoo)
    try {
      const pd = await fh(`/stock/peers?symbol=${ticker}`);
      if (Array.isArray(pd)) rawPeers = [...rawPeers, ...pd.filter(p => p !== ticker)];
    } catch (_) {}
 
    // Deduplicate and cap at 15
    rawPeers = [...new Set(rawPeers)].filter(p => p !== ticker).slice(0, 15);
    if (rawPeers.length === 0) return null;
 
    // Fetch metrics for all peers in parallel
    const peerMetrics = await Promise.allSettled(
      rawPeers.map(p => fh(`/stock/metric?symbol=${p}&metric=all`))
    );
 
    const all = [];
    for (let i = 0; i < rawPeers.length; i++) {
      if (peerMetrics[i].status !== 'fulfilled') continue;
      const pm = peerMetrics[i].value?.metric || {};
      const pe = pm.peBasicExclExtraTTM || pm.peTTM;
      const mc = pm.marketCapitalization || 0; // in millions
 
      // Must have valid positive PE
      if (!pe || pe <= 0 || pe > 300) continue;
 
      // Loose market cap filter — same order of magnitude
      if (targetMC > 0 && mc > 0) {
        const ratio = mc / targetMC;
        if (ratio < 0.05 || ratio > 20) continue; // very loose — just exclude tiny/massive outliers
      }
 
      all.push({ ticker: rawPeers[i], pe });
    }
 
    if (all.length < 2) return null;
 
    // Remove outliers: trim top/bottom 15% if enough peers
    let comparables = all;
    if (all.length >= 6) {
      const sorted = [...all].sort((a,b) => a.pe - b.pe);
      const trim   = Math.max(1, Math.floor(sorted.length * 0.15));
      comparables  = sorted.slice(trim, sorted.length - trim);
    }
 
    if (comparables.length < 2) return null;
 
    const pes    = comparables.map(c => c.pe).sort((a,b) => a-b);
    const mid    = Math.floor(pes.length / 2);
    const medPE  = pes.length%2===0 ? (pes[mid-1]+pes[mid])/2 : pes[mid];
    const avgPE  = pes.reduce((a,b) => a+b, 0) / pes.length;
 
    const result = {
      medianPE:  parseFloat(medPE.toFixed(1)),
      avgPE:     parseFloat(avgPE.toFixed(1)),
      peerCount: comparables.length,
      diff:      null,
    };
 
    if (targetPE && targetPE > 0) {
      result.diff = parseFloat(((targetPE - avgPE) / avgPE * 100).toFixed(1));
    }
 
    return result;
  } catch (_) {
    return null;
  }
}
 
// ── Rating ────────────────────────────────────────────────────────────────────
function getRating(score) {
  if (score === 6) return { label:'Strong buy', color:'#14532d', bg:'#dcfce7', border:'#86efac' };
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
 
  const curPx    = quote.status === 'fulfilled' ? quote.value?.c : null;
  const m        = metrics.status === 'fulfilled' ? metrics.value?.metric || {} : {};
  const targetPE = m.peBasicExclExtraTTM || m.peTTM || null;
  const targetMC = m.marketCapitalization || 0;
 
  const [ma50, insiderData, peerPE] = await Promise.all([
    fetch50dMA(ticker),
    fetchInsiderTransactions(ticker, curPx),
    fetchPeerPE(ticker, targetPE, targetMC),
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
async function evaluate(ticker, d) {
  const q   = d.quote   || {};
  const p   = d.profile || {};
  const m   = d.metrics?.metric || {};
  const curPx = q.c;
  if (!curPx) return null;
 
  const company = p.name || ticker;
  const mc  = p.marketCapitalization ? p.marketCapitalization*1e6 : 0;
  const mcs = mc>1e12?`$${(mc/1e12).toFixed(2)}T`:mc>1e9?`$${(mc/1e9).toFixed(1)}B`:mc>1e6?`$${(mc/1e6).toFixed(0)}M`:'';
 
  // Exchange
  const rawEx = (p.exchange||'').replace(/NASDAQ.*/i,'NASDAQ').replace(/New York Stock Exchange.*/i,'NYSE').toUpperCase().trim();
  const XM = {AAPL:'NASDAQ',MSFT:'NASDAQ',GOOGL:'NASDAQ',AMZN:'NASDAQ',META:'NASDAQ',NVDA:'NASDAQ',AVGO:'NASDAQ',ORCL:'NYSE',ADBE:'NASDAQ',INTU:'NASDAQ',AMD:'NASDAQ',INTC:'NASDAQ',QCOM:'NASDAQ',TXN:'NASDAQ',AMAT:'NASDAQ',MU:'NASDAQ',NOW:'NYSE',CRM:'NYSE',PANW:'NASDAQ',CSCO:'NASDAQ',IBM:'NYSE',JPM:'NYSE',BAC:'NYSE',WFC:'NYSE',GS:'NYSE',MS:'NYSE',BLK:'NYSE',C:'NYSE',AXP:'NYSE',SCHW:'NYSE',MA:'NYSE',V:'NYSE',LLY:'NYSE',JNJ:'NYSE',UNH:'NYSE',ABBV:'NYSE',MRK:'NYSE',PFE:'NYSE',TMO:'NYSE',ABT:'NYSE',AMGN:'NASDAQ',CVS:'NYSE',MDT:'NYSE',ISRG:'NASDAQ',XOM:'NYSE',CVX:'NYSE',COP:'NYSE',EOG:'NYSE',SLB:'NYSE',MPC:'NYSE',HD:'NYSE',MCD:'NYSE',NKE:'NYSE',SBUX:'NASDAQ',LOW:'NYSE',TGT:'NYSE',COST:'NASDAQ',WMT:'NYSE',KO:'NYSE',PEP:'NASDAQ',PG:'NYSE',PM:'NYSE',MO:'NYSE',T:'NYSE',VZ:'NYSE',TMUS:'NASDAQ',NEE:'NYSE',LIN:'NYSE',CAT:'NYSE',HON:'NASDAQ',GE:'NYSE',RTX:'NYSE',LMT:'NYSE',UPS:'NYSE',UNP:'NYSE',TSM:'NYSE',ASML:'NASDAQ',NVO:'NYSE',AZN:'NASDAQ',HSBC:'NYSE',SHEL:'NYSE',BHP:'NYSE',RIO:'NYSE'};
  const exchange = rawEx || XM[ticker] || 'NYSE';
 
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
    } else {
      // Yahoo fallback for EPS
      try {
        const j    = await yahooFetch(`https://query1.finance.yahoo.com/v11/finance/quoteSummary/${ticker}?modules=earningsHistory`);
        const hist = j?.quoteSummary?.result?.[0]?.earningsHistory?.history || [];
        if (hist.length > 0) {
          const rec = hist[hist.length-1];
          const a   = rec?.epsActual?.raw, e = rec?.epsEstimate?.raw;
          if (a!=null && e!=null) {
            const diff=a-e, beat=diff>=0;
            const ds=Math.abs(diff)<0.005?'in-line':beat?`+$${Math.abs(diff).toFixed(2)}`:`-$${Math.abs(diff).toFixed(2)}`;
            s1={status:beat?'pass':'fail',value:beat?`Beat by ${ds}`:`Missed ${ds}`};
          }
        }
      } catch(_) {}
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
    } else if (curPE) {
      s2={ status:'neutral', value:`PE ${curPE.toFixed(1)}x` };
    } else {
      // Yahoo fallback
      try {
        const j  = await yahooFetch(`https://query1.finance.yahoo.com/v11/finance/quoteSummary/${ticker}?modules=summaryDetail,defaultKeyStatistics`);
        const sd = j?.quoteSummary?.result?.[0]?.summaryDetail||{};
        const ks = j?.quoteSummary?.result?.[0]?.defaultKeyStatistics||{};
        const pe2=sd?.trailingPE?.raw||sd?.forwardPE?.raw, eps2=ks?.trailingEps?.raw;
        const hi2=sd?.fiftyTwoWeekHigh?.raw, lo2=sd?.fiftyTwoWeekLow?.raw;
        if (pe2&&eps2&&hi2&&lo2) {
          const h=((hi2+lo2)/2)/eps2;
          if(pe2<h*0.92)s2={status:'pass',value:`PE ${pe2.toFixed(1)}x < hist ~${h.toFixed(0)}x`};
          else if(pe2>h*1.08)s2={status:'fail',value:`PE ${pe2.toFixed(1)}x > hist ~${h.toFixed(0)}x`};
          else s2={status:'neutral',value:`PE ${pe2.toFixed(1)}x ≈ hist ~${h.toFixed(0)}x`};
        } else if (pe2) s2={status:'neutral',value:`PE ${pe2.toFixed(1)}x`};
      } catch(_) {}
    }
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
 
  // Signal 4 — Insider buying
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
 
  // Signal 6 — Peer PE comparison
  let s6 = { status:'neutral', value:'No data' };
  try {
    const pp = d.peerPE;
    if (pp && pp.diff !== null && pp.diff !== undefined) {
      if      (pp.diff < -8) s6 = { status:'pass',    value:`${Math.abs(pp.diff).toFixed(0)}% < peer avg ${pp.avgPE}x` };
      else if (pp.diff > 8)  s6 = { status:'fail',    value:`${Math.abs(pp.diff).toFixed(0)}% > peer avg ${pp.avgPE}x` };
      else                   s6 = { status:'neutral', value:`In line, avg ${pp.avgPE}x` };
    } else if (pp && pp.medianPE) {
      s6 = { status:'neutral', value:`Peer avg ${pp.avgPE}x` };
    }
  } catch(_) {}
 
  const signals   = [s1,s2,s3,s4,s5,s6];
  const score     = signals.filter(s=>s.status==='pass').length;
  const SIG_NAMES = ['EPS beat','Low PE','Below 50d MA','Insider buying','Analyst upside','PE vs peers'];
  const passes    = signals.map((s,i)=>s.status==='pass'?SIG_NAMES[i]:null).filter(Boolean);
  const fails     = signals.map((s,i)=>s.status==='fail'?SIG_NAMES[i]:null).filter(Boolean);
 
  let summary;
  if (score>=5)      summary=`Strong value candidate — ${score}/6 signals pass. Strengths: ${passes.join(', ')}.`;
  else if (score===4)summary=`Good signals (4/6). Passes: ${passes.join(', ')}.`;
  else if (score===3)summary=`Moderate signals (3/6). Passes: ${passes.join(', ')}.`;
  else if (score>0)  summary=`Weak signals (${score}/6). Passes: ${passes.join(', ')}. Fails: ${fails.join(', ')}.`;
  else               summary=`No signals pass. Fails: ${fails.join(', ')}.`;
 
  return {
    ticker, company, exchange,
    price:     `$${curPx.toFixed(2)}`,
    change:    q.dp!=null?`${q.dp>0?'+':''}${q.dp.toFixed(2)}%`:null,
    marketCap: mcs,
    score, signals, summary,
    rating:    getRating(score),
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
      const ev  = await evaluate(ticker, raw);
      results[ticker] = ev || { ticker, error:'No quote data' };
    } catch(e) { results[ticker] = { ticker, error:e.message }; }
  }));
 
  res.setHeader('Cache-Control','s-maxage=300, stale-while-revalidate');
  return res.status(200).json({ results, fetchedAt:new Date().toISOString() });
}
 
