// pages/api/analyse.js  v7
//
// Changes from v6:
//  - Peer PE: stricter outlier trimming, PE cap lowered to 150, cross-source validation
//  - Peer PE display: shows % above/below peer avg (e.g. "34% < peer avg 34.3x")
//  - Insider: Nasdaq insider activity page added as primary source
//  - Insider: strict 30-day window, deduplication added across all sources
 
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const AV_KEY      = process.env.AV_KEY;
 
const FH  = 'https://finnhub.io/api/v1';
const AV  = 'https://www.alphavantage.co/query';
 
const BROWSER = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};
const API_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
};
 
async function fh(path) {
  if (!FINNHUB_KEY) throw new Error('No FINNHUB_KEY');
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${FH}${path}${sep}token=${FINNHUB_KEY}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Finnhub ${r.status}`);
  const d = await r.json();
  if (d?.error) throw new Error(d.error);
  return d;
}
 
async function getPage(url, timeoutMs = 9000) {
  const r = await fetch(url, { headers: BROWSER, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
 
// ── Yahoo crumb ───────────────────────────────────────────────────────────────
let _crumb = null, _cookies = '', _crumbTs = 0;
 
async function getYahooCrumb() {
  if (_crumb && Date.now() - _crumbTs < 300000) return { crumb: _crumb, cookies: _cookies };
  try {
    const home = await fetch('https://finance.yahoo.com/', {
      headers: { 'User-Agent': BROWSER['User-Agent'], 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow', signal: AbortSignal.timeout(8000),
    });
    const setCookie = home.headers.get('set-cookie') || '';
    _cookies = setCookie.split(',').map(c => c.split(';')[0].trim()).filter(c => c.includes('=')).join('; ');
    for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
      try {
        const cr = await fetch(`${base}/v1/test/getcrumb`, {
          headers: { 'User-Agent': BROWSER['User-Agent'], 'Accept': '*/*', 'Cookie': _cookies },
          signal: AbortSignal.timeout(6000),
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
 
async function yahooFetch(path, crumbInfo) {
  const { crumb, cookies } = crumbInfo || {};
  const qs = crumb ? `${path.includes('?') ? '&' : '?'}crumb=${encodeURIComponent(crumb)}` : '';
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`${base}${path}${qs}`, {
        headers: { ...API_HEADERS, ...(cookies ? { Cookie: cookies } : {}) },
        signal: AbortSignal.timeout(7000),
      });
      if (r.status === 401 || r.status === 429) continue;
      if (!r.ok) continue;
      return await r.json();
    } catch (_) {}
  }
  return null;
}
 
// ── Alpha Vantage ─────────────────────────────────────────────────────────────
const _avCache = {};
async function fetchAV(ticker) {
  if (_avCache[ticker]) return _avCache[ticker];
  if (!AV_KEY) return null;
  try {
    const r = await fetch(`${AV}?function=OVERVIEW&symbol=${ticker}&apikey=${AV_KEY}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d?.Symbol || d?.Information || d?.Note) return null;
    _avCache[ticker] = d;
    return d;
  } catch (_) { return null; }
}
 
// ── stockanalysis.com ─────────────────────────────────────────────────────────
const _saCache = {};
async function fetchStockAnalysis(ticker) {
  if (_saCache[ticker]) return _saCache[ticker];
  try {
    const html = await getPage(`https://stockanalysis.com/stocks/${ticker.toLowerCase()}/`);
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    const data = JSON.parse(m[1]);
    const props = data?.props?.pageProps;
    const quote = props?.data?.quote || props?.quote || null;
    if (quote) { _saCache[ticker] = quote; return quote; }
  } catch (_) {}
  try {
    const html = await getPage(`https://stockanalysis.com/stocks/${ticker.toLowerCase()}/financials/`);
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    const data = JSON.parse(m[1]);
    const fin  = data?.props?.pageProps?.data || null;
    if (fin) { _saCache[ticker] = fin; return fin; }
  } catch (_) {}
  return null;
}
 
function saExtract(sa, fields) {
  if (!sa) return null;
  for (const field of fields) {
    const parts = field.split('.');
    let val = sa;
    for (const p of parts) { val = val?.[p]; if (val === undefined) break; }
    if (val != null && val !== '' && !isNaN(parseFloat(val))) return parseFloat(val);
  }
  return null;
}
 
