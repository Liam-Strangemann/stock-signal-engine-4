// pages/api/top3.js
//
// TIER 1 — Yahoo Finance scan (free, no key, fast)
//   • Fetches price/PE/52w data for ~180 stocks in parallel batches
//   • Quick-scores every stock on value + momentum metrics
//   • No Finnhub calls at this stage → no rate-limit risk
//
// TIER 2 — Full Finnhub signal analysis (top 5 candidates only)
//   • Runs the full 6-signal analysis
//   • Each stock's internal calls run in parallel
//   • Sorted by score, top 3 cached
//
// Cache: 1 hour in-memory. First load ~15-20s, subsequent loads instant.
 
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const FH = 'https://finnhub.io/api/v1';
 
// Full browser headers — required for Yahoo to not block server-side requests
const YH = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
};
 
const UNIVERSE = [
  'AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','AVGO','ORCL','ADBE',
  'AMD','INTC','QCOM','TXN','AMAT','MU','NOW','CRM','PANW','INTU',
  'CSCO','IBM','ACN','HPQ','KLAC','LRCX','SNPS','CDNS',
  'JPM','BAC','WFC','GS','MS','BLK','C','AXP','SCHW','USB',
  'PNC','TFC','COF','DFS','AIG','MET','PRU','AFL','CB','TRV',
  'CME','ICE','SPGI','MCO','MA','V',
  'LLY','JNJ','UNH','ABBV','MRK','PFE','TMO','ABT','AMGN','CVS',
  'MDT','ISRG','BSX','SYK','REGN','BIIB','VRTX','CI','HUM','ELV',
  'XOM','CVX','COP','EOG','SLB','MPC','PSX','VLO','OXY','DVN',
  'HAL','BKR','HES','TPL',
  'HD','MCD','NKE','SBUX','LOW','TGT','COST','WMT','TJX','ROST',
  'BKNG','MAR','HLT','YUM','CMG','DRI','TSCO','ORLY','AZO',
  'KO','PEP','PG','PM','MO','KHC','GIS','HSY','MDLZ','CL',
  'CLX','CHD','SYY','KR','CAG','MKC','HRL','TSN',
  'CAT','HON','MMM','GE','RTX','LMT','NOC','GD','UPS','FDX',
  'UNP','CSX','NSC','DE','EMR','ROK','ITW','ETN','PH','DOV',
  'LIN','APD','ECL','NEM','FCX','PPG','SHW',
  'T','VZ','TMUS','NEE','DUK','SO','AEP','EXC',
  'AMT','PLD','EQIX','CCI','SPG','O','VICI',
  'TSM','ASML','NVO','SAP','TM','AZN','HSBC','SHEL','BHP','RIO',
  'NVS','UL','DEO','BTI','GSK',
];
 
const UNIQ = [...new Set(UNIVERSE)];
 
