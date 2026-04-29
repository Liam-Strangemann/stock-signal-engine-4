// pages/api/analyse.js  v13
//
// KEY CHANGES vs v12:
//
// 1. TWO-PASS ARCHITECTURE (solves Vercel 10s timeout + empty pills)
//    Pass 1 — "fast" (<4s): only uses data already in the Yahoo chart response
//             (price, PE, 52w hi/lo, MA from closes) + Finnhub quote/profile/earnings.
//             Returns partial results immediately. Frontend renders what it has.
//    Pass 2 — "enrich" (called separately by frontend after receiving pass-1):
//             Runs the slow sources (insider, peer PE, analyst target, AV overview).
//             Has its own 8s budget. Frontend merges the enriched signals on top.
//    Frontend calls POST /api/analyse with { tickers, pass: 1 } then
//                         POST /api/analyse with { tickers, pass: 2 }.
//
// 2. HARD PER-SOURCE TIMEOUTS — every fetch is wrapped in AbortSignal.timeout.
//    No source is allowed to hold the whole response hostage.
//    Pass-1 sources: 4s each.   Pass-2 sources: 6s each.
//
// 3. CONCURRENT FAN-OUT already in v12 is preserved (raceValid helper).
//
// 4. YAHOO CHART CARRIES MOST OF WHAT WE NEED IN ONE REQUEST:
//    price, 52w hi/lo, trailingPE, marketCap, volume, MA50 (computed from closes).
//    This single call now handles signals 2 (PE hist), 3 (MA50) in pass 1.
//
// 5. INSIDER — parallel 4-source fetch preserved from v12. In pass 2.
//
// 6. If pass param is absent, runs both passes (backward compat for custom scan).

const FINNHUB_KEY = process.env.FINNHUB_KEY;
const AV_KEY      = process.env.AV_KEY;
const FH  = 'https://finnhub.io/api/v1';
const AV  = 'https://www.alphavantage.co/query';

const API_HEADERS = {
  'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept':'application/json, text/plain, */*','Accept-Language':'en-US,en;q=0.9',
  'Origin':'https://finance.yahoo.com','Referer':'https://finance.yahoo.com/',
};
const BROWSER = {
  'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language':'en-US,en;q=0.9','Cache-Control':'no-cache',
};

// ── Timeout helper ────────────────────────────────────────────────────────────
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

// ── Concurrent race: first non-null valid result wins ────────────────────────
async function raceValid(promises, validator = v => v != null) {
  return new Promise(resolve => {
    let pending = promises.length;
    if (!pending) { resolve(null); return; }
    promises.forEach(p =>
      Promise.resolve(p)
        .then(v => { if (validator(v)) resolve(v); else if (!--pending) resolve(null); })
        .catch(() => { if (!--pending) resolve(null); })
    );
  });
}

// ── Core fetch helpers ────────────────────────────────────────────────────────
async function fh(path, ms = 5000) {
  if (!FINNHUB_KEY) throw new Error('No FINNHUB_KEY');
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${FH}${path}${sep}token=${FINNHUB_KEY}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw new Error(`Finnhub ${r.status}`);
  const d = await r.json();
  if (d?.error) throw new Error(d.error);
  return d;
}

