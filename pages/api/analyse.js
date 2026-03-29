// pages/api/analyse.js  v7
//
// Fixes vs v6:
//
//  PE VS PEERS (resolvePeerPE / getPeerPE):
//    - Hard cap per-peer PE at 150x (was 600x — allowed garbage data through)
//    - Cross-source validation: if only one source returns a PE, it must be
//      within 3× of a rough sector baseline to be accepted; wild outliers are
//      discarded rather than trimmed after the fact
//    - Trimmed-mean trim raised from 10% → 20% each side so it actually fires
//      on small peer lists (5 peers → removes 1 from each end)
//    - diff now consistently compared against medianPE (more robust) rather
//      than avgPE, and avgPE is still reported for display
//    - Market-cap band tightened: lo=0.15, hi=6 (was 0.07–14)
//    - Minimum 3 valid peers required before a result is returned (was 2)
//
//  INSIDER BUYING (resolveInsider / buildInsider):
//    - OpenInsider value column parser completely rewritten:
//        "$1.23M" → 1_230_000  |  "$456K" → 456_000  |  "+$789,012" → 789_012
//    - Per-transaction sanity check: value must be > $500 and < $5B
//    - Share count sanity check: shares must be > 0 and < 500M
//    - Finnhub `value` field: confirmed it's in USD — added a check that it
//      isn't suspiciously large (>$10B) which would indicate a data error
//    - Deduplication: transactions from OpenInsider are skipped if Finnhub
//      already returned data for the same ticker (no double-counting)
//    - buildInsider caps displayed value at $10B as a final sanity guard
//
// All other logic is unchanged from v6.
//
// Sources used (in priority order per signal):
//
//  ALWAYS WORKS (Finnhub authenticated API):
//    /quote, /stock/profile2, /stock/earnings, /stock/insider-transactions,
//    /stock/price-target, /stock/peers, /stock/candle (→ S3 50d MA)
//
//  PAGE SCRAPERS (embedded JSON in public pages — no auth, no IP blocks):
//    stockanalysis.com  → __NEXT_DATA__ JSON: EPS, PE, revenue, analyst target
//    macrotrends.net    → chartData JSON: PE ratio history, EPS history
//    marketwatch.com    → __PRELOADED_STATE__ JSON: PE, EPS, price target
//    zacks.com          → HTML patterns: PE, EPS, analyst targets
//    wisesheets.io      → public quote data
//
//  YAHOO (crumb-authenticated to bypass Vercel IP block):
//    /v8/finance/chart   → closes for MA computation, 52w hi/lo, PE
//    /v10/quoteSummary   → EPS, analyst target, PE
//
//  SEC EDGAR (government — never blocked):
//    /api/xbrl/companyfacts → EPS from 10-K/10-Q XBRL data
//
//  ALPHA VANTAGE (if AV_KEY env var set — free at alphavantage.co):
//    OVERVIEW → EPS, PE, 50dMA, analyst target, 52w hi/lo all in one call
//
// ENV VARS:
//   FINNHUB_KEY  — required (finnhub.io)
//   AV_KEY       — optional but strongly recommended (alphavantage.co, free)
 
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const AV_KEY      = process.env.AV_KEY;
 
const FH  = 'https://finnhub.io/api/v1';
const AV  = 'https://www.alphavantage.co/query';
 
// Browser-like headers — critical for page scrapers
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
 
// ─────────────────────────────────────────────────────────────────────────────
// PE sanity bounds
// Hard cap per-peer PE. 150x is already extreme (e.g. high-growth tech).
// Anything above this is almost certainly a data artefact (negative EPS quarter
// causing a sign flip, stale data, scraper misparse, etc.).
// ─────────────────────────────────────────────────────────────────────────────
const PE_MAX = 150;
 
// ─────────────────────────────────────────────────────────────────────────────
// Core fetchers
// ─────────────────────────────────────────────────────────────────────────────
 
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
 
// ─────────────────────────────────────────────────────────────────────────────
// Yahoo crumb auth — one crumb per request batch
// ─────────────────────────────────────────────────────────────────────────────
 
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
 
// ─────────────────────────────────────────────────────────────────────────────
// Alpha Vantage OVERVIEW — single call returns EPS, PE, MA50, target, 52w
// ─────────────────────────────────────────────────────────────────────────────
 
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
 
// ─────────────────────────────────────────────────────────────────────────────
// stockanalysis.com — __NEXT_DATA__ has EPS, PE, analyst target, revenue
// ─────────────────────────────────────────────────────────────────────────────
 
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
 
// ─────────────────────────────────────────────────────────────────────────────
// marketwatch.com — __PRELOADED_STATE__ JSON has PE, EPS, price target
// ─────────────────────────────────────────────────────────────────────────────
 