// ── MarketWatch ───────────────────────────────────────────────────────────────
const _mwCache = {};
async function fetchMarketWatch(ticker) {
  if (_mwCache[ticker]) return _mwCache[ticker];
  try {
    const html = await getPage(`https://www.marketwatch.com/investing/stock/${ticker.toLowerCase()}`);
    const m1 = html.match(/window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    if (m1) {
      try { const d = JSON.parse(m1[1]); _mwCache[ticker]={type:'state',data:d}; return _mwCache[ticker]; } catch (_) {}
    }
    _mwCache[ticker] = { type:'html', raw:html }; return _mwCache[ticker];
  } catch (_) { return null; }
}
function mwExtractPE(mw) {
  if (!mw) return null;
  if (mw.type==='state') {
    const d=mw.data;
    for (const v of [d?.instrumentData?.primaryData?.peRatio,d?.quote?.peRatio,d?.stock?.peRatio]) {
      if (v && !isNaN(parseFloat(v))) return parseFloat(v);
    }
  }
  if (mw.raw) {
    for (const p of [/"peRatio"\s*:\s*"?([\d.]+)"?/,/P\/E Ratio[^<]*<\/span>[^<]*<span[^>]*>([\d.]+)/,/class="[^"]*pe-ratio[^"]*"[^>]*>([\d.]+)/]) {
      const m=mw.raw.match(p); if (m) { const v=parseFloat(m[1]); if (v>0&&v<150) return v; }
    }
  }
  return null;
}
function mwExtractEPS(mw) {
  if (!mw?.raw) return null;
  for (const p of [/"epsTrailingTwelveMonths"\s*:\s*([-\d.]+)/,/EPS \(TTM\)[^<]*<\/[^>]+>[^<]*<[^>]+>([-\d.]+)/,/"eps"\s*:\s*([-\d.]+)/]) {
    const m=mw.raw.match(p); if (m) { const v=parseFloat(m[1]); if (v!==0&&!isNaN(v)) return v; }
  }
  return null;
}
 
// ── Zacks ─────────────────────────────────────────────────────────────────────
async function fetchZacks(ticker) {
  try { return await getPage(`https://www.zacks.com/stock/quote/${ticker.toUpperCase()}`); } catch (_) { return null; }
}
function zacksExtractPE(html) {
  if (!html) return null;
  for (const p of [/P\/E Ratio[^<]*<\/dt>[^<]*<dd[^>]*>([\d.]+)/,/"peRatio"\s*:\s*([\d.]+)/,/class="[^"]*pe_ratio[^"]*"[^>]*>([\d.]+)/,/P\/E\s*<[^>]+>\s*([\d.]+)/]) {
    const m=html.match(p); if (m) { const v=parseFloat(m[1]); if (v>0&&v<150) return v; }
  }
  return null;
}
function zacksExtractTarget(html) {
  if (!html) return null;
  for (const p of [/Price Target[^<]*<[^>]+>\s*\$([\d.]+)/i,/Zacks Mean Target[^<]*<[^>]+>\s*\$([\d.]+)/i,/"targetPrice"\s*:\s*([\d.]+)/,/consensus.*?target.*?\$([\d,]+\.?\d*)/i]) {
    const m=html.match(p); if (m) { const v=parseFloat(m[1].replace(/,/g,'')); if (v>0) return v; }
  }
  return null;
}
 
// ── Macrotrends ───────────────────────────────────────────────────────────────
async function fetchMacrotrendsEPS(ticker) {
  try {
    const html = await getPage(`https://www.macrotrends.net/stocks/charts/${ticker.toUpperCase()}/x/eps-earnings-per-share-diluted`, 10000);
    const m = html.match(/var\s+chartData\s*=\s*(\[[\s\S]*?\]);/);
    if (m) { const arr=JSON.parse(m[1]); const r=arr.filter(a=>a?.[1]!=null&&!isNaN(parseFloat(a[1]))).slice(0,4); if (r.length>0) return parseFloat(r[0][1]); }
  } catch (_) {}
  return null;
}
 
// ── SEC EDGAR ─────────────────────────────────────────────────────────────────
const _cikCache = {};
async function getSecCIK(ticker) {
  if (_cikCache[ticker]) return _cikCache[ticker];
  try {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers:{'User-Agent':'signal-engine/1.0 admin@example.com'}, signal:AbortSignal.timeout(8000) });
    if (r.ok) { const j=await r.json(); for (const e of Object.values(j)) { if (e.ticker?.toUpperCase()===ticker.toUpperCase()) { const cik=String(e.cik_str).padStart(10,'0'); _cikCache[ticker]=cik; return cik; } } }
  } catch (_) {}
  return null;
}
async function fetchSecEPS(ticker) {
  try {
    const cik = await getSecCIK(ticker); if (!cik) return null;
    const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers:{'User-Agent':'signal-engine/1.0 admin@example.com'}, signal:AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const d=await r.json(); const facts=d?.facts?.['us-gaap'];
    for (const key of ['EarningsPerShareBasic','EarningsPerShareDiluted','EarningsPerShareBasicAndDiluted']) {
      const units=facts?.[key]?.units?.['USD/shares']||[];
      const annual=units.filter(e=>e.form==='10-K').sort((a,b)=>new Date(b.end)-new Date(a.end));
      if (annual.length>0&&annual[0].val!=null) return annual[0].val;
      const qtrs=units.filter(e=>e.form==='10-Q').sort((a,b)=>new Date(b.end)-new Date(a.end)).slice(0,4);
      if (qtrs.length===4) { const ttm=qtrs.reduce((s,q)=>s+(q.val||0),0); if (ttm!==0) return ttm; }
    }
  } catch (_) {}
  return null;
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Format helpers
// ─────────────────────────────────────────────────────────────────────────────
function fmt$M(n) { return !n||n===0?null:n>=1e9?`$${(n/1e9).toFixed(2)}B`:n>=1e6?`$${(n/1e6).toFixed(2)}M`:n>=1e3?`$${(n/1e3).toFixed(0)}K`:`$${n.toFixed(0)}`; }
function fmtSh(n) { return !n||n===0?null:n>=1e6?`${(n/1e6).toFixed(2)}M shares`:n>=1e3?`${(n/1e3).toFixed(1)}K shares`:`${n.toLocaleString()} shares`; }
function timeAgo(ds) {
  if (!ds) return null; const d=new Date(ds); if (isNaN(d)) return null;
  const days=Math.floor((Date.now()-d)/86400000);
  return days===0?'today':days===1?'1d ago':days<7?`${days}d ago`:days<14?'1w ago':days<30?`${Math.floor(days/7)}w ago`:`${Math.floor(days/30)}mo ago`;
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Signal resolvers
// ─────────────────────────────────────────────────────────────────────────────
function compute50dMA(closes) {
  if (!Array.isArray(closes)) return null;
  const v=closes.filter(c=>c!=null&&!isNaN(c)&&c>0);
  if (v.length<20) return null;
  const sl=v.slice(-50);
  return sl.reduce((a,b)=>a+b,0)/sl.length;
}
 
async function resolveMA50(ticker, avData, crumbInfo, yahooChartData) {
  const av=parseFloat(avData?.['50DayMovingAverage']); if (av>0&&!isNaN(av)) return av;
  const yhCloses=yahooChartData?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c=>c!=null&&!isNaN(c)&&c>0)||[];
  const yhMA=compute50dMA(yhCloses); if (yhMA>0) return yhMA;
  try { const to=Math.floor(Date.now()/1000),from=to-90*86400,d=await fh(`/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${to}`); if (d?.s==='ok'&&Array.isArray(d.c)&&d.c.length>=20){const ma=compute50dMA(d.c);if(ma>0)return ma;} } catch(_){}
  try { const j=await yahooFetch(`/v10/finance/quoteSummary/${ticker}?modules=summaryDetail`,crumbInfo); const ma=j?.quoteSummary?.result?.[0]?.summaryDetail?.fiftyDayAverage?.raw; if(ma>0)return ma; } catch(_){}
  try { const j=await yahooFetch(`/v8/finance/chart/${ticker}?interval=1d&range=3mo`,crumbInfo); const closes=j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c=>c!=null&&!isNaN(c)&&c>0)||[]; const ma=compute50dMA(closes); if(ma>0)return ma; } catch(_){}
  try { const sa=await fetchStockAnalysis(ticker); const ma=saExtract(sa,['ma50','movingAverage50','fiftyDayAverage','avg50']); if(ma>0)return ma; } catch(_){}
  try {
    const r=await fetch(`https://stooq.com/q/d/l/?s=${ticker.toLowerCase()}.us&i=d`,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(8000)});
    if(r.ok){const text=await r.text();if(text.length>100&&!text.toLowerCase().includes('no data')){const lines=text.trim().split('\n').slice(1);const closes=lines.slice(-60).map(l=>parseFloat((l.split(',')[4]||'').trim())).filter(c=>!isNaN(c)&&c>0);const ma=compute50dMA(closes);if(ma>0)return ma;}}
  } catch(_){}
  return null;
}
 