const XM = {
  AAPL:'NASDAQ',MSFT:'NASDAQ',GOOGL:'NASDAQ',AMZN:'NASDAQ',META:'NASDAQ',
  NVDA:'NASDAQ',TSLA:'NASDAQ',AVGO:'NASDAQ',ORCL:'NYSE',ADBE:'NASDAQ',
  AMD:'NASDAQ',INTC:'NASDAQ',QCOM:'NASDAQ',TXN:'NASDAQ',AMAT:'NASDAQ',
  MU:'NASDAQ',NOW:'NYSE',CRM:'NYSE',PANW:'NASDAQ',INTU:'NASDAQ',
  CSCO:'NASDAQ',IBM:'NYSE',HPQ:'NYSE',KLAC:'NASDAQ',LRCX:'NASDAQ',
  SNPS:'NASDAQ',CDNS:'NASDAQ',
  JPM:'NYSE',BAC:'NYSE',WFC:'NYSE',GS:'NYSE',MS:'NYSE',BLK:'NYSE',
  C:'NYSE',AXP:'NYSE',SCHW:'NYSE',USB:'NYSE',PNC:'NYSE',TFC:'NYSE',
  COF:'NYSE',DFS:'NYSE',AIG:'NYSE',MET:'NYSE',PRU:'NYSE',AFL:'NYSE',
  CB:'NYSE',TRV:'NYSE',CME:'NASDAQ',ICE:'NYSE',SPGI:'NYSE',MCO:'NYSE',
  MA:'NYSE',V:'NYSE',
  LLY:'NYSE',JNJ:'NYSE',UNH:'NYSE',ABBV:'NYSE',MRK:'NYSE',PFE:'NYSE',
  TMO:'NYSE',ABT:'NYSE',AMGN:'NASDAQ',CVS:'NYSE',MDT:'NYSE',
  ISRG:'NASDAQ',BSX:'NYSE',SYK:'NYSE',REGN:'NASDAQ',BIIB:'NASDAQ',
  VRTX:'NASDAQ',CI:'NYSE',HUM:'NYSE',ELV:'NYSE',
  XOM:'NYSE',CVX:'NYSE',COP:'NYSE',EOG:'NYSE',SLB:'NYSE',MPC:'NYSE',
  PSX:'NYSE',VLO:'NYSE',OXY:'NYSE',DVN:'NYSE',HAL:'NYSE',BKR:'NYSE',
  HD:'NYSE',MCD:'NYSE',NKE:'NYSE',SBUX:'NASDAQ',LOW:'NYSE',TGT:'NYSE',
  COST:'NASDAQ',WMT:'NYSE',BKNG:'NASDAQ',MAR:'NASDAQ',
  CAT:'NYSE',HON:'NASDAQ',MMM:'NYSE',GE:'NYSE',RTX:'NYSE',LMT:'NYSE',
  NOC:'NYSE',GD:'NYSE',UPS:'NYSE',FDX:'NYSE',UNP:'NYSE',CSX:'NASDAQ',
  NSC:'NYSE',DE:'NYSE',
  KO:'NYSE',PEP:'NASDAQ',PG:'NYSE',PM:'NYSE',MO:'NYSE',
  T:'NYSE',VZ:'NYSE',TMUS:'NASDAQ',NEE:'NYSE',
  LIN:'NYSE',APD:'NYSE',ECL:'NYSE',NEM:'NYSE',FCX:'NYSE',
  AMT:'NYSE',PLD:'NYSE',EQIX:'NASDAQ',CCI:'NYSE',SPG:'NYSE',
  TSM:'NYSE',ASML:'NASDAQ',NVO:'NYSE',SAP:'NYSE',TM:'NYSE',
  AZN:'NASDAQ',HSBC:'NYSE',SHEL:'NYSE',BHP:'NYSE',RIO:'NYSE',
};
 
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 60 * 60 * 1000;
 