const _mwCache = {};
async function fetchMarketWatch(ticker) {
  if (_mwCache[ticker]) return _mwCache[ticker];
  try {
    const html = await getPage(`https://www.marketwatch.com/investing/stock/${ticker.toLowerCase()}`);
    const m1 = html.match(/window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    if (m1) {
      try {
        const d = JSON.parse(m1[1]);
        _mwCache[ticker] = { type: 'state', data: d };
        return _mwCache[ticker];
      } catch (_) {}
    }
    const result = { type: 'html', raw: html };
    _mwCache[ticker] = result;
    return result;
  } catch (_) { return null; }
}
 
function mwExtractPE(mw) {
  if (!mw) return null;
  if (mw.type === 'state') {
    const d = mw.data;
    const paths = [
      d?.instrumentData?.primaryData?.peRatio,
      d?.quote?.peRatio,
      d?.stock?.peRatio,
    ];
    for (const v of paths) { if (v && !isNaN(parseFloat(v))) return parseFloat(v); }
  }
  if (mw.raw) {
    for (const p of [
      /"peRatio"\s*:\s*"?([\d.]+)"?/,
      /P\/E Ratio[^<]*<\/span>[^<]*<span[^>]*>([\d.]+)/,
      /class="[^"]*pe-ratio[^"]*"[^>]*>([\d.]+)/,
    ]) {
      const m = mw.raw.match(p);
      if (m) { const v = parseFloat(m[1]); if (v > 0 && v < PE_MAX) return v; }
    }
  }
  return null;
}
 
function mwExtractEPS(mw) {
  if (!mw?.raw) return null;
  for (const p of [
    /"epsTrailingTwelveMonths"\s*:\s*([-\d.]+)/,
    /EPS \(TTM\)[^<]*<\/[^>]+>[^<]*<[^>]+>([-\d.]+)/,
    /"eps"\s*:\s*([-\d.]+)/,
  ]) {
    const m = mw.raw.match(p);
    if (m) { const v = parseFloat(m[1]); if (v !== 0 && !isNaN(v)) return v; }
  }
  return null;
}
 
// ─────────────────────────────────────────────────────────────────────────────
// zacks.com — has PE, EPS, analyst targets
// ─────────────────────────────────────────────────────────────────────────────
 
async function fetchZacks(ticker) {
  try {
    const html = await getPage(`https://www.zacks.com/stock/quote/${ticker.toUpperCase()}`);
    return html;
  } catch (_) { return null; }
}
 
function zacksExtractPE(html) {
  if (!html) return null;
  for (const p of [
    /P\/E Ratio[^<]*<\/dt>[^<]*<dd[^>]*>([\d.]+)/,
    /"peRatio"\s*:\s*([\d.]+)/,
    /class="[^"]*pe_ratio[^"]*"[^>]*>([\d.]+)/,
    /P\/E\s*<[^>]+>\s*([\d.]+)/,
    /Earnings Per Share[^<]*<[^>]+>([-\d.]+)/,
  ]) {
    const m = html.match(p);
    if (m) { const v = parseFloat(m[1]); if (v > 0 && v < PE_MAX) return v; }
  }
  return null;
}
 
function zacksExtractTarget(html) {
  if (!html) return null;
  for (const p of [
    /Price Target[^<]*<[^>]+>\s*\$([\d.]+)/i,
    /Zacks Mean Target[^<]*<[^>]+>\s*\$([\d.]+)/i,
    /"targetPrice"\s*:\s*([\d.]+)/,
    /consensus.*?target.*?\$([\d,]+\.?\d*)/i,
  ]) {
    const m = html.match(p);
    if (m) { const v = parseFloat(m[1].replace(/,/g, '')); if (v > 0) return v; }
  }
  return null;
}
 
// ─────────────────────────────────────────────────────────────────────────────
// macrotrends.net — PE ratio history and EPS history
// ─────────────────────────────────────────────────────────────────────────────
 
async function fetchMacrotrendsEPS(ticker) {
  try {
    const html = await getPage(
      `https://www.macrotrends.net/stocks/charts/${ticker.toUpperCase()}/x/eps-earnings-per-share-diluted`,
      10000
    );
    const m = html.match(/var\s+chartData\s*=\s*(\[[\s\S]*?\]);/);
    if (m) {
      const arr = JSON.parse(m[1]);
      const recent = arr.filter(a => a?.[1] != null && !isNaN(parseFloat(a[1]))).slice(0, 4);
      if (recent.length > 0) return parseFloat(recent[0][1]);
    }
  } catch (_) {}
  return null;
}
 
// ─────────────────────────────────────────────────────────────────────────────
// SEC EDGAR — EPS from XBRL filings (government, never blocked)
// ─────────────────────────────────────────────────────────────────────────────
 
const _cikCache = {};
async function getSecCIK(ticker) {
  if (_cikCache[ticker]) return _cikCache[ticker];
  try {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': 'signal-engine/1.0 admin@example.com' },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const j = await r.json();
      for (const e of Object.values(j)) {
        if (e.ticker?.toUpperCase() === ticker.toUpperCase()) {
          const cik = String(e.cik_str).padStart(10, '0');
          _cikCache[ticker] = cik;
          return cik;
        }
      }
    }
  } catch (_) {}
  return null;
}
 