async function resolveEPS(ticker, avData, fhMetric, crumbInfo) {
  const avEPS=parseFloat(avData?.EPS); if(!isNaN(avEPS)&&avEPS!==0) return avEPS;
  const fhEPS=fhMetric?.epsTTM||fhMetric?.epsBasicExclExtraAnnual; if(fhEPS&&fhEPS!==0) return fhEPS;
  try { const j=await yahooFetch(`/v10/finance/quoteSummary/${ticker}?modules=defaultKeyStatistics`,crumbInfo); const eps=j?.quoteSummary?.result?.[0]?.defaultKeyStatistics?.trailingEps?.raw; if(eps!=null&&eps!==0)return eps; } catch(_){}
  try { const j=await yahooFetch(`/v10/finance/quoteSummary/${ticker}?modules=earningsHistory`,crumbInfo); const h=j?.quoteSummary?.result?.[0]?.earningsHistory?.history||[]; if(h.length>=2){const ttm=h.slice(-4).reduce((s,q)=>s+(q?.epsActual?.raw||0),0);if(ttm!==0)return ttm;} } catch(_){}
  try { const sa=await fetchStockAnalysis(ticker); const eps=saExtract(sa,['eps','epsTrailingTwelveMonths','epsTTM','earningsPerShare','netEPS','annualEPS']); if(eps!=null&&eps!==0)return eps; } catch(_){}
  try { const mw=await fetchMarketWatch(ticker); const eps=mwExtractEPS(mw); if(eps!=null&&eps!==0)return eps; } catch(_){}
  try { const eps=await fetchMacrotrendsEPS(ticker); if(eps!=null&&eps!==0)return eps; } catch(_){}
  try { const eps=await fetchSecEPS(ticker); if(eps!=null&&eps!==0)return eps; } catch(_){}
  try { const html=await fetchZacks(ticker); if(html){const m=html.match(/EPS\s*\(TTM\)[^<]*<[^>]+>\s*\$?\s*([-\d.]+)/i)||html.match(/"epsTrailingTwelveMonths"\s*:\s*([-\d.]+)/);if(m){const v=parseFloat(m[1]);if(v!==0&&!isNaN(v))return v;}} } catch(_){}
  return null;
}
 
async function resolvePE(ticker, avData, fhMetric, crumbInfo, yahooChartData) {
  const avPE=parseFloat(avData?.PERatio); if(!isNaN(avPE)&&avPE>0&&avPE<150) return avPE;
  const fhPE=fhMetric?.peBasicExclExtraTTM||fhMetric?.peTTM; if(fhPE>0&&fhPE<150) return fhPE;
  const yhPE=yahooChartData?.chart?.result?.[0]?.meta?.trailingPE; if(yhPE>0&&yhPE<150) return yhPE;
  try { const j=await yahooFetch(`/v10/finance/quoteSummary/${ticker}?modules=summaryDetail`,crumbInfo); const pe=j?.quoteSummary?.result?.[0]?.summaryDetail?.trailingPE?.raw; if(pe>0&&pe<150)return pe; } catch(_){}
  try { const sa=await fetchStockAnalysis(ticker); const pe=saExtract(sa,['pe','peRatio','priceEarnings','trailingPE','forwardPE']); if(pe>0&&pe<150)return pe; } catch(_){}
  try { const mw=await fetchMarketWatch(ticker); const pe=mwExtractPE(mw); if(pe>0&&pe<150)return pe; } catch(_){}
  try { const html=await fetchZacks(ticker); const pe=zacksExtractPE(html); if(pe>0&&pe<150)return pe; } catch(_){}
  return null;
}
 