// ── TIER 1: Yahoo quick scan ──────────────────────────────────────────────────
async function fetchYahooQuote(symbol) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`,
      { headers: YH, signal: AbortSignal.timeout(7000) }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;
    const price = meta.regularMarketPrice;
    const hi = meta.fiftyTwoWeekHigh, lo = meta.fiftyTwoWeekLow;
    const range = hi - lo;
    return {
      symbol, price, yearHigh: hi, yearLow: lo,
      peRatio:      meta.trailingPE  ?? null,
      marketCap:    meta.marketCap   ?? null,
      lowProximity: range > 0 ? ((price - lo) / range) * 100 : 50,
    };
  } catch { return null; }
}
 
function quickScore(s) {
  let n = 0;
  if (s.peRatio && s.peRatio > 0 && s.peRatio < 200) n += Math.max(0, 40 - s.peRatio);
  n += Math.max(0, 30 - (s.lowProximity || 50) * 0.3);
  if (s.marketCap && s.marketCap > 50e9)  n += 8;
  if (s.marketCap && s.marketCap > 200e9) n += 4;
  return Math.round(n);
}
 
// ── Finnhub helper ────────────────────────────────────────────────────────────
async function fh(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${FH}${path}${sep}token=${FINNHUB_KEY}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) throw new Error(`Finnhub ${res.status}`);
  const d = await res.json();
  if (d?.error) throw new Error(d.error);
  return d;
}
 
// ── 50d MA ────────────────────────────────────────────────────────────────────
function maFromCloses(closes) {
  if (!Array.isArray(closes) || closes.length < 10) return null;
  const s = closes.slice(-50);
  return s.reduce((a, b) => a + b, 0) / s.length;
}
async function fetch50dMA(ticker) {
  // Yahoo primary (with browser headers)
  try {
    const now = Math.floor(Date.now() / 1000);
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&period1=${now-100*86400}&period2=${now}`,
      { headers: YH, signal: AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j      = await r.json();
      const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c=>c!=null&&!isNaN(c));
      const ma     = maFromCloses(closes);
      if (ma > 0) return ma;
    }
  } catch (_) {}
  // Finnhub fallback
  try {
    const d = await fh(`/stock/candle?symbol=${ticker}&resolution=D&count=60`);
    if (d?.s === 'ok' && Array.isArray(d.c) && d.c.length >= 10) {
      const ma = maFromCloses(d.c);
      if (ma > 0) return ma;
    }
  } catch (_) {}
  return null;
}
 