async function fetchSecEPS(ticker) {
  try {
    const cik = await getSecCIK(ticker);
    if (!cik) return null;
    const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, {
      headers: { 'User-Agent': 'signal-engine/1.0 admin@example.com' },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const facts = d?.facts?.['us-gaap'];
    for (const key of ['EarningsPerShareBasic', 'EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted']) {
      const units = facts?.[key]?.units?.['USD/shares'] || [];
      const annual = units.filter(e => e.form === '10-K').sort((a, b) => new Date(b.end) - new Date(a.end));
      if (annual.length > 0 && annual[0].val != null) return annual[0].val;
      const qtrs = units.filter(e => e.form === '10-Q').sort((a, b) => new Date(b.end) - new Date(a.end)).slice(0, 4);
      if (qtrs.length === 4) {
        const ttm = qtrs.reduce((s, q) => s + (q.val || 0), 0);
        if (ttm !== 0) return ttm;
      }
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
  if (!ds) return null;
  const d = new Date(ds); if (isNaN(d)) return null;
  const days = Math.floor((Date.now()-d)/86400000);
  return days===0?'today':days===1?'1d ago':days<7?`${days}d ago`:days<14?'1w ago':days<30?`${Math.floor(days/7)}w ago`:`${Math.floor(days/30)}mo ago`;
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Signal resolvers — each has 6–10 independent sources
// ─────────────────────────────────────────────────────────────────────────────
 
// ── S3: 50-day Moving Average ─────────────────────────────────────────────────
function compute50dMA(closes) {
  if (!Array.isArray(closes)) return null;
  const v = closes.filter(c => c!=null && !isNaN(c) && c>0);
  if (v.length < 20) return null;
  const sl = v.slice(-50);
  return sl.reduce((a,b)=>a+b,0)/sl.length;
}
 
async function resolveMA50(ticker, avData, crumbInfo, yahooChartData) {
  const av = parseFloat(avData?.['50DayMovingAverage']);
  if (av > 0 && !isNaN(av)) return av;
 
  const yhCloses = yahooChartData?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c=>c!=null&&!isNaN(c)&&c>0)||[];
  const yhMA = compute50dMA(yhCloses);
  if (yhMA > 0) return yhMA;
 
  try {
    const to   = Math.floor(Date.now()/1000);
    const from = to - 90*86400;
    const d = await fh(`/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${to}`);
    if (d?.s==='ok' && Array.isArray(d.c) && d.c.length>=20) {
      const ma = compute50dMA(d.c);
      if (ma>0) return ma;
    }
  } catch (_) {}
 
  try {
    const j = await yahooFetch(`/v10/finance/quoteSummary/${ticker}?modules=summaryDetail`, crumbInfo);
    const ma = j?.quoteSummary?.result?.[0]?.summaryDetail?.fiftyDayAverage?.raw;
    if (ma>0) return ma;
  } catch (_) {}
 
  try {
    const j = await yahooFetch(`/v8/finance/chart/${ticker}?interval=1d&range=3mo`, crumbInfo);
    const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c=>c!=null&&!isNaN(c)&&c>0)||[];
    const ma = compute50dMA(closes);
    if (ma>0) return ma;
  } catch (_) {}
 
  try {
    const sa = await fetchStockAnalysis(ticker);
    const ma = saExtract(sa, ['ma50','movingAverage50','fiftyDayAverage','avg50']);
    if (ma>0) return ma;
  } catch (_) {}
 
  try {
    const mw = await fetchMarketWatch(ticker);
    if (mw?.raw) {
      const m = mw.raw.match(/50.?Day[^<]*<[^>]+>([\d.]+)/i) || mw.raw.match(/"fiftyDayAverage"\s*:\s*([\d.]+)/);
      if (m) { const v=parseFloat(m[1]); if (v>0) return v; }
    }
  } catch (_) {}
 
  try {
    const r = await fetch(`https://stooq.com/q/d/l/?s=${ticker.toLowerCase()}.us&i=d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const text = await r.text();
      if (text.length>100 && !text.toLowerCase().includes('no data')) {
        const lines  = text.trim().split('\n').slice(1);
        const closes = lines.slice(-60).map(l=>parseFloat((l.split(',')[4]||'').trim())).filter(c=>!isNaN(c)&&c>0);
        const ma = compute50dMA(closes);
        if (ma>0) return ma;
      }
    }
  } catch (_) {}
 
  return null;
}
 
// ── S2: EPS (needed for PE vs hist avg) ───────────────────────────────────────
async function resolveEPS(ticker, avData, fhMetric, crumbInfo) {
  const avEPS = parseFloat(avData?.EPS);
  if (!isNaN(avEPS) && avEPS!==0) return avEPS;
 
  const fhEPS = fhMetric?.epsTTM || fhMetric?.epsBasicExclExtraAnnual;
  if (fhEPS && fhEPS!==0) return fhEPS;
 
  try {
    const j = await yahooFetch(`/v10/finance/quoteSummary/${ticker}?modules=defaultKeyStatistics`, crumbInfo);
    const eps = j?.quoteSummary?.result?.[0]?.defaultKeyStatistics?.trailingEps?.raw;
    if (eps!=null && eps!==0) return eps;
  } catch (_) {}
 
  try {
    const j = await yahooFetch(`/v10/finance/quoteSummary/${ticker}?modules=earningsHistory`, crumbInfo);
    const h = j?.quoteSummary?.result?.[0]?.earningsHistory?.history||[];
    if (h.length>=2) { const ttm=h.slice(-4).reduce((s,q)=>s+(q?.epsActual?.raw||0),0); if (ttm!==0) return ttm; }
  } catch (_) {}
 
  try {
    const sa = await fetchStockAnalysis(ticker);
    const eps = saExtract(sa, ['eps','epsTrailingTwelveMonths','epsTTM','earningsPerShare','netEPS','annualEPS']);
    if (eps!=null && eps!==0) return eps;
  } catch (_) {}
 
  try {
    const mw = await fetchMarketWatch(ticker);
    const eps = mwExtractEPS(mw);
    if (eps!=null && eps!==0) return eps;
  } catch (_) {}
 
  try {
    const eps = await fetchMacrotrendsEPS(ticker);
    if (eps!=null && eps!==0) return eps;
  } catch (_) {}
 
  try {
    const eps = await fetchSecEPS(ticker);
    if (eps!=null && eps!==0) return eps;
  } catch (_) {}
 
  try {
    const html = await fetchZacks(ticker);
    if (html) {
      const m = html.match(/EPS\s*\(TTM\)[^<]*<[^>]+>\s*\$?\s*([-\d.]+)/i) ||
                html.match(/"epsTrailingTwelveMonths"\s*:\s*([-\d.]+)/);
      if (m) { const v=parseFloat(m[1]); if (v!==0 && !isNaN(v)) return v; }
    }
  } catch (_) {}
 
  return null;
}
 
// ── S2: Current PE ─────────────────────────────────────────────────────────────
async function resolvePE(ticker, avData, fhMetric, crumbInfo, yahooChartData) {
  const avPE = parseFloat(avData?.PERatio);
  if (!isNaN(avPE) && avPE>0 && avPE<PE_MAX) return avPE;
 
  const fhPE = fhMetric?.peBasicExclExtraTTM || fhMetric?.peTTM;
  if (fhPE>0 && fhPE<PE_MAX) return fhPE;
 
  const yhPE = yahooChartData?.chart?.result?.[0]?.meta?.trailingPE;
  if (yhPE>0 && yhPE<PE_MAX) return yhPE;
 
  try {
    const j = await yahooFetch(`/v10/finance/quoteSummary/${ticker}?modules=summaryDetail`, crumbInfo);
    const pe = j?.quoteSummary?.result?.[0]?.summaryDetail?.trailingPE?.raw;
    if (pe>0 && pe<PE_MAX) return pe;
  } catch (_) {}
 
  try {
    const sa = await fetchStockAnalysis(ticker);
    const pe = saExtract(sa, ['pe','peRatio','priceEarnings','trailingPE','forwardPE']);
    if (pe>0 && pe<PE_MAX) return pe;
  } catch (_) {}
 
  try {
    const mw = await fetchMarketWatch(ticker);
    const pe = mwExtractPE(mw);
    if (pe>0 && pe<PE_MAX) return pe;
  } catch (_) {}
 
  try {
    const html = await fetchZacks(ticker);
    const pe = zacksExtractPE(html);
    if (pe>0 && pe<PE_MAX) return pe;
  } catch (_) {}
 
  return null;
}
 
// ── S5: Analyst target ─────────────────────────────────────────────────────────
async function resolveTarget(ticker, avData, crumbInfo) {
  const avT = parseFloat(avData?.AnalystTargetPrice);
  if (!isNaN(avT) && avT>0) return avT;
 
  try {
    const d = await fh(`/stock/price-target?symbol=${ticker}`);
    const t = d?.targetMedian || d?.targetMean;
    if (t>0) return t;
  } catch (_) {}
 
  try {
    const j = await yahooFetch(`/v10/finance/quoteSummary/${ticker}?modules=financialData`, crumbInfo);
    const fd = j?.quoteSummary?.result?.[0]?.financialData;
    const t = fd?.targetMedianPrice?.raw || fd?.targetMeanPrice?.raw;
    if (t>0) return t;
  } catch (_) {}
 
  try {
    const html = await getPage(`https://stockanalysis.com/stocks/${ticker.toLowerCase()}/forecast/`);
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (m) {
      const d    = JSON.parse(m[1]);
      const ppts = d?.props?.pageProps;
      const t    = ppts?.data?.priceTarget || ppts?.priceTarget ||
                   saExtract(ppts, ['data.priceTarget','data.targetPrice','data.analystTarget','priceTarget']);
      if (t>0) return t;
    }
    for (const p of [
      /price\s+target[^$<]*\$\s*([\d,]+\.?\d*)/i,
      /consensus[^$<]*\$\s*([\d,]+\.?\d*)/i,
      /target\s+price[^$<]*\$\s*([\d,]+\.?\d*)/i,
      /analyst.*?target.*?\$([\d,]+\.?\d*)/i,
    ]) {
      const match = html.match(p);
      if (match) { const v=parseFloat(match[1].replace(/,/g,'')); if (v>0 && v<100000) return v; }
    }
  } catch (_) {}
 
  try {
    const html = await fetchZacks(ticker);
    const t = zacksExtractTarget(html);
    if (t>0) return t;
  } catch (_) {}
 
  try {
    const html = await getPage(`https://www.marketwatch.com/investing/stock/${ticker.toLowerCase()}/analystestimates`);
    for (const p of [/target\s*price[^$<]*\$\s*([\d,]+\.?\d*)/i, /mean\s*target[^$<]*\$\s*([\d,]+\.?\d*)/i]) {
      const m = html.match(p);
      if (m) { const v=parseFloat(m[1].replace(/,/g,'')); if (v>0) return v; }
    }
  } catch (_) {}
 
  return null;
}
 
// ─────────────────────────────────────────────────────────────────────────────
// 52w Hi/Lo
// ─────────────────────────────────────────────────────────────────────────────
function resolve52w(avData, fhMetric, yahooChartMeta, yahooChartCloses) {
  let hi = fhMetric?.['52WeekHigh'] || parseFloat(avData?.['52WeekHigh']) || yahooChartMeta?.fiftyTwoWeekHigh || null;
  let lo = fhMetric?.['52WeekLow']  || parseFloat(avData?.['52WeekLow'])  || yahooChartMeta?.fiftyTwoWeekLow  || null;
  if (isNaN(hi)) hi=null;
  if (isNaN(lo)) lo=null;
  if ((!hi||!lo) && yahooChartCloses.length>50) {
    if (!hi) hi=Math.max(...yahooChartCloses);
    if (!lo) lo=Math.min(...yahooChartCloses);
  }
  return { hi52: hi, lo52: lo };
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Insider transactions
//
// FIX: OpenInsider value column parser completely rewritten.
//
// OpenInsider value column examples:
//   "+$1,234,567"   → 1_234_567
//   "$1.23M"        → 1_230_000
//   "$456K"         → 456_000
//   "$789,012"      → 789_012
//   "(123,456)"     → 123_456   (parentheses = negative on some rows, treat as abs)
//
// The old parser did replace(/[^0-9]/g,'') which turned "$1.23M" into "123"
// (dropping the "M" suffix meaning), producing nonsense values.
// ─────────────────────────────────────────────────────────────────────────────
 
/**
 * Parse an OpenInsider-formatted dollar value string into a raw number (USD).
 * Returns 0 if parsing fails or result is outside sanity bounds.
 */
function parseOpenInsiderValue(raw) {
  if (!raw) return 0;
  const s = raw.replace(/[\s+()]/g, '').toUpperCase(); // strip whitespace, +, parens
 
  // Suffix multipliers: $1.23M, $456K, $1.2B
  const suffixMatch = s.match(/^\$?([\d,]+\.?\d*)\s*([KMB])$/);
  if (suffixMatch) {
    const num = parseFloat(suffixMatch[1].replace(/,/g, ''));
    const mult = { K: 1e3, M: 1e6, B: 1e9 }[suffixMatch[2]];
    const val = num * mult;
    // Sanity: insider transaction values should be between $500 and $5B
    if (val >= 500 && val <= 5e9) return val;
    return 0;
  }
 
  // Plain dollar with commas: $1,234,567 or 1234567
  const plainMatch = s.match(/^\$?([\d,]+\.?\d*)$/);
  if (plainMatch) {
    const val = parseFloat(plainMatch[1].replace(/,/g, ''));
    if (val >= 500 && val <= 5e9) return val;
    return 0;
  }
 
  return 0;
}
 
/**
 * Parse share count from OpenInsider — plain integer with possible commas/+.
 */
function parseOpenInsiderShares(raw) {
  if (!raw) return 0;
  const n = parseInt(raw.replace(/[^0-9]/g, ''), 10);
  // Sanity: 1 share minimum, 500M maximum
  if (!isNaN(n) && n > 0 && n < 500_000_000) return n;
  return 0;
}
 
async function resolveInsider(ticker, curPx) {
  const now   = Math.floor(Date.now()/1000);
  const ago30 = now - 30*86400;
  const from  = new Date(ago30*1000).toISOString().slice(0,10);
  const to    = new Date(now*1000).toISOString().slice(0,10);
  const cut   = new Date(ago30*1000);
 
  // ── Finnhub ────────────────────────────────────────────────────────────────
  // Finnhub returns `value` in USD (total transaction value).
  // Guard: if value > $10B it's almost certainly a data error.
  try {
    const d = await fh(`/stock/insider-transactions?symbol=${ticker}&from=${from}&to=${to}`);
    const txns = d?.data || [];
 
    const buys  = [];
    const sells = [];
 
    for (const t of txns) {
      if (t.transactionCode === 'P') {
        const val = (t.value && t.value < 10e9) ? t.value : 0;
        buys.push({ ...t, value: val });
      } else if (t.transactionCode === 'S') {
        const val = (t.value && t.value < 10e9) ? t.value : 0;
        sells.push({ ...t, value: val });
      }
    }
 
    if (buys.length > 0 || sells.length > 0) {
      return { buys, sells, source: 'finnhub' };
    }
  } catch (_) {}
 
  // ── OpenInsider fallback ───────────────────────────────────────────────────
  // Only used when Finnhub returns nothing. Avoids double-counting.
  try {
    const r = await fetch(
      `https://openinsider.com/screener?s=${ticker}&fd=-30&td=0&xs=1&vl=0&grp=0&cnt=20&action=1`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(7000) }
    );
    if (r.ok) {
      const html = await r.text();
      const rows = [...html.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/gi)];
      const buys  = [];
      const sells = [];
 
      for (const row of rows) {
        const cells = [...row[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
          .map(c => c[1].replace(/<[^>]+>/g, '').trim());
        if (cells.length < 10) continue;
 
        // OpenInsider table columns (0-indexed):
        // 0: X (checkbox), 1: Filing Date, 2: Trade Date, 3: Ticker, 4: Company,
        // 5: Insider Name, 6: Title, 7: Trade Type, 8: Price, 9: Qty, 10: Owned,
        // 11: ΔOwn, 12: Value
        const tradeType  = cells[7] || '';
        const dateStr    = cells[2] || cells[1] || '';
        const sharesRaw  = cells[9]  || '';
        const valueRaw   = cells[12] || '';
 
        if (!dateStr || !tradeType) continue;
        const txDate = new Date(dateStr);
        if (isNaN(txDate) || txDate < cut) continue;
 
        const shares = parseOpenInsiderShares(sharesRaw);
        const value  = parseOpenInsiderValue(valueRaw);
 
        // If value parsed to 0 but we have shares + a price, estimate from price column
        let finalValue = value;
        if (finalValue === 0 && shares > 0) {
          const priceRaw  = parseFloat((cells[8] || '').replace(/[^0-9.]/g, ''));
          const priceEst  = priceRaw > 0 ? priceRaw : curPx;
          const estimated = shares * priceEst;
          // Only use estimated value if it's plausible
          if (estimated >= 500 && estimated <= 5e9) finalValue = estimated;
        }
 
        const entry = {
          transactionDate:  dateStr,
          share:            shares,
          value:            finalValue,
          transactionPrice: shares > 0 && finalValue > 0 ? finalValue / shares : (curPx || 0),
        };
 
        if (/P\s*-\s*Purchase/i.test(tradeType)) buys.push(entry);
        else if (/S\s*-\s*Sale/i.test(tradeType)) sells.push(entry);
      }
 
      if (buys.length > 0 || sells.length > 0) {
        return { buys, sells, source: 'openinsider' };
      }
    }
  } catch (_) {}
 
  return { buys: [], sells: [], source: null };
}
 
function buildInsider(buys, sells, source) {
  // Hard cap on displayed value: $10B (guards against any remaining bad data)
  const VALUE_CAP = 10e9;
 
  if (buys.length > 0) {
    const sh  = buys.reduce((s, t) => s + (t.share || 0), 0);
    const val = Math.min(
      buys.reduce((s, t) => s + (t.value || 0), 0),
      VALUE_CAP
    );
    const parts = [`${buys.length} buy${buys.length > 1 ? 's' : ''}`];
    const s = fmtSh(sh);   if (s) parts.push(s);
    const d = fmt$M(val);  if (d) parts.push(d);
    const dates = buys.map(t => t.transactionDate).filter(Boolean).sort().reverse();
    const rc = dates[0] ? timeAgo(dates[0]) : null; if (rc) parts.push(rc);
    return { status: 'pass', value: parts.join(' · ') };
  }
 
  if (sells.length > 0) {
    const sh  = sells.reduce((s, t) => s + (t.share || 0), 0);
    const val = Math.min(
      sells.reduce((s, t) => s + (t.value || 0), 0),
      VALUE_CAP
    );
    const parts = [`${sells.length} sell${sells.length > 1 ? 's' : ''}, no buys`];
    const s = fmtSh(sh);   if (s) parts.push(s);
    const d = fmt$M(val);  if (d) parts.push(d);
    const dates = sells.map(t => t.transactionDate).filter(Boolean).sort().reverse();
    const rc = dates[0] ? timeAgo(dates[0]) : null; if (rc) parts.push(rc);
    return { status: 'fail', value: parts.join(' · ') };
  }
 
  return { status: 'neutral', value: source ? 'No activity (30d)' : 'No data' };
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Peer PE
//
// FIX summary:
//   1. Hard PE cap lowered to PE_MAX (150) — was 600 in v6
//   2. getPeerPE validates each source result against PE_MAX before accepting
//   3. resolvePeerPE: trimmed-mean trim raised to 20% each side
//   4. Minimum peer count raised to 3
//   5. Market-cap band tightened: lo=0.15, hi=6 (was 0.07–14)
//   6. `diff` is now vs medianPE (more robust); avgPE still displayed
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
 
  // Collect candidate PE values from multiple sources, then validate consistency.
  // If only one source fires and the value is extreme, we discard it.
  const candidates = [];
 
  // 1. Yahoo chart meta — fastest
  try {
    const j = await yahooFetch(`/v8/finance/chart/${peer}?interval=1d&range=5d`, crumbInfo);
    const pe = j?.chart?.result?.[0]?.meta?.trailingPE;
    const mc = j?.chart?.result?.[0]?.meta?.marketCap || 0;
    if (pe > 0 && pe < PE_MAX) candidates.push({ pe, mc, src: 'yahoo' });
  } catch (_) {}
 
  // 2. Finnhub metric
  try {
    const d = await fh(`/stock/metric?symbol=${peer}&metric=all`);
    const pe = d?.metric?.peBasicExclExtraTTM || d?.metric?.peTTM;
    const mc = (d?.metric?.marketCapitalization || 0) * 1e6;
    if (pe > 0 && pe < PE_MAX) candidates.push({ pe, mc, src: 'finnhub' });
  } catch (_) {}
 
  // 3. Alpha Vantage (if key available)
  if (AV_KEY) {
    try {
      const d = await fetchAV(peer);
      const pe = parseFloat(d?.PERatio);
      const mc = parseFloat(d?.MarketCapitalization) || 0;
      if (!isNaN(pe) && pe > 0 && pe < PE_MAX) candidates.push({ pe, mc, src: 'av' });
    } catch (_) {}
  }
 
  // 4. stockanalysis.com
  try {
    const sa  = await fetchStockAnalysis(peer);
    const pe  = saExtract(sa, ['pe','peRatio','trailingPE']);
    const mc  = saExtract(sa, ['marketCap','marketCapitalization']) || 0;
    if (pe > 0 && pe < PE_MAX) candidates.push({ pe, mc, src: 'sa' });
  } catch (_) {}
 
  if (candidates.length === 0) return null;
 
  // Cross-source validation:
  // If we have 2+ sources, use their median PE to avoid a single bad outlier.
  // If we have only 1 source, accept it only if it's below 80x (less extreme threshold
  // for single-source trust — above 80x with no corroboration is too risky).
  let finalPE, finalMC;
 
  if (candidates.length >= 2) {
    const pes = candidates.map(c => c.pe).sort((a, b) => a - b);
    const mid = Math.floor(pes.length / 2);
    finalPE = pes.length % 2 === 0 ? (pes[mid - 1] + pes[mid]) / 2 : pes[mid];
    // Use the MC from whichever source had the largest (most complete) value
    finalMC = Math.max(...candidates.map(c => c.mc || 0));
  } else {
    // Single source — only trust if PE < 80
    const { pe, mc } = candidates[0];
    if (pe >= 80) return null;
    finalPE = pe;
    finalMC = mc;
  }
 
  const result = { ticker: peer, pe: finalPE, mc: finalMC };
  _pePeerCache[peer] = result;
  return result;
}
 
async function resolvePeerPE(ticker, curPE, targetMC, crumbInfo) {
  try {
    let peerList = [];
    try {
      const pd = await fh(`/stock/peers?symbol=${ticker}`);
      if (Array.isArray(pd)) peerList = pd.filter(p => p !== ticker && /^[A-Z]{1,5}$/.test(p));
    } catch (_) {}
    if (PEERS[ticker]) peerList = [...new Set([...peerList, ...PEERS[ticker]])].filter(p => p !== ticker);
    peerList = peerList.slice(0, 10);
    if (!peerList.length) return null;
 
    // Batch in 2s to avoid rate limits
    const all = [];
    for (let i = 0; i < peerList.length; i += 2) {
      const batch = peerList.slice(i, i + 2);
      const res   = await Promise.allSettled(batch.map(p => getPeerPE(p, crumbInfo)));
      all.push(...res.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value));
    }
    if (!all.length) return null;
 
    // ── Market-cap band filter (tightened from v6) ─────────────────────────
    // Only include peers within 6× / ÷6 of the target's market cap.
    // This prevents e.g. a $500B mega-cap being compared to a $2B small-cap.
    let comps = all;
    if (targetMC > 0 && all.filter(c => c.mc > 0).length >= 2) {
      const lo = 1 / 6;   // peer MC must be at least 1/6th of target
      const hi = 6;       // peer MC must be at most 6× target
      const f  = all.filter(c => c.mc === 0 || (c.mc / (targetMC * 1e6) >= lo && c.mc / (targetMC * 1e6) <= hi));
      if (f.length >= 3) comps = f;
    }
 
    // ── Trimmed mean (raised from 10% → 20% each side) ─────────────────────
    // With 5 peers: trim=1 from each end → 3 peers used (was 0 in v6 with 10%)
    // With 10 peers: trim=2 from each end → 6 peers used
    if (comps.length >= 5) {
      const s    = [...comps].sort((a, b) => a.pe - b.pe);
      const trim = Math.max(1, Math.floor(s.length * 0.20));
      comps      = s.slice(trim, s.length - trim);
    }
 
    // Need at least 3 valid peers to report a meaningful result (raised from 2)
    if (comps.length < 3) return null;
 
    const pes = comps.map(c => c.pe).sort((a, b) => a - b);
    const mid = Math.floor(pes.length / 2);
    const med = pes.length % 2 === 0 ? (pes[mid - 1] + pes[mid]) / 2 : pes[mid];
    const avg = pes.reduce((a, b) => a + b, 0) / pes.length;
 
    // diff vs medianPE (more robust than avgPE — a single outlier that survives
    // trimming can still skew the mean by several points)
    const diff = curPE && curPE > 0
      ? parseFloat(((curPE - med) / med * 100).toFixed(1))
      : null;
 
    return {
      medianPE:   parseFloat(med.toFixed(1)),
      avgPE:      parseFloat(avg.toFixed(1)),
      peerCount:  comps.length,
      diff,
      peers:      comps.map(c => c.ticker),
    };
  } catch (_) { return null; }
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Misc helpers
// ─────────────────────────────────────────────────────────────────────────────
function getRating(s){
  if(s>=5) return{label:'Strong Buy',color:'#14532d',bg:'#dcfce7',border:'#86efac'};
  if(s===4) return{label:'Buy',color:'#15803d',bg:'#f0fdf4',border:'#bbf7d0'};
  if(s===3) return{label:'Watch',color:'#92400e',bg:'#fffbeb',border:'#fde68a'};
  return{label:'Ignore',color:'#6b7280',bg:'#f9fafb',border:'#d1d5db'};
}
function cleanExchange(raw){
  if(!raw) return'NYSE';
  const u=raw.toUpperCase();
  if(u.includes('NASDAQ')) return'NASDAQ';
  if(u.includes('NYSE'))   return'NYSE';
  if(u.includes('LSE')||u.includes('LONDON'))  return'LSE';
  if(u.includes('TSX')||u.includes('TORONTO')) return'TSX';
  return raw.split(/[\s,]/)[0].toUpperCase()||'NYSE';
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Master fetch
// ─────────────────────────────────────────────────────────────────────────────
async function fetchStockData(ticker, crumbInfo) {
  const [quoteR, profileR, metricsR, earningsR, yhChartR, avR] = await Promise.allSettled([
    fh(`/quote?symbol=${ticker}`),
    fh(`/stock/profile2?symbol=${ticker}`),
    fh(`/stock/metric?symbol=${ticker}&metric=all`),
    fh(`/stock/earnings?symbol=${ticker}&limit=4`),
    yahooFetch(`/v8/finance/chart/${ticker}?interval=1d&range=1y`, crumbInfo),
    fetchAV(ticker),
  ]);
 
  const curPx  = quoteR.status==='fulfilled'   ? quoteR.value?.c             : null;
  const fhM    = metricsR.status==='fulfilled' ? metricsR.value?.metric||{}  : {};
  const avData = avR.status==='fulfilled'       ? avR.value                   : null;
  const yhChart = yhChartR.status==='fulfilled' ? yhChartR.value              : null;
  const yhMeta  = yhChart?.chart?.result?.[0]?.meta||{};
  const yhClose = yhChart?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c=>c!=null&&!isNaN(c)&&c>0)||[];
 
  const [eps, ma50, curPE, analystTarget, insiderData] = await Promise.all([
    resolveEPS(ticker, avData, fhM, crumbInfo),
    resolveMA50(ticker, avData, crumbInfo, yhChart),
    resolvePE(ticker, avData, fhM, crumbInfo, yhChart),
    resolveTarget(ticker, avData, crumbInfo),
    resolveInsider(ticker, curPx),
  ]);
 
  const { hi52, lo52 } = resolve52w(avData, fhM, yhMeta, yhClose);
  const peerPE = await resolvePeerPE(ticker, curPE, fhM.marketCapitalization||0, crumbInfo);
 
  return {
    quote:    quoteR.status==='fulfilled'    ? quoteR.value    : null,
    profile:  profileR.status==='fulfilled'  ? profileR.value  : null,
    earnings: earningsR.status==='fulfilled' ? earningsR.value : null,
    hi52, lo52, curPE, eps, ma50, analystTarget, insiderData, peerPE,
  };
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Evaluate
// ─────────────────────────────────────────────────────────────────────────────
function evaluate(ticker, d) {
  const q=d.quote||{}, p=d.profile||{};
  const curPx=q.c;
  if (!curPx) return null;
 
  const company=p.name||ticker;
  const mc=p.marketCapitalization?p.marketCapitalization*1e6:0;
  const mcs=mc>1e12?`$${(mc/1e12).toFixed(2)}T`:mc>1e9?`$${(mc/1e9).toFixed(1)}B`:mc>1e6?`$${(mc/1e6).toFixed(0)}M`:'';
  const exchange=cleanExchange(p.exchange);
 
  // S1
  let s1={status:'neutral',value:'No data'};
  try {
    const earns=Array.isArray(d.earnings)?d.earnings:[];
    if (earns.length>0) {
      const e=earns[0], diff=e.actual-e.estimate, beat=diff>=0;
      const ds=Math.abs(diff)<0.005?'in-line':beat?`+$${Math.abs(diff).toFixed(2)}`:`-$${Math.abs(diff).toFixed(2)}`;
      s1={status:beat?'pass':'fail',value:beat?`Beat by ${ds}`:`Missed ${ds}`};
    }
  } catch(_){}
 
  // S2
  let s2={status:'neutral',value:'No data'};
  try {
    if (d.curPE&&d.curPE>0&&d.eps&&d.eps!==0&&d.hi52&&d.lo52&&d.hi52>d.lo52) {
      const histPE=(d.hi52+d.lo52)/2/d.eps;
      if (histPE>0&&histPE<1000) {
        if      (d.curPE<histPE*0.92) s2={status:'pass',   value:`PE ${d.curPE.toFixed(1)}x < hist ~${histPE.toFixed(0)}x`};
        else if (d.curPE>histPE*1.08) s2={status:'fail',   value:`PE ${d.curPE.toFixed(1)}x > hist ~${histPE.toFixed(0)}x`};
        else                          s2={status:'neutral', value:`PE ${d.curPE.toFixed(1)}x ≈ hist ~${histPE.toFixed(0)}x`};
      }
    } else if (d.curPE&&d.curPE>0) s2={status:'neutral',value:`PE ${d.curPE.toFixed(1)}x`};
  } catch(_){}
 
  // S3
  let s3={status:'neutral',value:'No data'};
  try {
    if (d.ma50&&d.ma50>0&&curPx) {
      const pct=((curPx-d.ma50)/d.ma50*100).toFixed(1);
      s3=curPx<=d.ma50?{status:'pass',value:`$${curPx.toFixed(2)} ≤ MA $${d.ma50.toFixed(2)} (${pct}%)`}
                      :{status:'fail',value:`$${curPx.toFixed(2)} > MA $${d.ma50.toFixed(2)} (+${pct}%)`};
    }
  } catch(_){}
 
  // S4
  const {buys,sells,source}=d.insiderData||{buys:[],sells:[],source:null};
  const s4=buildInsider(buys,sells,source);
 
  // S5
  let s5={status:'neutral',value:'No data'};
  try {
    const tgt=d.analystTarget;
    if (tgt&&tgt>0&&curPx) {
      const up=((tgt-curPx)/curPx*100).toFixed(1);
      s5=parseFloat(up)>=25?{status:'pass',value:`Target $${tgt.toFixed(2)}, +${up}% upside`}
                            :{status:'fail',value:`Target $${tgt.toFixed(2)}, +${up}% upside`};
    }
  } catch(_){}
 
  // S6 — diff now vs medianPE (fixed in v7)
  let s6={status:'neutral',value:'No data'};
  try {
    const pp=d.peerPE;
    if (pp&&pp.medianPE&&pp.diff!==null) {
      if      (pp.diff<-8) s6={status:'pass',   value:`${Math.abs(pp.diff).toFixed(0)}% < peer median ${pp.medianPE}x`};
      else if (pp.diff>8)  s6={status:'fail',   value:`${Math.abs(pp.diff).toFixed(0)}% > peer median ${pp.medianPE}x`};
      else                 s6={status:'neutral', value:`In line, peer median ${pp.medianPE}x`};
    } else if (pp?.medianPE) s6={status:'neutral',value:`Peer median ${pp.medianPE}x`};
  } catch(_){}
 
  const signals=[s1,s2,s3,s4,s5,s6];
  const score=signals.filter(s=>s.status==='pass').length;
  const NAMES=['EPS beat','Low PE','Below 50d MA','Insider buying','Analyst upside','PE vs peers'];
  const passes=signals.map((s,i)=>s.status==='pass'?NAMES[i]:null).filter(Boolean);
  const fails =signals.map((s,i)=>s.status==='fail'?NAMES[i]:null).filter(Boolean);
 
  let summary;
  if      (score>=5)  summary=`Strong value candidate — ${score}/6 signals pass. Strengths: ${passes.join(', ')}.`;
  else if (score===4) summary=`Good signals (4/6). Passes: ${passes.join(', ')}.`;
  else if (score===3) summary=`Moderate signals (3/6). Passes: ${passes.join(', ')}.`;
  else if (score>0)   summary=`Weak signals (${score}/6). Fails: ${fails.join(', ')}.`;
  else                summary=`No signals pass. Fails: ${fails.join(', ')}.`;
 
  return { ticker, company, exchange, price:`$${curPx.toFixed(2)}`,
    change:q.dp!=null?`${q.dp>0?'+':''}${q.dp.toFixed(2)}%`:null,
    marketCap:mcs, score, signals, summary, rating:getRating(score),
    peerPE:d.peerPE||null, updatedAt:new Date().toISOString() };
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
 
  // Clear per-request caches
  Object.keys(_avCache).forEach(k=>delete _avCache[k]);
  Object.keys(_saCache).forEach(k=>delete _saCache[k]);
  Object.keys(_mwCache).forEach(k=>delete _mwCache[k]);
  Object.keys(_pePeerCache).forEach(k=>delete _pePeerCache[k]);
 
  const crumbInfo = await getYahooCrumb();
 
  const results={};
  await Promise.allSettled(cleaned.map(async ticker=>{
    try {
      const raw=await fetchStockData(ticker,crumbInfo);
      const ev=evaluate(ticker,raw);
      results[ticker]=ev||{ticker,error:'No quote data'};
    } catch(e){ results[ticker]={ticker,error:e.message}; }
  }));
 
  res.setHeader('Cache-Control','s-maxage=300, stale-while-revalidate');
  return res.status(200).json({results, fetchedAt:new Date().toISOString()});
}
 