async function resolveTarget(ticker, avData, crumbInfo) {
  const avT=parseFloat(avData?.AnalystTargetPrice); if(!isNaN(avT)&&avT>0) return avT;
  try { const d=await fh(`/stock/price-target?symbol=${ticker}`); const t=d?.targetMedian||d?.targetMean; if(t>0)return t; } catch(_){}
  try { const j=await yahooFetch(`/v10/finance/quoteSummary/${ticker}?modules=financialData`,crumbInfo); const fd=j?.quoteSummary?.result?.[0]?.financialData; const t=fd?.targetMedianPrice?.raw||fd?.targetMeanPrice?.raw; if(t>0)return t; } catch(_){}
  try {
    const html=await getPage(`https://stockanalysis.com/stocks/${ticker.toLowerCase()}/forecast/`);
    const m=html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if(m){const d=JSON.parse(m[1]);const ppts=d?.props?.pageProps;const t=ppts?.data?.priceTarget||ppts?.priceTarget||saExtract(ppts,['data.priceTarget','data.targetPrice','data.analystTarget','priceTarget']);if(t>0)return t;}
    for (const p of [/price\s+target[^$<]*\$\s*([\d,]+\.?\d*)/i,/consensus[^$<]*\$\s*([\d,]+\.?\d*)/i,/target\s+price[^$<]*\$\s*([\d,]+\.?\d*)/i]) {
      const match=html.match(p); if(match){const v=parseFloat(match[1].replace(/,/g,''));if(v>0&&v<100000)return v;}
    }
  } catch(_){}
  try { const html=await fetchZacks(ticker); const t=zacksExtractTarget(html); if(t>0)return t; } catch(_){}
  try {
    const html=await getPage(`https://www.marketwatch.com/investing/stock/${ticker.toLowerCase()}/analystestimates`);
    for (const p of [/target\s*price[^$<]*\$\s*([\d,]+\.?\d*)/i,/mean\s*target[^$<]*\$\s*([\d,]+\.?\d*)/i]) {
      const m=html.match(p); if(m){const v=parseFloat(m[1].replace(/,/g,''));if(v>0)return v;}
    }
  } catch(_){}
  return null;
}
 