let _crumb = null, _cookies = '', _crumbTs = 0;
async function getYahooCrumb() {
  if (_crumb && Date.now() - _crumbTs < 300000) return { crumb: _crumb, cookies: _cookies };
  try {
    const home = await fetch('https://finance.yahoo.com/', {
      headers: { 'User-Agent': BROWSER['User-Agent'], 'Accept': 'text/html' },
      redirect: 'follow', signal: AbortSignal.timeout(6000),
    });
    const setCookie = home.headers.get('set-cookie') || '';
    _cookies = setCookie.split(',').map(c => c.split(';')[0].trim()).filter(c => c.includes('=')).join('; ');
    for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
      try {
        const cr = await fetch(`${base}/v1/test/getcrumb`, {
          headers: { 'User-Agent': BROWSER['User-Agent'], 'Accept': '*/*', 'Cookie': _cookies },
          signal: AbortSignal.timeout(5000),
        });
        if (cr.ok) {
          const text = await cr.text();
          if (text && text.length < 50 && !text.startsWith('{')) {
            _crumb = text.trim(); _crumbTs = Date.now();
            return { crumb: _crumb, cookies: _cookies };
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
  return { crumb: null, cookies: '' };
}

async function yahooFetch(path, crumbInfo, ms = 6000) {
  const { crumb, cookies } = crumbInfo || {};
  const qs = crumb ? `${path.includes('?') ? '&' : '?'}crumb=${encodeURIComponent(crumb)}` : '';
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`${base}${path}${qs}`, {
        headers: { ...API_HEADERS, ...(cookies ? { Cookie: cookies } : {}) },
        signal: AbortSignal.timeout(ms),
      });
      if (r.status === 401 || r.status === 429) continue;
      if (!r.ok) continue;
      return await r.json();
    } catch (_) {}
  }
  return null;
}

const _avCache = {};
async function fetchAV(ticker) {
  if (_avCache[ticker]) return _avCache[ticker];
  if (!AV_KEY) return null;
  try {
    const r = await fetch(`${AV}?function=OVERVIEW&symbol=${ticker}&apikey=${AV_KEY}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d?.Symbol || d?.Information || d?.Note) return null;
    _avCache[ticker] = d; return d;
  } catch (_) { return null; }
}

async function getPage(url, ms = 7000) {
  const r = await fetch(url, { headers: BROWSER, signal: AbortSignal.timeout(ms), redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// ── MA50 from raw closes array ────────────────────────────────────────────────
function compute50dMA(closes) {
  const v = (closes || []).filter(c => c != null && !isNaN(c) && c > 0);
  if (v.length < 20) return null;
  const sl = v.slice(-50);
  return sl.reduce((a, b) => a + b, 0) / sl.length;
}

// ── PE cap ────────────────────────────────────────────────────────────────────
const PE_MAX = 80;

// ── CIK cache for SEC ─────────────────────────────────────────────────────────
const _cikCache = {};
async function getSecCIK(ticker) {
  if (_cikCache[ticker]) return _cikCache[ticker];
  try {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': 'signal-engine/1.0 admin@example.com' },
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const j = await r.json();
      for (const e of Object.values(j)) {
        if (e.ticker?.toUpperCase() === ticker.toUpperCase()) {
          const cik = String(e.cik_str).padStart(10, '0');
          _cikCache[ticker] = cik; return cik;
        }
      }
    }
  } catch (_) {}
  return null;
}

// ── Formatting helpers ────────────────────────────────────────────────────────
function fmt$M(n) {
  if (!n || n === 0) return null;
  if (n >= 1e9) return `$${(n/1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
function fmtSh(n) {
  if (!n || n === 0) return null;
  if (n >= 1e6) return `${(n/1e6).toFixed(2)}M shares`;
  if (n >= 1e3) return `${(n/1e3).toFixed(1)}K shares`;
  return `${n.toLocaleString()} shares`;
}
function timeAgo(ds) {
  if (!ds) return null;
  const d = new Date(ds); if (isNaN(d)) return null;
  const days = Math.floor((Date.now() - d) / 86400000);
  return days === 0 ? 'today' : days === 1 ? '1d ago' : days < 7 ? `${days}d ago` : days < 14 ? '1w ago' : days < 30 ? `${Math.floor(days/7)}w ago` : `${Math.floor(days/30)}mo ago`;
}
function cleanExchange(raw) {
  if (!raw) return 'NYSE'; const u = raw.toUpperCase();
  if (u.includes('NASDAQ')) return 'NASDAQ'; if (u.includes('NYSE')) return 'NYSE';
  if (u.includes('LSE') || u.includes('LONDON')) return 'LSE';
  if (u.includes('TSX') || u.includes('TORONTO')) return 'TSX';
  return raw.split(/[\s,]/)[0].toUpperCase() || 'NYSE';
}
function getRating(s) {
  if (s >= 5) return { label:'Strong Buy', color:'#14532d', bg:'#dcfce7', border:'#86efac' };
  if (s === 4) return { label:'Buy', color:'#15803d', bg:'#f0fdf4', border:'#bbf7d0' };
  if (s === 3) return { label:'Watch', color:'#92400e', bg:'#fffbeb', border:'#fde68a' };
  return { label:'Ignore', color:'#6b7280', bg:'#f9fafb', border:'#d1d5db' };
}

// ─────────────────────────────────────────────────────────────────────────────
// PASS 1 — fast data only from Yahoo chart + Finnhub quote/profile/earnings
// Target: complete in <4s per ticker
// Resolves: s1 (EPS beat), s2 (PE vs hist), s3 (MA50)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchFast(ticker, crumbInfo) {
  const [quoteR, profileR, earningsR, yhChartR] = await Promise.allSettled([
    fh(`/quote?symbol=${ticker}`, 4000),
    fh(`/stock/profile2?symbol=${ticker}`, 4000),
    fh(`/stock/earnings?symbol=${ticker}&limit=4`, 4000),
    yahooFetch(`/v8/finance/chart/${ticker}?interval=1d&range=1y`, crumbInfo, 4000),
  ]);

  const quote   = quoteR.status   === 'fulfilled' ? quoteR.value   : null;
  const profile = profileR.status === 'fulfilled' ? profileR.value : null;
  const earnings= earningsR.status=== 'fulfilled' ? earningsR.value: null;
  const yhChart = yhChartR.status === 'fulfilled' ? yhChartR.value : null;

  const curPx = quote?.c;
  if (!curPx) return null;

  const yhMeta   = yhChart?.chart?.result?.[0]?.meta || {};
  const yhClose  = yhChart?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c => c != null && !isNaN(c) && c > 0) || [];

  // PE — from Yahoo chart meta first (fastest, no extra call)
  let curPE = yhMeta.trailingPE || null;
  if (!curPE || curPE <= 0 || curPE >= PE_MAX) curPE = null;

  // 52w hi/lo
  let hi52 = yhMeta.fiftyTwoWeekHigh || null;
  let lo52  = yhMeta.fiftyTwoWeekLow  || null;
  if (!hi52 && yhClose.length > 50) hi52 = Math.max(...yhClose);
  if (!lo52 && yhClose.length > 50) lo52  = Math.min(...yhClose);

  // MA50 — computed directly from chart closes (no extra call needed)
  const ma50 = compute50dMA(yhClose);

  // EPS — from Yahoo summary module (piggyback onto crumb we already have)
  let eps = null;
  try {
    const j = await withTimeout(yahooFetch(`/v10/finance/quoteSummary/${ticker}?modules=defaultKeyStatistics`, crumbInfo, 4000), 4000);
    const v = j?.quoteSummary?.result?.[0]?.defaultKeyStatistics?.trailingEps?.raw;
    if (v != null && v !== 0) eps = v;
  } catch (_) {}

  const mc = profile?.marketCapitalization ? profile.marketCapitalization * 1e6 : (yhMeta.marketCap || 0);
  const mcs = mc > 1e12 ? `$${(mc/1e12).toFixed(2)}T` : mc > 1e9 ? `$${(mc/1e9).toFixed(1)}B` : mc > 1e6 ? `$${(mc/1e6).toFixed(0)}M` : '';

  // ── Build signals 1–3 now; 4–6 left as neutral pending pass-2 ────────────
  let s1 = { status:'neutral', value:'No data' };
  try {
    const earns = Array.isArray(earnings) ? earnings : [];
    if (earns.length > 0) {
      const e = earns[0], diff = e.actual - e.estimate, beat = diff >= 0;
      const ds = Math.abs(diff) < 0.005 ? 'in-line' : beat ? `+$${Math.abs(diff).toFixed(2)}` : `-$${Math.abs(diff).toFixed(2)}`;
      s1 = { status: beat ? 'pass' : 'fail', value: beat ? `Beat by ${ds}` : `Missed ${ds}` };
    }
  } catch (_) {}

  let s2 = { status:'neutral', value:'No data' };
  try {
    if (curPE && eps && eps !== 0 && hi52 && lo52 && hi52 > lo52) {
      const histPE = (hi52 + lo52) / 2 / eps;
      if (histPE > 0 && histPE < 1000) {
        if (curPE < histPE * 0.92)      s2 = { status:'pass',    value:`PE ${curPE.toFixed(1)}x < hist ~${histPE.toFixed(0)}x` };
        else if (curPE > histPE * 1.08) s2 = { status:'fail',    value:`PE ${curPE.toFixed(1)}x > hist ~${histPE.toFixed(0)}x` };
        else                             s2 = { status:'neutral', value:`PE ${curPE.toFixed(1)}x ≈ hist ~${histPE.toFixed(0)}x` };
      }
    } else if (curPE) {
      s2 = { status:'neutral', value:`PE ${curPE.toFixed(1)}x` };
    }
  } catch (_) {}

  let s3 = { status:'neutral', value:'No data' };
  try {
    if (ma50 && ma50 > 0) {
      const pct = ((curPx - ma50) / ma50 * 100).toFixed(1);
      s3 = curPx <= ma50
        ? { status:'pass', value:`$${curPx.toFixed(2)} ≤ MA $${ma50.toFixed(2)} (${pct}%)` }
        : { status:'fail', value:`$${curPx.toFixed(2)} > MA $${ma50.toFixed(2)} (+${pct}%)` };
    }
  } catch (_) {}

  const signals = [s1, s2, s3,
    { status:'neutral', value:'Loading…' },  // s4 insider — pass 2
    { status:'neutral', value:'Loading…' },  // s5 analyst — pass 2
    { status:'neutral', value:'Loading…' },  // s6 peer PE — pass 2
  ];
  const score = signals.filter(s => s.status === 'pass').length;

  return {
    ticker,
    company:    profile?.name || ticker,
    exchange:   cleanExchange(profile?.exchange),
    price:      `$${curPx.toFixed(2)}`,
    change:     quote?.dp != null ? `${quote.dp > 0 ? '+' : ''}${quote.dp.toFixed(2)}%` : null,
    marketCap:  mcs,
    score,
    signals,
    summary:    '',
    rating:     getRating(score),
    updatedAt:  new Date().toISOString(),
    // carry forward for pass-2 use
    _curPE: curPE, _eps: eps, _hi52: hi52, _lo52: lo52, _mc: mc,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PASS 2 — slow sources: insider, analyst target, peer PE
// Budget: 8s total
// ─────────────────────────────────────────────────────────────────────────────

// ── Insider (4 parallel sources) ─────────────────────────────────────────────
const MAX_TX_VALUE  = 500e6;
const MAX_SINGLE_TX =  50e6;
const MAX_SINGLE_SH = 250_000;

async function _insiderFinnhub(ticker, from, to, cut30) {
  try {
    const d = await fh(`/stock/insider-transactions?symbol=${ticker}&from=${from}&to=${to}`, 6000);
    const seen = new Set();
    const txns = (d?.data||[]).filter(t => { const dt=new Date(t.transactionDate); return !isNaN(dt)&&dt>=cut30; });
    const unique = txns.filter(t => { const k=`${t.name}|${t.transactionDate}|${t.change}|${t.transactionCode}`; if(seen.has(k))return false;seen.add(k);return true; });
    const norm = t => { const tr=Math.abs(t.change||0); if(tr<=0||tr>MAX_SINGLE_SH)return null; const v=t.value||0; let nv=0; if(v>500&&v<=MAX_SINGLE_TX)nv=v; else if(v>0&&v<=500&&tr>0)nv=Math.min(v*tr,MAX_SINGLE_TX); return{...t,_sharesTraded:tr,_normValue:nv}; };
    const buys  = unique.filter(t=>t.transactionCode==='P').map(norm).filter(Boolean);
    const sells = unique.filter(t=>t.transactionCode==='S').map(norm).filter(Boolean);
    if (buys.length||sells.length) return{buys,sells,source:'finnhub'};
  } catch(_){}
  return null;
}

async function _insiderOpenInsider(ticker, cut30) {
  try {
    const r = await fetch(
      `https://openinsider.com/screener?s=${ticker}&fd=-30&td=0&xs=1&vl=0&grp=0&cnt=20&action=1`,
      { headers:{'User-Agent':'Mozilla/5.0'}, signal:AbortSignal.timeout(6000) }
    );
    if (!r.ok) return null;
    const html = await r.text();
    const theadM = html.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
    if (!theadM) return null;
    const OI_MAP = {'trade date':1,'qty':2,'value':3,'type':0,'filing date':0};
    const colMap = {};
    [...theadM[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].forEach((m,i)=>{
      const t=m[1].replace(/<[^>]+>/g,'').trim().toLowerCase();
      const canonical={'filing date':'filingDate','trade date':'tradeDate','qty':'qty','quantity':'qty','#shares':'qty','value':'value','trade type':'type','type':'type'}[t];
      if(canonical&&!(canonical in colMap)) colMap[canonical]=i;
    });
    if (!('qty' in colMap && 'value' in colMap && 'type' in colMap)) return null;
    const tbM = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
    if (!tbM) return null;
    const rows = [...tbM[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map(rm=>[...rm[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c=>c[1].replace(/<[^>]+>/g,'').trim()))
      .filter(c=>c.length>=8);
    const buys=[],sells=[],seen=new Set();
    for(const cells of rows){
      const typeRaw=cells[colMap.type]||''; const dateRaw=cells[colMap.tradeDate]||cells[colMap.filingDate]||'';
      if(!dateRaw||!typeRaw) continue;
      const txDate=new Date(dateRaw); if(isNaN(txDate)||txDate<cut30) continue;
      const shares=parseInt((cells[colMap.qty]||'0').replace(/[^0-9]/g,''),10)||0;
      if(shares<=0||shares>MAX_SINGLE_SH) continue;
      const value=parseInt((cells[colMap.value]||'0').replace(/[$,\s]/g,''),10)||0;
      if(value>MAX_SINGLE_TX) continue;
      const key=`${dateRaw}|${shares}|${typeRaw}`; if(seen.has(key)) continue; seen.add(key);
      const entry={transactionDate:dateRaw,_sharesTraded:shares,_normValue:value};
      if(/P\s*-\s*Purchase/i.test(typeRaw)||/^P$/i.test(typeRaw)) buys.push(entry);
      else if(/S\s*-\s*Sale/i.test(typeRaw)||/^S$/i.test(typeRaw)) sells.push(entry);
    }
    if(buys.length||sells.length) return{buys,sells,source:'openinsider'};
  } catch(_){}
  return null;
}

async function _insiderNasdaq(ticker, cut30) {
  try {
    const r = await fetch(
      `https://api.nasdaq.com/api/company/${ticker.toLowerCase()}/insider-trades?limit=40&type=ALL&sortColumn=lastDate&sortOrder=DESC`,
      { headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json','Origin':'https://www.nasdaq.com','Referer':'https://www.nasdaq.com/'}, signal:AbortSignal.timeout(6000) }
    );
    if (!r.ok) return null;
    const json=await r.json();
    const rows=json?.data?.insiderTrades?.rows||json?.data?.rows||json?.rows||[];
    const buys=[],sells=[],seen=new Set();
    for(const row of rows){
      const dateStr=row?.lastDate||row?.date||row?.transactionDate;
      const typeRaw=(row?.transactionType||row?.type||'').trim();
      if(!dateStr) continue;
      const txDate=new Date(dateStr); if(isNaN(txDate)||txDate<cut30) continue;
      const isPurchase=/^P$/i.test(typeRaw)||/purchase/i.test(typeRaw);
      const isSale=/^S$/i.test(typeRaw)||/sale/i.test(typeRaw);
      if(!isPurchase&&!isSale) continue;
      const shares=parseInt(String(row?.sharesTraded||row?.shares||'0').replace(/[^0-9]/g,''),10)||0;
      if(shares<=0||shares>MAX_SINGLE_SH) continue;
      const value=parseInt(String(row?.value||row?.transactionValue||'0').replace(/[$,\s]/g,''),10)||0;
      if(value>MAX_SINGLE_TX) continue;
      const key=`${dateStr}|${shares}|${typeRaw}`; if(seen.has(key)) continue; seen.add(key);
      const entry={transactionDate:dateStr,_sharesTraded:shares,_normValue:value};
      if(isPurchase) buys.push(entry); else sells.push(entry);
    }
    if(buys.length||sells.length) return{buys,sells,source:'nasdaq'};
  } catch(_){}
  return null;
}

async function _insiderEdgar(ticker, cut30) {
  try {
    const cik = await withTimeout(getSecCIK(ticker), 4000);
    if (!cik) return null;
    const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=4&dateb=&owner=include&count=20&search_text=`;
    const html = await withTimeout(
      fetch(url, { headers:{'User-Agent':'signal-engine/1.0 admin@example.com'}, signal:AbortSignal.timeout(5000) }).then(r=>r.ok?r.text():''),
      5000
    );
    if (!html) return null;
    const links = [...html.matchAll(/href="(\/Archives\/edgar\/data\/[^"]+\.xml)"/g)].map(m=>`https://www.sec.gov${m[1]}`).slice(0,4);
    const cutoffMs = cut30.getTime();
    const results = [];
    await Promise.allSettled(links.map(async link=>{
      try {
        const xml = await fetch(link,{headers:{'User-Agent':'signal-engine/1.0 admin@example.com'},signal:AbortSignal.timeout(4000)}).then(r=>r.ok?r.text():'');
        if(!xml) return;
        const dateM=xml.match(/<transactionDate>[^<]*<value>([^<]+)<\/value>/);
        if(!dateM) return;
        const txDate=new Date(dateM[1]);
        if(isNaN(txDate)||txDate.getTime()<cutoffMs) return;
        const codes=[...xml.matchAll(/<transactionCode>([^<]+)<\/transactionCode>/g)].map(m=>m[1].trim());
        const sharesArr=[...xml.matchAll(/<transactionShares>[^<]*<value>([\d.]+)<\/value>/g)].map(m=>parseFloat(m[1])||0);
        codes.forEach((code,i)=>{ const sh=sharesArr[i]||0; if((code==='P'||code==='S')&&sh>0) results.push({date:dateM[1],shares:sh,code,transactionDate:dateM[1]}); });
      } catch(_){}
    }));
    const buys=results.filter(t=>t.code==='P'&&t.shares>0&&t.shares<=MAX_SINGLE_SH).map(t=>({transactionDate:t.date,_sharesTraded:t.shares,_normValue:0}));
    const sells=results.filter(t=>t.code==='S'&&t.shares>0&&t.shares<=MAX_SINGLE_SH).map(t=>({transactionDate:t.date,_sharesTraded:t.shares,_normValue:0}));
    if(buys.length||sells.length) return{buys,sells,source:'edgar'};
  } catch(_){}
  return null;
}

function buildInsider(buys, sells, source) {
  if (buys.length > 0) {
    const sh=buys.reduce((s,t)=>s+(t._sharesTraded||0),0);
    const val=Math.min(buys.reduce((s,t)=>s+(t._normValue||0),0),MAX_TX_VALUE);
    const parts=[`${buys.length} buy${buys.length>1?'s':''}`];
    const sv=fmtSh(sh); if(sv) parts.push(sv);
    const dv=fmt$M(val); if(dv) parts.push(dv);
    const dates=buys.map(t=>t.transactionDate).filter(Boolean).sort().reverse();
    const rc=dates[0]?timeAgo(dates[0]):null; if(rc) parts.push(rc);
    return{status:'pass',value:parts.join(' · ')};
  }
  if (sells.length > 0) {
    const sh=sells.reduce((s,t)=>s+(t._sharesTraded||0),0);
    const val=Math.min(sells.reduce((s,t)=>s+(t._normValue||0),0),MAX_TX_VALUE);
    const parts=[`${sells.length} sell${sells.length>1?'s':''}, no buys`];
    const sv=fmtSh(sh); if(sv) parts.push(sv);
    const dv=fmt$M(val); if(dv) parts.push(dv);
    const dates=sells.map(t=>t.transactionDate).filter(Boolean).sort().reverse();
    const rc=dates[0]?timeAgo(dates[0]):null; if(rc) parts.push(rc);
    return{status:'fail',value:parts.join(' · ')};
  }
  return{status:'neutral',value:source?'No activity (30d)':'No data'};
}

async function resolveInsider(ticker) {
  const now=Math.floor(Date.now()/1000);
  const ago30=now-30*86400;
  const from=new Date(ago30*1000).toISOString().slice(0,10);
  const to=new Date(now*1000).toISOString().slice(0,10);
  const cut30=new Date(ago30*1000);
  const result = await raceValid([
    _insiderFinnhub(ticker,from,to,cut30),
    _insiderOpenInsider(ticker,cut30),
    _insiderNasdaq(ticker,cut30),
    _insiderEdgar(ticker,cut30),
  ], v => v!=null&&(v.buys.length>0||v.sells.length>0));
  return result || {buys:[],sells:[],source:null};
}

// ── Analyst target (concurrent fan-out) ───────────────────────────────────────
async function resolveTarget(ticker, crumbInfo) {
  return raceValid([
    fh(`/stock/price-target?symbol=${ticker}`,6000).then(d=>{const t=d?.targetMedian||d?.targetMean;return t>0?t:null;}).catch(()=>null),
    yahooFetch(`/v10/finance/quoteSummary/${ticker}?modules=financialData`,crumbInfo,6000)
      .then(j=>{const fd=j?.quoteSummary?.result?.[0]?.financialData;const t=fd?.targetMedianPrice?.raw||fd?.targetMeanPrice?.raw;return t>0?t:null;}).catch(()=>null),
    AV_KEY?fetchAV(ticker).then(d=>{const t=parseFloat(d?.AnalystTargetPrice);return(!isNaN(t)&&t>0)?t:null;}).catch(()=>null):Promise.resolve(null),
  ], v => v!=null&&v>0);
}

// ── Peer PE ───────────────────────────────────────────────────────────────────
const PEERS = {
  AAPL:['MSFT','GOOGL','META','AMZN','NVDA'],MSFT:['AAPL','GOOGL','CRM','ORCL','IBM'],
  GOOGL:['META','MSFT','AMZN','SNAP','TTD'],META:['GOOGL','SNAP','PINS','TTD'],
  AMZN:['MSFT','GOOGL','WMT','COST'],NVDA:['AMD','INTC','QCOM','AVGO','TXN'],
  TSLA:['GM','F','TM','RIVN'],AVGO:['QCOM','TXN','ADI','MRVL','AMD'],
  ORCL:['SAP','MSFT','CRM','IBM','WDAY'],AMD:['NVDA','INTC','QCOM','TXN','MU'],
  INTC:['AMD','NVDA','QCOM','TXN','AVGO'],QCOM:['AVGO','TXN','ADI','MRVL','AMD'],
  JPM:['BAC','WFC','C','GS','MS'],BAC:['JPM','WFC','C','USB','PNC'],
  WFC:['JPM','BAC','C','USB','PNC'],GS:['MS','JPM','C','BLK','SCHW'],
  MS:['GS','JPM','C','BLK','SCHW'],BLK:['SCHW','MS','GS','IVZ'],
  LLY:['NVO','PFE','MRK','ABBV','BMY'],JNJ:['PFE','ABBV','MRK','TMO','ABT'],
  UNH:['CVS','CI','HUM','ELV','CNC'],ABBV:['PFE','LLY','MRK','BMY','REGN'],
  MRK:['PFE','JNJ','ABBV','LLY','BMY'],PFE:['MRK','JNJ','ABBV','BMY','LLY'],
  TMO:['DHR','A','WAT','BIO','IDXX'],ABT:['MDT','BSX','SYK','BDX','EW'],
  AMGN:['REGN','BIIB','VRTX','BMY','GILD'],CVS:['WBA','CI','UNH','HUM','ELV'],
  XOM:['CVX','COP','SLB','EOG','OXY'],CVX:['XOM','COP','SLB','EOG','DVN'],
  COP:['EOG','XOM','CVX','DVN','OXY'],EOG:['COP','DVN','OXY','MRO','HES'],
  HD:['LOW','WMT','TGT','COST'],LOW:['HD','WMT','TGT','COST'],
  WMT:['TGT','COST','KR','HD'],TGT:['WMT','COST','HD','KR','DG'],
  COST:['WMT','TGT','HD'],MCD:['YUM','CMG','QSR','DRI'],
  NKE:['UAA','DECK','LULU','SKX'],SBUX:['MCD','CMG','YUM','QSR'],
  KO:['PEP','MDLZ','MNST','KHC'],PEP:['KO','MDLZ','MNST','KHC'],
  PM:['MO','BTI'],MO:['PM','BTI'],T:['VZ','TMUS','CMCSA','CHTR'],
  VZ:['T','TMUS','CMCSA','CHTR'],TMUS:['T','VZ','CMCSA'],
  CAT:['DE','HON','EMR','ITW','PH'],DE:['CAT','AGCO','HON'],
  HON:['CAT','EMR','ITW','ROK','ETN'],GE:['HON','RTX','EMR','ETN'],
  RTX:['LMT','NOC','GD','BA'],LMT:['NOC','RTX','GD','BA'],
  UPS:['FDX','XPO','ODFL'],FDX:['UPS','XPO','ODFL'],IBM:['MSFT','ORCL','HPE','ACN'],
  NEE:['DUK','SO','AEP','EXC','D'],AMT:['PLD','EQIX','CCI','SPG','O'],
  NFLX:['DIS','WBD','PARA','ROKU'],DIS:['NFLX','WBD','PARA','CMCSA'],
  MA:['V','PYPL','AXP','FIS'],V:['MA','PYPL','AXP','FIS'],SPGI:['MCO','ICE','CME','MSCI'],
};

async function getPeerPE(peer, crumbInfo) {
  const [yhR, fhR] = await Promise.allSettled([
    yahooFetch(`/v8/finance/chart/${peer}?interval=1d&range=5d`, crumbInfo, 4000).then(j=>{
      const pe=j?.chart?.result?.[0]?.meta?.trailingPE;
      const mc=j?.chart?.result?.[0]?.meta?.marketCap||0;
      return(pe>0&&pe<PE_MAX)?{pe,mc,src:'yahoo'}:null;
    }),
    fh(`/stock/metric?symbol=${peer}&metric=all`,4000).then(d=>{
      const pe=d?.metric?.peBasicExclExtraTTM||d?.metric?.peTTM;
      const mc=(d?.metric?.marketCapitalization||0)*1e6;
      return(pe>0&&pe<PE_MAX)?{pe,mc,src:'finnhub'}:null;
    }),
  ]);
  const candidates=[yhR,fhR].filter(r=>r.status==='fulfilled'&&r.value).map(r=>r.value);
  if(!candidates.length) return null;
  const pe=candidates.length>=2
    ? (()=>{const pes=candidates.map(c=>c.pe).sort((a,b)=>a-b);const spread=(pes[pes.length-1]-pes[0])/pes[0];return spread>0.4?pes[0]:pes[Math.floor(pes.length/2)];})()
    : candidates[0].pe;
  return{ticker:peer,pe,mc:candidates[0].mc};
}

async function resolvePeerPE(ticker, curPE, targetMC, crumbInfo) {
  try {
    let peerList=[];
    try{const pd=await fh(`/stock/peers?symbol=${ticker}`,4000);if(Array.isArray(pd))peerList=pd.filter(p=>p!==ticker&&/^[A-Z]{1,5}$/.test(p));}catch(_){}
    if(PEERS[ticker]) peerList=[...new Set([...peerList,...PEERS[ticker]])].filter(p=>p!==ticker);
    peerList=peerList.slice(0,8);
    if(!peerList.length) return null;
    const res=await Promise.allSettled(peerList.map(p=>getPeerPE(p,crumbInfo)));
    let comps=res.filter(r=>r.status==='fulfilled'&&r.value).map(r=>r.value);
    if(!comps.length) return null;
    if(comps.length>=5){const s=[...comps].sort((a,b)=>a.pe-b.pe);const tr=Math.max(1,Math.floor(s.length*0.2));comps=s.slice(tr,s.length-tr);}
    if(comps.length>=3){const sorted=[...comps].sort((a,b)=>a.pe-b.pe);const pm=sorted[Math.floor(sorted.length/2)].pe;comps=comps.filter(c=>c.pe<=pm*3&&c.pe>=pm*0.2);if(comps.length<2)return null;}
    if(comps.length<2) return null;
    const pes=comps.map(c=>c.pe).sort((a,b)=>a-b);
    const mid=Math.floor(pes.length/2);
    const med=pes.length%2===0?(pes[mid-1]+pes[mid])/2:pes[mid];
    const diff=curPE&&curPE>0?parseFloat(((curPE-med)/med*100).toFixed(1)):null;
    return{medianPE:parseFloat(med.toFixed(1)),peerCount:comps.length,diff,peers:comps.map(c=>c.ticker)};
  } catch(_){return null;}
}

async function enrichTicker(ticker, pass1Result, crumbInfo) {
  const curPE  = pass1Result?._curPE  || null;
  const targetMC = pass1Result?._mc   || 0;
  const curPx  = parseFloat((pass1Result?.price||'0').replace('$',''));

  const [insiderData, analystTarget, peerPE] = await Promise.all([
    resolveInsider(ticker),
    resolveTarget(ticker, crumbInfo),
    resolvePeerPE(ticker, curPE, targetMC / 1e6, crumbInfo),
  ]);

  const { buys, sells, source } = insiderData;
  const s4 = buildInsider(buys, sells, source);

  let s5 = { status:'neutral', value:'No data' };
  if (analystTarget && analystTarget > 0 && curPx > 0) {
    const up = ((analystTarget - curPx) / curPx * 100).toFixed(1);
    s5 = parseFloat(up) >= 25
      ? { status:'pass', value:`Target $${analystTarget.toFixed(2)}, +${up}% upside` }
      : { status:'fail', value:`Target $${analystTarget.toFixed(2)}, +${up}% upside` };
  }

  let s6 = { status:'neutral', value:'No data' };
  if (peerPE?.medianPE && peerPE?.diff !== null) {
    const absDiff = Math.abs(peerPE.diff);
    const label   = `median ${peerPE.medianPE}x`;
    if      (peerPE.diff < -8) s6 = { status:'pass',    value:`${absDiff.toFixed(0)}% below peer ${label}` };
    else if (peerPE.diff >  8) s6 = { status:'fail',    value:`${absDiff.toFixed(0)}% above peer ${label}` };
    else                        s6 = { status:'neutral', value:`In line with peers (${label})` };
  } else if (peerPE?.medianPE) {
    s6 = { status:'neutral', value:`Peer median ${peerPE.medianPE}x` };
  }

  return { s4, s5, s6 };
}

// ── Summary builder ───────────────────────────────────────────────────────────
function buildSummary(ticker, signals, score) {
  const NAMES = ['EPS beat','Low PE','Below 50d MA','Insider buying','Analyst upside','PE vs peers'];
  const passes = signals.map((s,i)=>s.status==='pass'?NAMES[i]:null).filter(Boolean);
  const fails  = signals.map((s,i)=>s.status==='fail'?NAMES[i]:null).filter(Boolean);
  if (score >= 5) return `Strong value candidate — ${score}/6 signals pass. Strengths: ${passes.join(', ')}.`;
  if (score === 4) return `Good signals (4/6). Passes: ${passes.join(', ')}.`;
  if (score === 3) return `Moderate signals (3/6). Passes: ${passes.join(', ')}.`;
  if (score > 0)  return `Weak signals (${score}/6). Fails: ${fails.join(', ')}.`;
  return `No signals pass. Fails: ${fails.join(', ')}.`;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error:'Method not allowed' });
  if (!FINNHUB_KEY) return res.status(500).json({ error:'FINNHUB_KEY not set' });

  const { tickers, pass } = req.body;
  if (!Array.isArray(tickers) || !tickers.length) return res.status(400).json({ error:'tickers array required' });

  const cleaned = tickers.slice(0, 20).map(t => t.toUpperCase().trim());
  Object.keys(_avCache).forEach(k => delete _avCache[k]);

  const crumbInfo = await getYahooCrumb();

  // ── PASS 1 — fast partial results ─────────────────────────────────────────
  if (pass === 1 || pass === undefined) {
    const results = {};
    await Promise.allSettled(cleaned.map(async ticker => {
      try {
        const r = await withTimeout(fetchFast(ticker, crumbInfo), 8000);
        results[ticker] = r || { ticker, error:'No quote data' };
      } catch (e) {
        results[ticker] = { ticker, error: e.message };
      }
    }));

    // If pass=1 only, return now (frontend will call pass=2 separately)
    if (pass === 1) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ results, pass:1, fetchedAt: new Date().toISOString() });
    }

    // pass=undefined means run both synchronously (custom scan / backward compat)
    // Fall through to enrich below
    const enriched = {};
    await Promise.allSettled(cleaned.map(async ticker => {
      const base = results[ticker];
      if (!base || base.error) { enriched[ticker] = base; return; }
      try {
        const { s4, s5, s6 } = await withTimeout(enrichTicker(ticker, base, crumbInfo), 8000);
        const signals = [...(base.signals || [])];
        signals[3] = s4; signals[4] = s5; signals[5] = s6;
        const score = signals.filter(s => s.status === 'pass').length;
        enriched[ticker] = { ...base, signals, score, summary: buildSummary(ticker, signals, score), rating: getRating(score), updatedAt: new Date().toISOString() };
      } catch (_) {
        enriched[ticker] = base;
      }
    }));

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    return res.status(200).json({ results: enriched, pass:'both', fetchedAt: new Date().toISOString() });
  }

  // ── PASS 2 — enrich with slow sources ─────────────────────────────────────
  // Frontend sends pass1Results alongside tickers so we can use _curPE/_mc etc.
  const { pass1Results = {} } = req.body;
  const results = {};
  await Promise.allSettled(cleaned.map(async ticker => {
    const base = pass1Results[ticker] || {};
    try {
      const { s4, s5, s6 } = await withTimeout(enrichTicker(ticker, base, crumbInfo), 8000);
      results[ticker] = { s4, s5, s6 };
    } catch (_) {
      results[ticker] = {
        s4: { status:'neutral', value:'No data' },
        s5: { status:'neutral', value:'No data' },
        s6: { status:'neutral', value:'No data' },
      };
    }
  }));

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ results, pass:2, fetchedAt: new Date().toISOString() });
}