// ── Analyst target — 4 sources ────────────────────────────────────────────────
async function fetchAnalystTarget(ticker) {
  // Source 1: Finnhub
  try {
    const d = await fh(`/stock/price-target?symbol=${ticker}`);
    const t = d?.targetMedian || d?.targetMean;
    if (t && t > 0) return t;
  } catch (_) {}
  // Sources 2-4: Yahoo with browser headers
  for (const url of [
    `https://query1.finance.yahoo.com/v11/finance/quoteSummary/${ticker}?modules=financialData`,
    `https://query2.finance.yahoo.com/v11/finance/quoteSummary/${ticker}?modules=financialData`,
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData`,
  ]) {
    try {
      const r = await fetch(url, { headers: YH, signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const j  = await r.json();
        const fd = j?.quoteSummary?.result?.[0]?.financialData;
        const t  = fd?.targetMedianPrice?.raw || fd?.targetMeanPrice?.raw;
        if (t && t > 0) return t;
      }
    } catch (_) {}
  }
  return null;
}
 
// ── Insider transactions — 3 sources ─────────────────────────────────────────
function fmtShares(n) { if (!n) return null; if (n>=1e6) return `${(n/1e6).toFixed(2)}M shares`; if (n>=1e3) return `${(n/1e3).toFixed(1)}K shares`; return `${n.toLocaleString()} shares`; }
function fmtDollars(n) { if (!n) return null; if (n>=1e9) return `$${(n/1e9).toFixed(2)}B`; if (n>=1e6) return `$${(n/1e6).toFixed(2)}M`; if (n>=1e3) return `$${(n/1e3).toFixed(0)}K`; return `$${n.toFixed(0)}`; }
function timeAgo(d) { if (!d) return null; const days=Math.floor((Date.now()-new Date(d).getTime())/86400000); if(days===0)return 'today'; if(days===1)return '1d ago'; if(days<7)return `${days}d ago`; if(days<14)return '1w ago'; if(days<30)return `${Math.floor(days/7)}w ago`; return `${Math.floor(days/30)}mo ago`; }
 
async function fetchInsiderTransactions(ticker, curPx) {
  const now   = Math.floor(Date.now()/1000);
  const ago60 = now - 60*86400;
  const from  = new Date(ago60*1000).toISOString().slice(0,10);
  const to    = new Date(now*1000).toISOString().slice(0,10);
  const cutoff = new Date(ago60*1000);
 
  // Source 1: Yahoo with browser headers (v11 first)
  for (const url of [
    `https://query1.finance.yahoo.com/v11/finance/quoteSummary/${ticker}?modules=insiderTransactions`,
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=insiderTransactions`,
  ]) {
    try {
      const r = await fetch(url, { headers: YH, signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const j    = await r.json();
        const txns = j?.quoteSummary?.result?.[0]?.insiderTransactions?.transactions || [];
        const buys = [], sells = [];
        for (const t of txns) {
          const ts = t.startDate?.raw;
          if (!ts || new Date(ts*1000) < cutoff) continue;
          const ds   = new Date(ts*1000).toISOString().slice(0,10);
          const sh   = Math.abs(t.shares?.raw||0);
          const val  = Math.abs(t.value?.raw||0);
          const desc = (t.transactionDescription||'').toLowerCase();
          const entry = { transactionDate:ds, share:sh, value:val, transactionPrice:sh>0?val/sh:curPx };
          if (/purchase|buy/i.test(desc)) buys.push(entry);
          else if (/sale|sell/i.test(desc)) sells.push(entry);
        }
        if (buys.length > 0 || sells.length > 0) return { buys, sells, source:'yahoo' };
      }
    } catch (_) {}
  }
 
  // Source 2: Finnhub
  try {
    const d    = await fh(`/stock/insider-transactions?symbol=${ticker}&from=${from}&to=${to}`);
    const txns = d?.data || [];
    const buys  = txns.filter(t => t.transactionCode === 'P');
    const sells = txns.filter(t => t.transactionCode === 'S');
    if (buys.length > 0 || sells.length > 0) return { buys, sells, source:'finnhub' };
  } catch (_) {}
 
  // Source 3: SEC EDGAR Form 4
  try {
    const r = await fetch(
      `https://efts.sec.gov/LATEST/search-index?q=%22${ticker}%22&dateRange=custom&startdt=${from}&enddt=${to}&forms=4`,
      { headers:{'User-Agent':'signal-engine/1.0'}, signal:AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j    = await r.json();
      const hits = (j?.hits?.hits||[]).filter(h=>(h._source?.form_type||'').toUpperCase()==='4'&&new Date(h._source?.file_date)>=cutoff);
      if (hits.length > 0) {
        const buys = hits.slice(0,6).map(h=>({transactionDate:h._source.file_date,share:0,value:0,transactionPrice:curPx}));
        return { buys, sells:[], source:'sec' };
      }
    }
  } catch (_) {}
 
  return { buys:[], sells:[], source:null };
}
 
function buildInsiderValue(buys, sells, source) {
  if (buys.length > 0) {
    if (source==='sec') { const rc=timeAgo(buys[0].transactionDate); return { status:'pass', value:`Form 4 · ${buys.length} filing${buys.length>1?'s':''}${rc?' · '+rc:''}` }; }
    const sh = fmtShares(buys.reduce((s,t)=>s+(t.share||0),0));
    const dl = fmtDollars(buys.reduce((s,t)=>s+(t.value||Math.abs((t.share||0)*(t.transactionPrice||0))),0));
    const rc = timeAgo(buys.map(t=>t.transactionDate).filter(Boolean).sort().reverse()[0]);
    const parts = [`${buys.length} buy${buys.length>1?'s':''}`];
    if (sh) parts.push(sh); if (dl) parts.push(dl); if (rc) parts.push(rc);
    return { status:'pass', value:parts.join(' · ') };
  }
  if (sells.length > 0) {
    const rc = timeAgo(sells.map(t=>t.transactionDate).filter(Boolean).sort().reverse()[0]);
    // Only fail if sells are recent (<30d)
    const recentSells = sells.filter(s=>(Date.now()-new Date(s.transactionDate).getTime())<30*86400000);
    const status = recentSells.length > 0 ? 'fail' : 'neutral';
    const parts = [`${sells.length} sell${sells.length>1?'s':''}, no buys`];
    if (rc) parts.push(rc);
    return { status, value:parts.join(' · ') };
  }
  return { status:'neutral', value:source?'No activity (60d)':'No data' };
}
 
// ── Peer PE — Yahoo recommendations primary ───────────────────────────────────
async function fetchPeerPE(ticker, targetPE) {
  try {
    let rawPeers = [];
    // Primary: Yahoo recommendations (same-sector profitable companies)
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v6/finance/recommendationsbysymbol/${ticker}`,
        { headers: YH, signal: AbortSignal.timeout(5000) }
      );
      if (r.ok) {
        const j  = await r.json();
        const yp = (j?.finance?.result?.[0]?.recommendedSymbols||[]).map(s=>s.symbol);
        rawPeers = [...rawPeers, ...yp];
      }
    } catch (_) {}
    // Supplement: Finnhub peers
    try {
      const pd = await fh(`/stock/peers?symbol=${ticker}`);
      if (Array.isArray(pd)) rawPeers = [...rawPeers, ...pd.filter(p=>p!==ticker)];
    } catch (_) {}
 
    rawPeers = [...new Set(rawPeers)].filter(p=>p!==ticker).slice(0,15);
    if (rawPeers.length === 0) return null;
 
    const pm = await Promise.allSettled(rawPeers.map(p=>fh(`/stock/metric?symbol=${p}&metric=all`)));
    const pes = [];
    for (let i=0; i<rawPeers.length; i++) {
      if (pm[i].status!=='fulfilled') continue;
      const pe = pm[i].value?.metric?.peBasicExclExtraTTM || pm[i].value?.metric?.peTTM;
      if (pe && pe>0 && pe<300) pes.push(pe);
    }
    if (pes.length < 2) return null;
 
    const sorted = [...pes].sort((a,b)=>a-b);
    const mid    = Math.floor(sorted.length/2);
    const medPE  = sorted.length%2===0?(sorted[mid-1]+sorted[mid])/2:sorted[mid];
    const avgPE  = sorted.reduce((a,b)=>a+b,0)/sorted.length;
    const diff   = targetPE && targetPE>0 ? parseFloat(((targetPE-avgPE)/avgPE*100).toFixed(1)) : null;
    return { medianPE:parseFloat(medPE.toFixed(1)), avgPE:parseFloat(avgPE.toFixed(1)), peerCount:pes.length, diff };
  } catch (_) { return null; }
}
 
// ── Rating ────────────────────────────────────────────────────────────────────
function getRating(score) {
  if (score>=5) return {label:'Strong Buy',color:'#14532d',bg:'#dcfce7',border:'#86efac'};
  if (score===4) return {label:'Buy',color:'#15803d',bg:'#f0fdf4',border:'#bbf7d0'};
  if (score===3) return {label:'Watch',color:'#92400e',bg:'#fffbeb',border:'#fde68a'};
  return {label:'Ignore',color:'#6b7280',bg:'#f9fafb',border:'#d1d5db'};
}
 
// ── TIER 2: Full signal analysis ──────────────────────────────────────────────
async function fullAnalyse(ticker) {
  const [quote, profile, metrics, earnings] = await Promise.allSettled([
    fh(`/quote?symbol=${ticker}`),
    fh(`/stock/profile2?symbol=${ticker}`),
    fh(`/stock/metric?symbol=${ticker}&metric=all`),
    fh(`/stock/earnings?symbol=${ticker}&limit=4`),
  ]);
 
  const q   = quote.status  ==='fulfilled' ? quote.value  ||{} : {};
  const p   = profile.status==='fulfilled' ? profile.value||{} : {};
  const m   = metrics.status==='fulfilled' ? metrics.value?.metric||{} : {};
  const curPx = q.c;
  if (!curPx) return null;
 
  const targetPE = m.peBasicExclExtraTTM||m.peTTM||null;
 
  const [ma50, insiderData, analystTarget, peerPE] = await Promise.all([
    fetch50dMA(ticker),
    fetchInsiderTransactions(ticker, curPx),
    fetchAnalystTarget(ticker),
    fetchPeerPE(ticker, targetPE),
  ]);
 
  const mc  = p.marketCapitalization ? p.marketCapitalization*1e6 : 0;
  const mcs = mc>1e12?`$${(mc/1e12).toFixed(2)}T`:mc>1e9?`$${(mc/1e9).toFixed(1)}B`:mc>1e6?`$${(mc/1e6).toFixed(0)}M`:'';
 
  // S1: EPS beat
  let s1 = {status:'neutral',value:'No data'};
  try {
    const earns = Array.isArray(earnings.value) ? earnings.value : [];
    if (earns.length > 0) {
      const e    = earns[0];
      const diff = e.actual - e.estimate;
      const beat = diff >= 0;
      const ds   = Math.abs(diff)<0.005?'in-line':beat?`+$${Math.abs(diff).toFixed(2)}`:`-$${Math.abs(diff).toFixed(2)}`;
      s1 = {status:beat?'pass':'fail',value:beat?`Beat by ${ds}`:`Missed ${ds}`};
    }
  } catch(_) {}
 
  // S2: PE vs historical average
  let s2 = {status:'neutral',value:'No data'};
  try {
    const curPE = m.peBasicExclExtraTTM||m.peTTM;
    const eps   = m.epsBasicExclExtraAnnual||m.epsTTM;
    const hi    = m['52WeekHigh'], lo = m['52WeekLow'];
    if (curPE && eps>0 && hi && lo) {
      const h = ((hi+lo)/2)/eps;
      if      (curPE<h*0.92) s2={status:'pass',   value:`PE ${curPE.toFixed(1)}x < hist ~${h.toFixed(0)}x`};
      else if (curPE>h*1.08) s2={status:'fail',   value:`PE ${curPE.toFixed(1)}x > hist ~${h.toFixed(0)}x`};
      else                   s2={status:'neutral',value:`PE ${curPE.toFixed(1)}x ≈ hist ~${h.toFixed(0)}x`};
    } else if (curPE) s2={status:'neutral',value:`PE ${curPE.toFixed(1)}x`};
  } catch(_) {}
 
  // S3: Price vs 50d MA
  let s3 = {status:'neutral',value:'No data'};
  try {
    if (ma50 && curPx) {
      const pct = ((curPx-ma50)/ma50*100).toFixed(1);
      s3 = curPx<=ma50
        ? {status:'pass',value:`$${curPx.toFixed(2)} ≤ MA $${ma50.toFixed(2)} (${pct}%)`}
        : {status:'fail',value:`$${curPx.toFixed(2)} > MA $${ma50.toFixed(2)} (+${pct}%)`};
    }
  } catch(_) {}
 
  // S4: Insider buying
  const {buys,sells,source} = insiderData||{buys:[],sells:[],source:null};
  const s4 = buildInsiderValue(buys, sells, source);
 
  // S5: Analyst target ≥ +25%
  let s5 = {status:'neutral',value:'No data'};
  try {
    if (analystTarget && curPx) {
      const up = ((analystTarget-curPx)/curPx*100).toFixed(1);
      s5 = parseFloat(up)>=25
        ? {status:'pass',value:`Target $${analystTarget.toFixed(2)}, +${up}% upside`}
        : {status:'fail',value:`Target $${analystTarget.toFixed(2)}, +${up}% upside`};
    }
  } catch(_) {}
 
  // S6: PE vs peers
  let s6 = {status:'neutral',value:'No data'};
  try {
    if (peerPE && peerPE.diff !== null) {
      if      (peerPE.diff<-8) s6={status:'pass',  value:`${Math.abs(peerPE.diff).toFixed(0)}% < peer avg ${peerPE.avgPE}x`};
      else if (peerPE.diff>8)  s6={status:'fail',  value:`${Math.abs(peerPE.diff).toFixed(0)}% > peer avg ${peerPE.avgPE}x`};
      else                     s6={status:'neutral',value:`In line, avg ${peerPE.avgPE}x`};
    } else if (peerPE?.medianPE) s6={status:'neutral',value:`Peer avg ${peerPE.avgPE}x`};
  } catch(_) {}
 
  const signals   = [s1,s2,s3,s4,s5,s6];
  const score     = signals.filter(s=>s.status==='pass').length;
  const SIG_NAMES = ['EPS beat','Low PE','Below 50d MA','Insider buying','Analyst upside','PE vs peers'];
  const passes    = signals.map((s,i)=>s.status==='pass'?SIG_NAMES[i]:null).filter(Boolean);
  const fails     = signals.map((s,i)=>s.status==='fail'?SIG_NAMES[i]:null).filter(Boolean);
 
  let summary;
  if      (score>=5)  summary=`Strong value candidate — ${score}/6 signals pass. Strengths: ${passes.join(', ')}.`;
  else if (score===4) summary=`Good signals (4/6). Passes: ${passes.join(', ')}.`;
  else if (score===3) summary=`Moderate signals (3/6). Passes: ${passes.join(', ')}.`;
  else if (score>0)   summary=`Weak signals (${score}/6). Passes: ${passes.join(', ')}. Fails: ${fails.join(', ')}.`;
  else                summary=`No signals pass. Fails: ${fails.join(', ')}.`;
 
  const rawEx  = (p.exchange||'').replace(/NASDAQ.*/i,'NASDAQ').replace(/New York Stock Exchange.*/i,'NYSE').toUpperCase().trim();
  return {
    ticker, company:p.name||ticker,
    exchange:rawEx||XM[ticker]||'NYSE',
    price:`$${curPx.toFixed(2)}`,
    change:q.dp!=null?`${q.dp>0?'+':''}${q.dp.toFixed(2)}%`:null,
    marketCap:mcs, score, signals, summary, rating:getRating(score),
    updatedAt:new Date().toISOString(),
  };
}
 
// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (cache.data && Date.now()-cache.timestamp < CACHE_TTL) {
    res.setHeader('X-Cache','HIT');
    return res.status(200).json(cache.data);
  }
  try {
    // TIER 1: Yahoo scan — all symbols in parallel batches of 20
    const BATCH = 20;
    const batches = [];
    for (let i=0; i<UNIQ.length; i+=BATCH) batches.push(UNIQ.slice(i,i+BATCH));
    const allStocks = (await Promise.all(batches.map(b=>Promise.all(b.map(fetchYahooQuote))))).flat().filter(Boolean);
 
    // Quick-score and pick top 6 candidates across sectors
    const candidates = allStocks
      .map(s=>({...s,qs:quickScore(s)}))
      .sort((a,b)=>b.qs-a.qs)
      .slice(0,6)
      .map(s=>s.symbol);
 
    // TIER 2: Full analysis on candidates, return top 3 by score
    const top3 = [];
    if (FINNHUB_KEY) {
      const results = await Promise.allSettled(candidates.map(t=>fullAnalyse(t)));
      for (const r of results) {
        if (r.status==='fulfilled' && r.value) top3.push(r.value);
      }
      top3.sort((a,b)=>(b.score||0)-(a.score||0));
    }
 
    const result = {
      top3:       top3.slice(0,3),
      totalScanned: allStocks.length,
      generatedAt:  new Date().toISOString(),
    };
    cache = {data:result, timestamp:Date.now()};
    res.setHeader('Cache-Control','s-maxage=3600, stale-while-revalidate');
    return res.status(200).json(result);
  } catch(err) {
    console.error('top3 error:', err);
    return res.status(500).json({error:'Failed to fetch stock data', detail:err.message});
  }
}
 