function resolve52w(avData, fhMetric, yahooChartMeta, yahooChartCloses) {
  let hi=fhMetric?.['52WeekHigh']||parseFloat(avData?.['52WeekHigh'])||yahooChartMeta?.fiftyTwoWeekHigh||null;
  let lo=fhMetric?.['52WeekLow'] ||parseFloat(avData?.['52WeekLow']) ||yahooChartMeta?.fiftyTwoWeekLow ||null;
  if(isNaN(hi))hi=null; if(isNaN(lo))lo=null;
  if((!hi||!lo)&&yahooChartCloses.length>50){if(!hi)hi=Math.max(...yahooChartCloses);if(!lo)lo=Math.min(...yahooChartCloses);}
  return {hi52:hi,lo52:lo};
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Insider transactions
//
// Source priority (server-side reliability):
//   1. Finnhub  — authenticated API, always works server-side
//   2. OpenInsider — public HTML scraper, reliable fallback
//   3. Nasdaq API — last resort (sometimes blocks server IPs)
//
// All sources: 30-day window, dedup by date+shares+type, $500M per-tx cap,
// open-market Purchase (P) and Sale (S) only.
// ─────────────────────────────────────────────────────────────────────────────
 
const MAX_TX_VALUE = 500e6;
 
async function resolveInsider(ticker) {
  const now   = Math.floor(Date.now() / 1000);
  const ago30 = now - 30 * 86400;
  const from  = new Date(ago30 * 1000).toISOString().slice(0, 10);
  const to    = new Date(now   * 1000).toISOString().slice(0, 10);
  const cut30 = new Date(ago30 * 1000);
 
  // ── 1. Finnhub ─────────────────────────────────────────────────────────────
  try {
    const d = await fh(`/stock/insider-transactions?symbol=${ticker}&from=${from}&to=${to}`);
    const txns = (d?.data || []).filter(t => {
      const dt = new Date(t.transactionDate);
      return !isNaN(dt) && dt >= cut30;
    });
    const seen = new Set();
    const unique = txns.filter(t => {
      const key = `${t.name}|${t.transactionDate}|${t.share}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const buys  = unique.filter(t => t.transactionCode === 'P' && (t.value || 0) <= MAX_TX_VALUE);
    const sells = unique.filter(t => t.transactionCode === 'S' && (t.value || 0) <= MAX_TX_VALUE);
    if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'finnhub' };
  } catch (_) {}
 
  // ── 2. OpenInsider ─────────────────────────────────────────────────────────
  try {
    const r = await fetch(
      `https://openinsider.com/screener?s=${ticker}&fd=-30&td=0&xs=1&vl=0&grp=0&cnt=20&action=1`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
    );
    if (r.ok) {
      const html = await r.text();
      const rows = [...html.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/gi)];
      const buys = [], sells = [], seen = new Set();
      for (const row of rows) {
        const cells = [...row[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
          .map(c => c[1].replace(/<[^>]+>/g, '').trim());
        if (cells.length < 10) continue;
        const [, dateStr, , , type, , , , sharesRaw, valueRaw] = cells;
        if (!dateStr || !type) continue;
        const txDate = new Date(dateStr);
        if (isNaN(txDate) || txDate < cut30) continue;
        const shares = parseInt((sharesRaw || '').replace(/[^0-9]/g, '')) || 0;
        const value  = parseInt((valueRaw  || '').replace(/[^0-9]/g, '')) || 0;
        if (value > MAX_TX_VALUE) continue;
        const key = `${dateStr}|${shares}|${type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = { transactionDate: dateStr, share: shares, value, transactionPrice: shares > 0 ? value / shares : 0 };
        if (/P\s*-\s*Purchase/i.test(type)) buys.push(entry);
        else if (/S\s*-\s*Sale/i.test(type)) sells.push(entry);
      }
      if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'openinsider' };
    }
  } catch (_) {}
 
  // ── 3. Nasdaq JSON API (last resort — may be blocked from Vercel IPs) ──────
  try {
    const url = `https://api.nasdaq.com/api/company/${ticker.toLowerCase()}/insider-trades?limit=40&type=ALL&sortColumn=lastDate&sortOrder=DESC`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://www.nasdaq.com',
        'Referer': 'https://www.nasdaq.com/',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) {
      const json = await r.json();
      const rows = json?.data?.insiderTrades?.rows || json?.data?.rows || json?.rows || [];
      const buys = [], sells = [], seen = new Set();
      for (const row of rows) {
        const dateStr   = row?.lastDate || row?.date || row?.transactionDate;
        const typeRaw   = (row?.transactionType || row?.type || '').trim();
        const sharesRaw = String(row?.shares || row?.sharesTraded || '0');
        const valueRaw  = String(row?.value  || row?.transactionValue || '0');
        if (!dateStr) continue;
        const txDate = new Date(dateStr);
        if (isNaN(txDate) || txDate < cut30) continue;
        const isPurchase = /^P$/i.test(typeRaw) || /purchase/i.test(typeRaw);
        const isSale     = /^S$/i.test(typeRaw) || /sale/i.test(typeRaw);
        if (!isPurchase && !isSale) continue;
        const shares = parseInt(sharesRaw.replace(/[^0-9]/g, '')) || 0;
        const value  = parseInt(valueRaw.replace(/[^0-9]/g, ''))  || 0;
        if (value > MAX_TX_VALUE) continue;
        const key = `${dateStr}|${shares}|${typeRaw}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = { transactionDate: dateStr, share: shares, value, transactionPrice: shares > 0 && value > 0 ? value / shares : 0 };
        if (isPurchase) buys.push(entry);
        else            sells.push(entry);
      }
      if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'nasdaq' };
    }
  } catch (_) {}
 
  return { buys: [], sells: [], source: null };
}
function buildInsider(buys, sells, source) {
  if (buys.length > 0) {
    const sh = buys.reduce((s, t) => s + (t.share || 0), 0);
    // Use t.value when present (it is already total dollars for that transaction).
    // Fall back to shares × price ONLY when value is absent AND price < $10,000
    // (i.e. it looks like a per-share price, not a total).
    const val = buys.reduce((s, t) => {
      if (t.value && t.value > 0) return s + t.value;
      const px = t.transactionPrice || 0;
      if (px > 0 && px < 10000 && (t.share || 0) > 0) return s + px * t.share;
      return s;
    }, 0);
    const parts = [`${buys.length} buy${buys.length > 1 ? 's' : ''}`];
    const sv = fmtSh(sh);  if (sv) parts.push(sv);
    const dv = fmt$M(val); if (dv) parts.push(dv);
    const dates = buys.map(t => t.transactionDate).filter(Boolean).sort().reverse();
    const rc = dates[0] ? timeAgo(dates[0]) : null; if (rc) parts.push(rc);
    return { status: 'pass', value: parts.join(' · ') };
  }
  if (sells.length > 0) {
    const sh = sells.reduce((s, t) => s + (t.share || 0), 0);
    const val = sells.reduce((s, t) => {
      if (t.value && t.value > 0) return s + t.value;
      const px = t.transactionPrice || 0;
      if (px > 0 && px < 10000 && (t.share || 0) > 0) return s + px * t.share;
      return s;
    }, 0);
    const parts = [`${sells.length} sell${sells.length > 1 ? 's' : ''}, no buys`];
    const sv = fmtSh(sh);  if (sv) parts.push(sv);
    const dv = fmt$M(val); if (dv) parts.push(dv);
    const dates = sells.map(t => t.transactionDate).filter(Boolean).sort().reverse();
    const rc = dates[0] ? timeAgo(dates[0]) : null; if (rc) parts.push(rc);
    return { status: 'fail', value: parts.join(' · ') };
  }
  return { status: 'neutral', value: source ? 'No activity (30d)' : 'No data' };
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Peer PE — cross-validated sources, aggressive outlier trimming, PE cap 150
// ─────────────────────────────────────────────────────────────────────────────
const PEERS = {
  AAPL:['MSFT','GOOGL','META','AMZN','NVDA'],  MSFT:['AAPL','GOOGL','CRM','ORCL','IBM'],
  GOOGL:['META','MSFT','AMZN','SNAP','TTD'],    META:['GOOGL','SNAP','PINS','TTD'],
  AMZN:['MSFT','GOOGL','WMT','COST'],           NVDA:['AMD','INTC','QCOM','AVGO','TXN'],
  TSLA:['GM','F','TM','RIVN'],                  AVGO:['QCOM','TXN','ADI','MRVL','AMD'],
  ORCL:['SAP','MSFT','CRM','IBM','WDAY'],       AMD:['NVDA','INTC','QCOM','TXN','MU'],
  INTC:['AMD','NVDA','QCOM','TXN','AVGO'],      QCOM:['AVGO','TXN','ADI','MRVL','AMD'],
  JPM:['BAC','WFC','C','GS','MS'],              BAC:['JPM','WFC','C','USB','PNC'],
  WFC:['JPM','BAC','C','USB','PNC'],            GS:['MS','JPM','C','BLK','SCHW'],
  MS:['GS','JPM','C','BLK','SCHW'],             BLK:['SCHW','MS','GS','IVZ'],
  LLY:['NVO','PFE','MRK','ABBV','BMY'],         JNJ:['PFE','ABBV','MRK','TMO','ABT'],
  UNH:['CVS','CI','HUM','ELV','CNC'],           ABBV:['PFE','LLY','MRK','BMY','REGN'],
  MRK:['PFE','JNJ','ABBV','LLY','BMY'],         PFE:['MRK','JNJ','ABBV','BMY','LLY'],
  TMO:['DHR','A','WAT','BIO','IDXX'],           ABT:['MDT','BSX','SYK','BDX','EW'],
  AMGN:['REGN','BIIB','VRTX','BMY','GILD'],     CVS:['WBA','CI','UNH','HUM','ELV'],
  XOM:['CVX','COP','SLB','EOG','OXY'],          CVX:['XOM','COP','SLB','EOG','DVN'],
  COP:['EOG','XOM','CVX','DVN','OXY'],          EOG:['COP','DVN','OXY','MRO','HES'],
  HD:['LOW','WMT','TGT','COST'],                LOW:['HD','WMT','TGT','COST'],
  WMT:['TGT','COST','KR','HD'],                 TGT:['WMT','COST','HD','KR','DG'],
  COST:['WMT','TGT','HD'],                      MCD:['YUM','CMG','QSR','DRI'],
  NKE:['UAA','DECK','LULU','SKX'],              SBUX:['MCD','CMG','YUM','QSR'],
  KO:['PEP','MDLZ','MNST','KHC'],              PEP:['KO','MDLZ','MNST','KHC'],
  PM:['MO','BTI'],                               MO:['PM','BTI'],
  T:['VZ','TMUS','CMCSA','CHTR'],               VZ:['T','TMUS','CMCSA','CHTR'],
  TMUS:['T','VZ','CMCSA'],                      CAT:['DE','HON','EMR','ITW','PH'],
  DE:['CAT','AGCO','HON'],                       HON:['CAT','EMR','ITW','ROK','ETN'],
  GE:['HON','RTX','EMR','ETN'],                 RTX:['LMT','NOC','GD','BA'],
  LMT:['NOC','RTX','GD','BA'],                  UPS:['FDX','XPO','ODFL'],
  FDX:['UPS','XPO','ODFL'],                      IBM:['MSFT','ORCL','HPE','ACN'],
  NEE:['DUK','SO','AEP','EXC','D'],             AMT:['PLD','EQIX','CCI','SPG','O'],
  NFLX:['DIS','WBD','PARA','ROKU'],             DIS:['NFLX','WBD','PARA','CMCSA'],
  MA:['V','PYPL','AXP','FIS'],                  V:['MA','PYPL','AXP','FIS'],
  SPGI:['MCO','ICE','CME','MSCI'],
};
 
const _pePeerCache = {};
 
async function getPeerPE(peer, crumbInfo) {
  if (_pePeerCache[peer]) return _pePeerCache[peer];
  const candidates = [];
 
  // Source 1: Yahoo chart meta
  try {
    const j=await yahooFetch(`/v8/finance/chart/${peer}?interval=1d&range=5d`,crumbInfo);
    const pe=j?.chart?.result?.[0]?.meta?.trailingPE, mc=j?.chart?.result?.[0]?.meta?.marketCap||0;
    if (pe>0&&pe<150) candidates.push({pe,mc,src:'yahoo'});
  } catch(_){}
 
  // Source 2: Finnhub metric
  try {
    const d=await fh(`/stock/metric?symbol=${peer}&metric=all`);
    const pe=d?.metric?.peBasicExclExtraTTM||d?.metric?.peTTM, mc=(d?.metric?.marketCapitalization||0)*1e6;
    if (pe>0&&pe<150) candidates.push({pe,mc,src:'finnhub'});
  } catch(_){}
 
  // Source 3: Alpha Vantage (only if needed)
  if (AV_KEY&&candidates.length<2) {
    try {
      const d=await fetchAV(peer);
      const pe=parseFloat(d?.PERatio), mc=parseFloat(d?.MarketCapitalization)||0;
      if (!isNaN(pe)&&pe>0&&pe<150) candidates.push({pe,mc,src:'av'});
    } catch(_){}
  }
 
  // Source 4: stockanalysis (last resort)
  if (candidates.length<2) {
    try {
      const sa=await fetchStockAnalysis(peer);
      const pe=saExtract(sa,['pe','peRatio','trailingPE']), mc=saExtract(sa,['marketCap','marketCapitalization'])||0;
      if (pe>0&&pe<150) candidates.push({pe,mc,src:'sa'});
    } catch(_){}
  }
 
  if (!candidates.length) return null;
 
  // Cross-validate: if 2+ sources agree within 40%, use median; otherwise take lower
  let pe, mc;
  if (candidates.length>=2) {
    const pes=candidates.map(c=>c.pe).sort((a,b)=>a-b);
    const spread=(pes[pes.length-1]-pes[0])/pes[0];
    pe = spread>0.4 ? pes[0] : pes[Math.floor(pes.length/2)];
    mc = candidates[0].mc;
  } else {
    pe = candidates[0].pe;
    mc = candidates[0].mc;
  }
 
  _pePeerCache[peer] = {ticker:peer, pe, mc};
  return _pePeerCache[peer];
}
 
async function resolvePeerPE(ticker, curPE, targetMC, crumbInfo) {
  try {
    let peerList=[];
    try { const pd=await fh(`/stock/peers?symbol=${ticker}`); if(Array.isArray(pd))peerList=pd.filter(p=>p!==ticker&&/^[A-Z]{1,5}$/.test(p)); } catch(_){}
    if (PEERS[ticker]) peerList=[...new Set([...peerList,...PEERS[ticker]])].filter(p=>p!==ticker);
    peerList=peerList.slice(0,10);
    if (!peerList.length) return null;
 
    // Fetch all peers in parallel — no more 2-at-a-time batching
    const res = await Promise.allSettled(peerList.map(p => getPeerPE(p, crumbInfo)));
    const all = res.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    if (!all.length) return null;
 
    // Market-cap tier filter
    let comps=all;
    if (targetMC>0&&all.filter(c=>c.mc>0).length>=2) {
      const lo=targetMC>500000?0.07:0.12, hi=targetMC>500000?14:8;
      const f=all.filter(c=>c.mc===0||(c.mc/1e6/targetMC>=lo&&c.mc/1e6/targetMC<=hi));
      if (f.length>=2) comps=f;
    }
 
    // Aggressive outlier removal
    if (comps.length>=5) {
      const s=[...comps].sort((a,b)=>a.pe-b.pe);
      const trim=Math.max(1,Math.floor(s.length*0.2)); // remove top+bottom 20%
      comps=s.slice(trim,s.length-trim);
    } else if (comps.length>=3) {
      // Drop any peer PE more than 2.5x the median
      const s=[...comps].sort((a,b)=>a.pe-b.pe);
      const median=s[Math.floor(s.length/2)].pe;
      comps=s.filter(c=>c.pe<=median*2.5);
    }
 
    if (comps.length<2) return null;
 
    const pes=comps.map(c=>c.pe).sort((a,b)=>a-b);
    const mid=Math.floor(pes.length/2);
    const med=pes.length%2===0?(pes[mid-1]+pes[mid])/2:pes[mid];
    const avg=pes.reduce((a,b)=>a+b,0)/pes.length;
    const diff=curPE&&curPE>0?parseFloat(((curPE-avg)/avg*100).toFixed(1)):null;
 
    return {
      medianPE: parseFloat(med.toFixed(1)),
      avgPE:    parseFloat(avg.toFixed(1)),
      peerCount:comps.length,
      diff,
      peers:    comps.map(c=>c.ticker),
    };
  } catch(_){ return null; }
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Misc helpers
// ─────────────────────────────────────────────────────────────────────────────
function getRating(s){
  if(s>=5)return{label:'Strong Buy',color:'#14532d',bg:'#dcfce7',border:'#86efac'};
  if(s===4)return{label:'Buy',color:'#15803d',bg:'#f0fdf4',border:'#bbf7d0'};
  if(s===3)return{label:'Watch',color:'#92400e',bg:'#fffbeb',border:'#fde68a'};
  return{label:'Ignore',color:'#6b7280',bg:'#f9fafb',border:'#d1d5db'};
}
function cleanExchange(raw){
  if(!raw)return'NYSE';
  const u=raw.toUpperCase();
  if(u.includes('NASDAQ'))return'NASDAQ';
  if(u.includes('NYSE'))return'NYSE';
  if(u.includes('LSE')||u.includes('LONDON'))return'LSE';
  if(u.includes('TSX')||u.includes('TORONTO'))return'TSX';
  return raw.split(/[\s,]/)[0].toUpperCase()||'NYSE';
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Master fetch
// ─────────────────────────────────────────────────────────────────────────────
async function fetchStockData(ticker, crumbInfo) {
  const [quoteR,profileR,metricsR,earningsR,yhChartR,avR]=await Promise.allSettled([
    fh(`/quote?symbol=${ticker}`),
    fh(`/stock/profile2?symbol=${ticker}`),
    fh(`/stock/metric?symbol=${ticker}&metric=all`),
    fh(`/stock/earnings?symbol=${ticker}&limit=4`),
    yahooFetch(`/v8/finance/chart/${ticker}?interval=1d&range=1y`,crumbInfo),
    fetchAV(ticker),
  ]);
  const curPx  =quoteR.status==='fulfilled'   ?quoteR.value?.c            :null;
  const fhM    =metricsR.status==='fulfilled'  ?metricsR.value?.metric||{} :{};
  const avData =avR.status==='fulfilled'        ?avR.value                  :null;
  const yhChart=yhChartR.status==='fulfilled'   ?yhChartR.value             :null;
  const yhMeta =yhChart?.chart?.result?.[0]?.meta||{};
  const yhClose=yhChart?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c=>c!=null&&!isNaN(c)&&c>0)||[];
  const [eps,ma50,curPE,analystTarget,insiderData]=await Promise.all([
    resolveEPS(ticker,avData,fhM,crumbInfo),
    resolveMA50(ticker,avData,crumbInfo,yhChart),
    resolvePE(ticker,avData,fhM,crumbInfo,yhChart),
    resolveTarget(ticker,avData,crumbInfo),
    resolveInsider(ticker),
  ]);
  const {hi52,lo52}=resolve52w(avData,fhM,yhMeta,yhClose);
  const peerPE=await resolvePeerPE(ticker,curPE,fhM.marketCapitalization||0,crumbInfo);
  return {
    quote:   quoteR.status==='fulfilled'   ?quoteR.value   :null,
    profile: profileR.status==='fulfilled' ?profileR.value :null,
    earnings:earningsR.status==='fulfilled'?earningsR.value:null,
    hi52,lo52,curPE,eps,ma50,analystTarget,insiderData,peerPE,
  };
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Evaluate
// ─────────────────────────────────────────────────────────────────────────────
function evaluate(ticker, d) {
  const q=d.quote||{},p=d.profile||{};
  const curPx=q.c;
  if (!curPx) return null;
  const company=p.name||ticker;
  const mc=p.marketCapitalization?p.marketCapitalization*1e6:0;
  const mcs=mc>1e12?`$${(mc/1e12).toFixed(2)}T`:mc>1e9?`$${(mc/1e9).toFixed(1)}B`:mc>1e6?`$${(mc/1e6).toFixed(0)}M`:'';
  const exchange=cleanExchange(p.exchange);
 
  // S1 — EPS beat
  let s1={status:'neutral',value:'No data'};
  try {
    const earns=Array.isArray(d.earnings)?d.earnings:[];
    if (earns.length>0){const e=earns[0],diff=e.actual-e.estimate,beat=diff>=0;const ds=Math.abs(diff)<0.005?'in-line':beat?`+$${Math.abs(diff).toFixed(2)}`:`-$${Math.abs(diff).toFixed(2)}`;s1={status:beat?'pass':'fail',value:beat?`Beat by ${ds}`:`Missed ${ds}`};}
  } catch(_){}
 
  // S2 — PE vs hist avg
  let s2={status:'neutral',value:'No data'};
  try {
    if (d.curPE&&d.curPE>0&&d.eps&&d.eps!==0&&d.hi52&&d.lo52&&d.hi52>d.lo52){
      const histPE=(d.hi52+d.lo52)/2/d.eps;
      if (histPE>0&&histPE<1000){
        if      (d.curPE<histPE*0.92)s2={status:'pass',  value:`PE ${d.curPE.toFixed(1)}x < hist ~${histPE.toFixed(0)}x`};
        else if (d.curPE>histPE*1.08)s2={status:'fail',  value:`PE ${d.curPE.toFixed(1)}x > hist ~${histPE.toFixed(0)}x`};
        else                         s2={status:'neutral',value:`PE ${d.curPE.toFixed(1)}x ≈ hist ~${histPE.toFixed(0)}x`};
      }
    } else if (d.curPE&&d.curPE>0) s2={status:'neutral',value:`PE ${d.curPE.toFixed(1)}x`};
  } catch(_){}
 
  // S3 — price vs 50d MA
  let s3={status:'neutral',value:'No data'};
  try {
    if (d.ma50&&d.ma50>0&&curPx){const pct=((curPx-d.ma50)/d.ma50*100).toFixed(1);s3=curPx<=d.ma50?{status:'pass',value:`$${curPx.toFixed(2)} ≤ MA $${d.ma50.toFixed(2)} (${pct}%)`}:{status:'fail',value:`$${curPx.toFixed(2)} > MA $${d.ma50.toFixed(2)} (+${pct}%)`};}
  } catch(_){}
 
  // S4 — insider
  const {buys,sells,source}=d.insiderData||{buys:[],sells:[],source:null};
  const s4=buildInsider(buys,sells,source);
 
  // S5 — analyst target
  let s5={status:'neutral',value:'No data'};
  try {
    const tgt=d.analystTarget;
    if (tgt&&tgt>0&&curPx){const up=((tgt-curPx)/curPx*100).toFixed(1);s5=parseFloat(up)>=25?{status:'pass',value:`Target $${tgt.toFixed(2)}, +${up}% upside`}:{status:'fail',value:`Target $${tgt.toFixed(2)}, +${up}% upside`};}
  } catch(_){}
 
  // S6 — PE vs peers: display % above/below, not just the raw peer avg
  let s6={status:'neutral',value:'No data'};
  try {
    const pp=d.peerPE;
    if (pp&&pp.avgPE&&pp.diff!==null) {
      const absDiff=Math.abs(pp.diff);
      if      (pp.diff<-8) s6={status:'pass',   value:`${absDiff.toFixed(0)}% < peer avg ${pp.avgPE}x`};
      else if (pp.diff>8)  s6={status:'fail',   value:`${absDiff.toFixed(0)}% > peer avg ${pp.avgPE}x`};
      else                 s6={status:'neutral', value:`In line with peers (avg ${pp.avgPE}x)`};
    } else if (pp?.avgPE) {
      s6={status:'neutral',value:`Peer avg ${pp.avgPE}x`};
    }
  } catch(_){}
 
  const signals=[s1,s2,s3,s4,s5,s6];
  const score=signals.filter(s=>s.status==='pass').length;
  const NAMES=['EPS beat','Low PE','Below 50d MA','Insider buying','Analyst upside','PE vs peers'];
  const passes=signals.map((s,i)=>s.status==='pass'?NAMES[i]:null).filter(Boolean);
  const fails =signals.map((s,i)=>s.status==='fail'?NAMES[i]:null).filter(Boolean);
  let summary;
  if      (score>=5) summary=`Strong value candidate — ${score}/6 signals pass. Strengths: ${passes.join(', ')}.`;
  else if (score===4)summary=`Good signals (4/6). Passes: ${passes.join(', ')}.`;
  else if (score===3)summary=`Moderate signals (3/6). Passes: ${passes.join(', ')}.`;
  else if (score>0)  summary=`Weak signals (${score}/6). Fails: ${fails.join(', ')}.`;
  else               summary=`No signals pass. Fails: ${fails.join(', ')}.`;
 
  return{ticker,company,exchange,price:`$${curPx.toFixed(2)}`,
    change:q.dp!=null?`${q.dp>0?'+':''}${q.dp.toFixed(2)}%`:null,
    marketCap:mcs,score,signals,summary,rating:getRating(score),
    peerPE:d.peerPE||null,updatedAt:new Date().toISOString()};
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  if (!FINNHUB_KEY)        return res.status(500).json({error:'FINNHUB_KEY not set'});
  const {tickers}=req.body;
  if (!Array.isArray(tickers)||tickers.length===0) return res.status(400).json({error:'tickers array required'});
  const cleaned=tickers.slice(0,20).map(t=>t.toUpperCase().trim());
  Object.keys(_avCache).forEach(k=>delete _avCache[k]);
  Object.keys(_saCache).forEach(k=>delete _saCache[k]);
  Object.keys(_mwCache).forEach(k=>delete _mwCache[k]);
  Object.keys(_pePeerCache).forEach(k=>delete _pePeerCache[k]);
  const crumbInfo=await getYahooCrumb();
  const results={};
  await Promise.allSettled(cleaned.map(async ticker=>{
    try { const raw=await fetchStockData(ticker,crumbInfo); const ev=evaluate(ticker,raw); results[ticker]=ev||{ticker,error:'No quote data'}; }
    catch(e){ results[ticker]={ticker,error:e.message}; }
  }));
  res.setHeader('Cache-Control','s-maxage=300, stale-while-revalidate');
  return res.status(200).json({results,fetchedAt:new Date().toISOString()});
}
 
