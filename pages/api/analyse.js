// pages/api/analyse.js  v5
//
// Root cause of missing signals was identified:
//   - Finnhub free tier returns null for EPS/PE on most tickers
//   - Yahoo blocks Vercel shared IPs without proper crumb auth
//   - FMP free tier requires API key (their keyless endpoints were deprecated)
//
// Solution — 4 genuinely independent data providers:
//
//  1. FINNHUB (FINNHUB_KEY) — quote, profile, candle, earnings, price-target,
//     insider-transactions, peers. Candle is the anchor for 50d MA.
//
//  2. ALPHA VANTAGE (AV_KEY env var — free at alphavantage.co, 25 req/day free)
//     OVERVIEW endpoint returns in one call: EPS, PERatio, AnalystTargetPrice,
//     50DayMovingAverage, 200DayMovingAverage, 52WeekHigh, 52WeekLow.
//     This single call fixes S2, S3, and S5 for every ticker.
//
//  3. YAHOO FINANCE with crumb authentication — fetch crumb once per batch,
//     reuse across all tickers. Crumb bypasses the 401/429 blocking.
//     Used for: trailingPE, peer PE, 52w hi/lo, closes for MA.
//
//  4. SEC EDGAR XBRL API (government, always accessible, no key needed)
//     Used as EPS fallback: /api/xbrl/companyfacts/CIK{n}.json
//     Returns EPS from actual 10-K/10-Q filings — ground truth.
//
// ENV VARS REQUIRED:
//   FINNHUB_KEY  — from finnhub.io (existing)
//   AV_KEY       — from alphavantage.co (free, sign up takes 30 seconds)
 
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const AV_KEY      = process.env.AV_KEY;   // Alpha Vantage — get free at alphavantage.co
 
const FH = 'https://finnhub.io/api/v1';
const AV = 'https://www.alphavantage.co/query';
 
// Yahoo crumb — fetched once per request batch, shared across all tickers
let _yahooCrumb   = null;
let _yahooCookies = '';
let _crumbExpiry  = 0;
 
const YH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
 
// ─────────────────────────────────────────────────────────────────────────────
// Yahoo crumb auth — required to avoid 401s on Vercel shared IPs
// ─────────────────────────────────────────────────────────────────────────────
 
async function getYahooCrumb() {
  // Reuse crumb for up to 5 minutes
  if (_yahooCrumb && Date.now() < _crumbExpiry) return { crumb: _yahooCrumb, cookies: _yahooCookies };
 
  try {
    // Step 1: Hit Yahoo Finance home to get session cookies
    const homeRes = await fetch('https://finance.yahoo.com/', {
      headers: {
        'User-Agent': YH_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
 
    // Extract Set-Cookie headers
    const rawCookies = homeRes.headers.get('set-cookie') || '';
    // Parse into simple cookie string — grab A1, A3, A1S cookies
    const cookiePairs = rawCookies.split(',').map(c => c.split(';')[0].trim()).filter(c => c.includes('='));
    _yahooCookies = cookiePairs.join('; ');
 
    // Step 2: Fetch crumb using those cookies
    const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        'User-Agent': YH_UA,
        'Accept': '*/*',
        'Cookie': _yahooCookies,
      },
      signal: AbortSignal.timeout(6000),
    });
 
    if (crumbRes.ok) {
      const crumb = await crumbRes.text();
      if (crumb && crumb.length > 0 && !crumb.includes('{')) {
        _yahooCrumb  = crumb.trim();
        _crumbExpiry = Date.now() + 5 * 60 * 1000;
        return { crumb: _yahooCrumb, cookies: _yahooCookies };
      }
    }
  } catch (_) {}
 
  // Fallback: try query2
  try {
    const r = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': YH_UA, 'Accept': '*/*' },
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const crumb = await r.text();
      if (crumb && crumb.length > 0 && !crumb.includes('{')) {
        _yahooCrumb  = crumb.trim();
        _crumbExpiry = Date.now() + 5 * 60 * 1000;
        return { crumb: _yahooCrumb, cookies: '' };
      }
    }
  } catch (_) {}
 
  return { crumb: null, cookies: '' };
}
 
// Yahoo fetch with crumb
async function yahooFetch(url, crumbInfo) {
  const { crumb, cookies } = crumbInfo || { crumb: null, cookies: '' };
  const fullUrl = crumb ? `${url}${url.includes('?') ? '&' : '?'}crumb=${encodeURIComponent(crumb)}` : url;
 
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    const u = fullUrl.replace(/https:\/\/query[12]\.finance\.yahoo\.com/, base);
    try {
      const r = await fetch(u, {
        headers: {
          'User-Agent': YH_UA,
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          ...(cookies ? { 'Cookie': cookies } : {}),
        },
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
// Finnhub
// ─────────────────────────────────────────────────────────────────────────────
 
async function fh(path) {
  if (!FINNHUB_KEY) throw new Error('No FINNHUB_KEY');
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${FH}${path}${sep}token=${FINNHUB_KEY}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Finnhub ${r.status}`);
  const d = await r.json();
  if (d?.error) throw new Error(d.error);
  return d;
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Alpha Vantage OVERVIEW — the key new data source
// Returns: EPS, PERatio, AnalystTargetPrice, 50DayMovingAverage,
//          52WeekHigh, 52WeekLow, MarketCapitalization, all in ONE call
// Free tier: 25 calls/day, 5 calls/minute — plenty for our use case
// ─────────────────────────────────────────────────────────────────────────────
 
async function fetchAVOverview(ticker) {
  if (!AV_KEY) return null;
  try {
    const r = await fetch(
      `${AV}?function=OVERVIEW&symbol=${ticker}&apikey=${AV_KEY}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    // AV returns {"Information":"..."} when rate limited or key invalid
    if (d?.Information || d?.Note || !d?.Symbol) return null;
    return d;
  } catch (_) { return null; }
}
 
// ─────────────────────────────────────────────────────────────────────────────
// SEC EDGAR — EPS from actual XBRL filings (government, always works)
// ─────────────────────────────────────────────────────────────────────────────
 
// Cache ticker → CIK mapping (stable data, no need to re-fetch)
const CIK_CACHE = {};
 
async function getSecCIK(ticker) {
  if (CIK_CACHE[ticker]) return CIK_CACHE[ticker];
  try {
    const r = await fetch(
      `https://efts.sec.gov/LATEST/search-index?q=%22${ticker}%22&dateRange=custom&startdt=2020-01-01&enddt=2025-12-31&forms=10-K&hits.hits._source=period_of_report,entity_name,file_num`,
      { headers: { 'User-Agent': 'signal-engine/1.0 contact@example.com' }, signal: AbortSignal.timeout(7000) }
    );
    // Better: use the company search endpoint
    const r2 = await fetch(
      `https://efts.sec.gov/LATEST/search-index?q=%22${ticker}%22&forms=10-K&dateRange=custom&startdt=2023-01-01&enddt=2025-12-31`,
      { headers: { 'User-Agent': 'signal-engine/1.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (r2.ok) {
      const j   = await r2.json();
      const hit = j?.hits?.hits?.[0]?._source;
      const cik = hit?.entity_id || hit?.cik;
      if (cik) { CIK_CACHE[ticker] = String(cik).padStart(10, '0'); return CIK_CACHE[ticker]; }
    }
  } catch (_) {}
 
  // Fallback: SEC company tickers JSON (updated daily by SEC)
  try {
    const r = await fetch(
      'https://www.sec.gov/files/company_tickers.json',
      { headers: { 'User-Agent': 'signal-engine/1.0' }, signal: AbortSignal.timeout(8000) }
    );
    if (r.ok) {
      const j = await r.json();
      for (const entry of Object.values(j)) {
        if (entry.ticker?.toUpperCase() === ticker.toUpperCase()) {
          const cik = String(entry.cik_str).padStart(10, '0');
          CIK_CACHE[ticker] = cik;
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
 
    const r = await fetch(
      `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
      { headers: { 'User-Agent': 'signal-engine/1.0' }, signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return null;
    const d = await r.json();
 
    // Try EarningsPerShareBasic first, then Diluted
    const facts = d?.facts?.['us-gaap'];
    for (const key of ['EarningsPerShareBasic', 'EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted']) {
      const concept = facts?.[key];
      if (!concept) continue;
 
      // Get annual data (10-K) — last 4 quarters sum for TTM
      const annualUnits = concept.units?.['USD/shares'] || [];
      const annuals = annualUnits
        .filter(e => e.form === '10-K' && e.val != null)
        .sort((a, b) => new Date(b.end) - new Date(a.end));
 
      if (annuals.length > 0) {
        const eps = annuals[0].val;
        if (eps != null && eps !== 0) return eps;
      }
 
      // Try quarterly (10-Q) — sum last 4 for TTM
      const quarterlyUnits = annualUnits.filter(e => e.form === '10-Q' && e.val != null);
      if (quarterlyUnits.length >= 4) {
        const recent4 = quarterlyUnits
          .sort((a, b) => new Date(b.end) - new Date(a.end))
          .slice(0, 4);
        const ttm = recent4.reduce((sum, e) => sum + e.val, 0);
        if (ttm !== 0) return ttm;
      }
    }
  } catch (_) {}
  return null;
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Format helpers
// ─────────────────────────────────────────────────────────────────────────────
 
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
  if (days < 7)  return `${days}d ago`;
  if (days < 14) return '1w ago';
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
 
// ─────────────────────────────────────────────────────────────────────────────
// 50-day MA
// ─────────────────────────────────────────────────────────────────────────────
 
function compute50dMA(closes) {
  if (!Array.isArray(closes)) return null;
  const valid = closes.filter(c => c != null && !isNaN(c) && c > 0);
  if (valid.length < 20) return null;
  const slice = valid.slice(-50);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}
 
async function resolve50dMA(ticker, avOverview, crumbInfo) {
  // 1: Alpha Vantage OVERVIEW — 50DayMovingAverage pre-computed, very reliable
  const avMA = parseFloat(avOverview?.['50DayMovingAverage']);
  if (avMA && avMA > 0) return avMA;
 
  // 2: Finnhub candle — 60 daily bars, compute ourselves
  try {
    const d = await fh(`/stock/candle?symbol=${ticker}&resolution=D&count=60`);
    if (d?.s === 'ok' && Array.isArray(d.c) && d.c.length >= 20) {
      const ma = compute50dMA(d.c);
      if (ma && ma > 0) return ma;
    }
  } catch (_) {}
 
  // 3: Yahoo chart — compute from closes (uses crumb auth)
  try {
    const j = await yahooFetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=3mo`,
      crumbInfo
    );
    const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close
      ?.filter(c => c != null && !isNaN(c) && c > 0);
    const ma = compute50dMA(closes);
    if (ma && ma > 0) return ma;
  } catch (_) {}
 
  // 4: Yahoo quoteSummary summaryDetail — fiftyDayAverage (pre-computed)
  try {
    const j = await yahooFetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=summaryDetail`,
      crumbInfo
    );
    const ma = j?.quoteSummary?.result?.[0]?.summaryDetail?.fiftyDayAverage?.raw;
    if (ma && ma > 0) return ma;
  } catch (_) {}
 
  return null;
}
 
// ─────────────────────────────────────────────────────────────────────────────
// EPS resolution
// ─────────────────────────────────────────────────────────────────────────────
 
async function resolveEPS(ticker, avOverview, finnhubMetric, crumbInfo) {
  // 1: Alpha Vantage OVERVIEW — EPS field, highly reliable
  const avEPS = parseFloat(avOverview?.EPS);
  if (!isNaN(avEPS) && avEPS !== 0) return avEPS;
 
  // 2: Finnhub metric
  const fhEPS = finnhubMetric?.epsTTM || finnhubMetric?.epsBasicExclExtraAnnual;
  if (fhEPS && fhEPS !== 0) return fhEPS;
 
  // 3: Yahoo v10 defaultKeyStatistics — trailingEps
  try {
    const j = await yahooFetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=defaultKeyStatistics`,
      crumbInfo
    );
    const eps = j?.quoteSummary?.result?.[0]?.defaultKeyStatistics?.trailingEps?.raw;
    if (eps != null && eps !== 0) return eps;
  } catch (_) {}
 
  // 4: Yahoo earningsHistory — TTM from last 4 quarters
  try {
    const j = await yahooFetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=earningsHistory`,
      crumbInfo
    );
    const history = j?.quoteSummary?.result?.[0]?.earningsHistory?.history || [];
    if (history.length >= 2) {
      const ttm = history.slice(-4).reduce((s, q) => s + (q?.epsActual?.raw || 0), 0);
      if (ttm !== 0) return ttm;
    }
  } catch (_) {}
 
  // 5: SEC EDGAR XBRL — ground truth from 10-K filings
  const secEPS = await fetchSecEPS(ticker);
  if (secEPS != null && secEPS !== 0) return secEPS;
 
  return null;
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Current PE
// ─────────────────────────────────────────────────────────────────────────────
 
async function resolveCurrentPE(ticker, avOverview, finnhubMetric, crumbInfo) {
  // 1: Alpha Vantage OVERVIEW — PERatio field
  const avPE = parseFloat(avOverview?.PERatio);
  if (!isNaN(avPE) && avPE > 0 && avPE < 600) return avPE;
 
  // 2: Finnhub metric
  const fhPE = finnhubMetric?.peBasicExclExtraTTM || finnhubMetric?.peTTM;
  if (fhPE && fhPE > 0 && fhPE < 600) return fhPE;
 
  // 3: Yahoo chart meta — trailingPE (fast, usually works)
  try {
    const j = await yahooFetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5d`,
      crumbInfo
    );
    const pe = j?.chart?.result?.[0]?.meta?.trailingPE;
    if (pe && pe > 0 && pe < 600) return pe;
  } catch (_) {}
 
  // 4: Yahoo summaryDetail
  try {
    const j = await yahooFetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=summaryDetail`,
      crumbInfo
    );
    const pe = j?.quoteSummary?.result?.[0]?.summaryDetail?.trailingPE?.raw;
    if (pe && pe > 0 && pe < 600) return pe;
  } catch (_) {}
 
  return null;
}
 
// ─────────────────────────────────────────────────────────────────────────────
// 52w hi/lo
// ─────────────────────────────────────────────────────────────────────────────
 
async function resolve52w(ticker, avOverview, finnhubMetric, yahoChartMeta) {
  let hi = finnhubMetric?.['52WeekHigh']
    || parseFloat(avOverview?.['52WeekHigh'])
    || yahoChartMeta?.fiftyTwoWeekHigh
    || null;
  let lo = finnhubMetric?.['52WeekLow']
    || parseFloat(avOverview?.['52WeekLow'])
    || yahoChartMeta?.fiftyTwoWeekLow
    || null;
 
  if (isNaN(hi)) hi = null;
  if (isNaN(lo)) lo = null;
 
  return { hi52: hi || null, lo52: lo || null };
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Analyst target
// ─────────────────────────────────────────────────────────────────────────────
 
async function resolveAnalystTarget(ticker, avOverview, crumbInfo) {
  // 1: Alpha Vantage OVERVIEW — AnalystTargetPrice
  const avTarget = parseFloat(avOverview?.AnalystTargetPrice);
  if (!isNaN(avTarget) && avTarget > 0) return avTarget;
 
  // 2: Finnhub price-target (works on free tier)
  try {
    const d = await fh(`/stock/price-target?symbol=${ticker}`);
    const t = d?.targetMedian || d?.targetMean;
    if (t && t > 0) return t;
  } catch (_) {}
 
  // 3: Yahoo financialData
  try {
    const j = await yahooFetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData`,
      crumbInfo
    );
    const fd = j?.quoteSummary?.result?.[0]?.financialData;
    const t  = fd?.targetMedianPrice?.raw || fd?.targetMeanPrice?.raw;
    if (t && t > 0) return t;
  } catch (_) {}
 
  return null;
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Insider transactions
// ─────────────────────────────────────────────────────────────────────────────
 
async function fetchInsiderTransactions(ticker, curPx) {
  const now    = Math.floor(Date.now() / 1000);
  const ago30  = now - 30 * 86400;
  const from30 = new Date(ago30 * 1000).toISOString().slice(0, 10);
  const to30   = new Date(now  * 1000).toISOString().slice(0, 10);
  const cutoff = new Date(ago30 * 1000);
 
  try {
    const d    = await fh(`/stock/insider-transactions?symbol=${ticker}&from=${from30}&to=${to30}`);
    const txns = d?.data || [];
    if (txns.length > 0) {
      const buys  = txns.filter(t => t.transactionCode === 'P');
      const sells = txns.filter(t => t.transactionCode === 'S');
      if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'finnhub' };
    }
  } catch (_) {}
 
  // OpenInsider as fallback
  try {
    const r = await fetch(
      `https://openinsider.com/screener?s=${ticker}&fd=-30&td=0&xs=1&vl=0&grp=0&cnt=20&action=1`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(7000) }
    );
    if (r.ok) {
      const html = await r.text();
      const rows = [...html.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/gi)];
      const buys = [], sells = [];
      for (const row of rows) {
        const cells = [...row[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
          .map(c => c[1].replace(/<[^>]+>/g, '').trim());
        if (cells.length < 10) continue;
        const [, dateStr, , , type, , , , sharesRaw, valueRaw] = cells;
        if (!dateStr || !type) continue;
        const txDate = new Date(dateStr);
        if (isNaN(txDate) || txDate < cutoff) continue;
        const shares = parseInt((sharesRaw || '').replace(/[^0-9]/g, '')) || 0;
        const value  = parseInt((valueRaw  || '').replace(/[^0-9]/g, '')) || 0;
        const entry  = { transactionDate: dateStr, share: shares, value,
          transactionPrice: shares > 0 ? value / shares : curPx };
        if (/P\s*-\s*Purchase/i.test(type))  buys.push(entry);
        else if (/S\s*-\s*Sale/i.test(type)) sells.push(entry);
      }
      if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'openinsider' };
    }
  } catch (_) {}
 
  return { buys: [], sells: [], source: null };
}
 
function buildInsiderValue(buys, sells, source) {
  if (buys.length > 0) {
    const totalShares = buys.reduce((s, t) => s + (t.share || 0), 0);
    const totalValue  = buys.reduce((s, t) => s + (t.value || Math.abs((t.share || 0) * (t.transactionPrice || 0))), 0);
    const parts = [`${buys.length} buy${buys.length > 1 ? 's' : ''}`];
    const sh = fmtShares(totalShares); if (sh) parts.push(sh);
    const dl = fmtDollars(totalValue); if (dl) parts.push(dl);
    const dates = buys.map(t => t.transactionDate).filter(Boolean).sort().reverse();
    const rc = dates[0] ? timeAgo(dates[0]) : null; if (rc) parts.push(rc);
    return { status: 'pass', value: parts.join(' · ') };
  }
  if (sells.length > 0) {
    const totalShares = sells.reduce((s, t) => s + (t.share || 0), 0);
    const totalValue  = sells.reduce((s, t) => s + (t.value || Math.abs((t.share || 0) * (t.transactionPrice || 0))), 0);
    const parts = [`${sells.length} sell${sells.length > 1 ? 's' : ''}, no buys`];
    const sh = fmtShares(totalShares); if (sh) parts.push(sh);
    const dl = fmtDollars(totalValue); if (dl) parts.push(dl);
    const dates = sells.map(t => t.transactionDate).filter(Boolean).sort().reverse();
    const rc = dates[0] ? timeAgo(dates[0]) : null; if (rc) parts.push(rc);
    return { status: 'fail', value: parts.join(' · ') };
  }
  return { status: 'neutral', value: source ? 'No activity (30d)' : 'No data' };
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Peer PE
// ─────────────────────────────────────────────────────────────────────────────
 
const PEER_MAP = {
  AAPL:['MSFT','GOOGL','META','AMZN','NVDA'],   MSFT:['AAPL','GOOGL','CRM','ORCL','IBM'],
  GOOGL:['META','MSFT','AMZN','SNAP','TTD'],     META:['GOOGL','SNAP','PINS','TTD'],
  AMZN:['MSFT','GOOGL','WMT','COST','BABA'],    NVDA:['AMD','INTC','QCOM','AVGO','TXN'],
  TSLA:['GM','F','RIVN','TM','STLA'],            AVGO:['QCOM','TXN','ADI','MRVL','AMD'],
  ORCL:['SAP','MSFT','CRM','IBM','WDAY'],        AMD:['NVDA','INTC','QCOM','TXN','MU'],
  INTC:['AMD','NVDA','QCOM','TXN','AVGO'],       QCOM:['AVGO','TXN','ADI','MRVL','AMD'],
  JPM:['BAC','WFC','C','GS','MS'],               BAC:['JPM','WFC','C','USB','PNC'],
  WFC:['JPM','BAC','C','USB','PNC'],             GS:['MS','JPM','C','BLK','SCHW'],
  MS:['GS','JPM','C','BLK','SCHW'],              BLK:['SCHW','MS','GS','IVZ'],
  LLY:['NVO','PFE','MRK','ABBV','BMY'],          JNJ:['PFE','ABBV','MRK','TMO','ABT'],
  UNH:['CVS','CI','HUM','ELV','CNC'],            ABBV:['PFE','LLY','MRK','BMY','REGN'],
  MRK:['PFE','JNJ','ABBV','LLY','BMY'],          PFE:['MRK','JNJ','ABBV','BMY','LLY'],
  TMO:['DHR','A','WAT','BIO','IDXX'],            ABT:['MDT','BSX','SYK','BDX','EW'],
  AMGN:['REGN','BIIB','VRTX','BMY','GILD'],      CVS:['WBA','CI','UNH','HUM','ELV'],
  XOM:['CVX','COP','SLB','EOG','OXY'],           CVX:['XOM','COP','SLB','EOG','DVN'],
  COP:['EOG','XOM','CVX','DVN','OXY'],           EOG:['COP','DVN','OXY','MRO','HES'],
  HD:['LOW','WMT','TGT','COST','AMZN'],          LOW:['HD','WMT','TGT','COST'],
  WMT:['TGT','COST','KR','HD','AMZN'],           TGT:['WMT','COST','HD','KR','DG'],
  COST:['WMT','TGT','BJ','HD'],                  MCD:['YUM','CMG','QSR','DRI'],
  NKE:['UAA','DECK','LULU','SKX'],               SBUX:['MCD','CMG','YUM','QSR'],
  KO:['PEP','MDLZ','MNST','KHC'],               PEP:['KO','MDLZ','MNST','KHC'],
  PM:['MO','BTI','IMBBY'],                        MO:['PM','BTI','IMBBY'],
  T:['VZ','TMUS','CMCSA','CHTR'],                VZ:['T','TMUS','CMCSA','CHTR'],
  TMUS:['T','VZ','CMCSA','CHTR'],                CAT:['DE','HON','EMR','ITW','PH'],
  DE:['CAT','AGCO','CNH','HON'],                 HON:['CAT','EMR','ITW','ROK','ETN'],
  GE:['HON','RTX','EMR','ETN','PH'],             RTX:['LMT','NOC','GD','BA'],
  LMT:['NOC','RTX','GD','BA'],                   UPS:['FDX','XPO','ODFL','SAIA'],
  FDX:['UPS','XPO','ODFL'],                      IBM:['MSFT','ORCL','HPE','ACN'],
  NEE:['DUK','SO','AEP','EXC','D'],              AMT:['PLD','EQIX','CCI','SPG','O'],
  NFLX:['DIS','WBD','PARA','ROKU'],              DIS:['NFLX','WBD','PARA','CMCSA'],
  MA:['V','PYPL','AXP','FIS'],                   V:['MA','PYPL','AXP','FIS'],
  KR:['WMT','TGT','COST','ACI'],                 SPGI:['MCO','ICE','CME','MSCI'],
};
 
// Fetch PE for one peer — AV OVERVIEW is the primary source (reliable)
// We cache AV calls to avoid hitting rate limit for peers
const AV_PE_CACHE = {};
 
async function fetchPeerPE_single(peer, crumbInfo) {
  // 1: Alpha Vantage OVERVIEW — cached
  if (!AV_PE_CACHE[peer] && AV_KEY) {
    try {
      const d = await fetchAVOverview(peer);
      if (d) {
        const pe = parseFloat(d.PERatio);
        const mc = parseFloat(d.MarketCapitalization) || 0;
        if (!isNaN(pe) && pe > 0 && pe < 600) {
          AV_PE_CACHE[peer] = { ticker: peer, pe, mc };
        }
      }
    } catch (_) {}
  }
  if (AV_PE_CACHE[peer]) return AV_PE_CACHE[peer];
 
  // 2: Yahoo chart meta (with crumb)
  try {
    const j  = await yahooFetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${peer}?interval=1d&range=5d`,
      crumbInfo
    );
    const pe = j?.chart?.result?.[0]?.meta?.trailingPE;
    const mc = j?.chart?.result?.[0]?.meta?.marketCap || 0;
    if (pe && pe > 0 && pe < 600) return { ticker: peer, pe, mc };
  } catch (_) {}
 
  // 3: Finnhub metric
  try {
    const d  = await fh(`/stock/metric?symbol=${peer}&metric=all`);
    const pm = d?.metric || {};
    const pe = pm.peBasicExclExtraTTM || pm.peTTM;
    const mc = (pm.marketCapitalization || 0) * 1e6;
    if (pe && pe > 0 && pe < 600) return { ticker: peer, pe, mc };
  } catch (_) {}
 
  return null;
}
 
async function resolvePeerPE(ticker, targetPE, targetMC, crumbInfo) {
  try {
    let rawPeers = [];
    try {
      const pd = await fh(`/stock/peers?symbol=${ticker}`);
      if (Array.isArray(pd)) rawPeers = pd.filter(p => p !== ticker && /^[A-Z]{1,5}$/.test(p));
    } catch (_) {}
 
    if (PEER_MAP[ticker]) {
      rawPeers = [...new Set([...rawPeers, ...PEER_MAP[ticker]])].filter(p => p !== ticker);
    }
 
    rawPeers = rawPeers.slice(0, 12);
    if (rawPeers.length === 0) return null;
 
    // Limit concurrency to avoid AV rate limit — batch in groups of 3
    const results = [];
    for (let i = 0; i < rawPeers.length; i += 3) {
      const batch = rawPeers.slice(i, i + 3);
      const batchResults = await Promise.allSettled(batch.map(p => fetchPeerPE_single(p, crumbInfo)));
      results.push(...batchResults.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value));
    }
 
    if (results.length === 0) return null;
 
    // Market cap filter
    let comparables = results;
    const withMC = results.filter(c => c.mc > 0);
    if (withMC.length >= 3 && targetMC > 0) {
      const loR = targetMC > 500000 ? 0.07 : 0.12;
      const hiR = targetMC > 500000 ? 14   : 8;
      const filtered = withMC.filter(c => {
        const m = c.mc / 1e6;
        return m / targetMC >= loR && m / targetMC <= hiR;
      });
      if (filtered.length >= 2) comparables = [...filtered, ...results.filter(c => c.mc === 0)];
    }
 
    // Trim outliers
    if (comparables.length >= 5) {
      const sorted = [...comparables].sort((a, b) => a.pe - b.pe);
      const trim   = Math.max(1, Math.floor(sorted.length * 0.1));
      comparables  = sorted.slice(trim, sorted.length - trim);
    }
    if (comparables.length < 2) return null;
 
    const pes   = comparables.map(c => c.pe).sort((a, b) => a - b);
    const mid   = Math.floor(pes.length / 2);
    const medPE = pes.length % 2 === 0 ? (pes[mid - 1] + pes[mid]) / 2 : pes[mid];
    const avgPE = pes.reduce((a, b) => a + b, 0) / pes.length;
    const diff  = targetPE && targetPE > 0
      ? parseFloat(((targetPE - avgPE) / avgPE * 100).toFixed(1))
      : null;
 
    return {
      medianPE:  parseFloat(medPE.toFixed(1)),
      avgPE:     parseFloat(avgPE.toFixed(1)),
      peerCount: comparables.length,
      diff,
      peers: comparables.map(c => c.ticker),
    };
  } catch (_) { return null; }
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
 
function getRating(score) {
  if (score >= 5) return { label:'Strong Buy', color:'#14532d', bg:'#dcfce7', border:'#86efac' };
  if (score === 4) return { label:'Buy',        color:'#15803d', bg:'#f0fdf4', border:'#bbf7d0' };
  if (score === 3) return { label:'Watch',      color:'#92400e', bg:'#fffbeb', border:'#fde68a' };
  return                  { label:'Ignore',     color:'#6b7280', bg:'#f9fafb', border:'#d1d5db' };
}
 
function cleanExchange(raw) {
  if (!raw) return 'NYSE';
  const u = raw.toUpperCase();
  if (u.includes('NASDAQ')) return 'NASDAQ';
  if (u.includes('NYSE'))   return 'NYSE';
  if (u.includes('LSE') || u.includes('LONDON'))  return 'LSE';
  if (u.includes('TSX') || u.includes('TORONTO')) return 'TSX';
  return raw.split(/[\s,]/)[0].toUpperCase() || 'NYSE';
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Master fetch — one ticker
// ─────────────────────────────────────────────────────────────────────────────
 
async function fetchStockData(ticker, crumbInfo) {
  // Fire Finnhub primary calls + Alpha Vantage OVERVIEW simultaneously
  const [quoteR, profileR, metricsR, earningsR, yahooChartR, avOverviewR] =
    await Promise.allSettled([
      fh(`/quote?symbol=${ticker}`),
      fh(`/stock/profile2?symbol=${ticker}`),
      fh(`/stock/metric?symbol=${ticker}&metric=all`),
      fh(`/stock/earnings?symbol=${ticker}&limit=4`),
      yahooFetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`, crumbInfo),
      fetchAVOverview(ticker),   // Alpha Vantage OVERVIEW — EPS, PE, target, MA, 52w
    ]);
 
  const curPx     = quoteR.status     === 'fulfilled' ? quoteR.value?.c              : null;
  const m         = metricsR.status   === 'fulfilled' ? metricsR.value?.metric || {} : {};
  const avOv      = avOverviewR.status === 'fulfilled' ? avOverviewR.value            : null;
  const yahooChart = yahooChartR.status === 'fulfilled' ? yahooChartR.value           : null;
  const yhMeta    = yahooChart?.chart?.result?.[0]?.meta || {};
  const yahooCloses = yahooChart?.chart?.result?.[0]?.indicators?.quote?.[0]?.close
    ?.filter(c => c != null && !isNaN(c) && c > 0) || [];
 
  // Resolve all signals in parallel
  const [eps, ma50, curPE, { hi52, lo52 }, analystTarget, insiderData] = await Promise.all([
    resolveEPS(ticker, avOv, m, crumbInfo),
    resolve50dMA(ticker, avOv, crumbInfo),
    resolveCurrentPE(ticker, avOv, m, crumbInfo),
    resolve52w(ticker, avOv, m, yhMeta),
    resolveAnalystTarget(ticker, avOv, crumbInfo),
    fetchInsiderTransactions(ticker, curPx),
  ]);
 
  // Peer PE needs curPE — run after
  const peerPE = await resolvePeerPE(ticker, curPE, m.marketCapitalization || 0, crumbInfo);
 
  return {
    quote:    quoteR.status   === 'fulfilled' ? quoteR.value   : null,
    profile:  profileR.status === 'fulfilled' ? profileR.value : null,
    metrics:  metricsR.status === 'fulfilled' ? metricsR.value : null,
    earnings: earningsR.status === 'fulfilled' ? earningsR.value : null,
    hi52, lo52, curPE, eps, ma50, analystTarget, insiderData, peerPE,
  };
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Evaluate
// ─────────────────────────────────────────────────────────────────────────────
 
function evaluate(ticker, d) {
  const q     = d.quote   || {};
  const p     = d.profile || {};
  const curPx = q.c;
  if (!curPx) return null;
 
  const company  = p.name || ticker;
  const mc       = p.marketCapitalization ? p.marketCapitalization * 1e6 : 0;
  const mcs      = mc > 1e12 ? `$${(mc / 1e12).toFixed(2)}T`
                 : mc > 1e9  ? `$${(mc / 1e9).toFixed(1)}B`
                 : mc > 1e6  ? `$${(mc / 1e6).toFixed(0)}M` : '';
  const exchange = cleanExchange(p.exchange);
 
  // S1: EPS beat
  let s1 = { status:'neutral', value:'No data' };
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
  } catch (_) {}
 
  // S2: PE vs historical average
  let s2 = { status:'neutral', value:'No data' };
  try {
    const curPE = d.curPE;
    const eps   = d.eps;
    const hi    = d.hi52;
    const lo    = d.lo52;
    if (curPE && curPE > 0 && eps && eps !== 0 && hi && lo && hi > lo) {
      const midPrice = (hi + lo) / 2;
      const histPE   = midPrice / eps;
      if (histPE > 0 && histPE < 1000) {
        if      (curPE < histPE * 0.92) s2 = { status:'pass',    value:`PE ${curPE.toFixed(1)}x < hist ~${histPE.toFixed(0)}x` };
        else if (curPE > histPE * 1.08) s2 = { status:'fail',    value:`PE ${curPE.toFixed(1)}x > hist ~${histPE.toFixed(0)}x` };
        else                            s2 = { status:'neutral', value:`PE ${curPE.toFixed(1)}x ≈ hist ~${histPE.toFixed(0)}x` };
      }
    } else if (curPE && curPE > 0) {
      s2 = { status:'neutral', value:`PE ${curPE.toFixed(1)}x` };
    }
  } catch (_) {}
 
  // S3: Price vs 50d MA
  let s3 = { status:'neutral', value:'No data' };
  try {
    if (d.ma50 && d.ma50 > 0 && curPx) {
      const pct = ((curPx - d.ma50) / d.ma50 * 100).toFixed(1);
      s3 = curPx <= d.ma50
        ? { status:'pass', value:`$${curPx.toFixed(2)} ≤ MA $${d.ma50.toFixed(2)} (${pct}%)` }
        : { status:'fail', value:`$${curPx.toFixed(2)} > MA $${d.ma50.toFixed(2)} (+${pct}%)` };
    }
  } catch (_) {}
 
  // S4: Insider buying
  const { buys, sells, source } = d.insiderData || { buys:[], sells:[], source:null };
  const s4 = buildInsiderValue(buys, sells, source);
 
  // S5: Analyst target ≥ +25%
  let s5 = { status:'neutral', value:'No data' };
  try {
    const tgt = d.analystTarget;
    if (tgt && tgt > 0 && curPx) {
      const up = ((tgt - curPx) / curPx * 100).toFixed(1);
      s5 = parseFloat(up) >= 25
        ? { status:'pass', value:`Target $${tgt.toFixed(2)}, +${up}% upside` }
        : { status:'fail', value:`Target $${tgt.toFixed(2)}, +${up}% upside` };
    }
  } catch (_) {}
 
  // S6: PE vs peers
  let s6 = { status:'neutral', value:'No data' };
  try {
    const pp = d.peerPE;
    if (pp && pp.medianPE && pp.diff !== null) {
      if      (pp.diff < -8) s6 = { status:'pass',    value:`${Math.abs(pp.diff).toFixed(0)}% < peer avg ${pp.avgPE}x` };
      else if (pp.diff >  8) s6 = { status:'fail',    value:`${Math.abs(pp.diff).toFixed(0)}% > peer avg ${pp.avgPE}x` };
      else                   s6 = { status:'neutral', value:`In line, avg ${pp.avgPE}x` };
    } else if (pp?.medianPE) {
      s6 = { status:'neutral', value:`Peer avg ${pp.avgPE}x` };
    }
  } catch (_) {}
 
  const signals   = [s1, s2, s3, s4, s5, s6];
  const score     = signals.filter(s => s.status === 'pass').length;
  const SIG_NAMES = ['EPS beat','Low PE','Below 50d MA','Insider buying','Analyst upside','PE vs peers'];
  const passes    = signals.map((s, i) => s.status === 'pass' ? SIG_NAMES[i] : null).filter(Boolean);
  const fails     = signals.map((s, i) => s.status === 'fail' ? SIG_NAMES[i] : null).filter(Boolean);
 
  let summary;
  if      (score >= 5)  summary = `Strong value candidate — ${score}/6 signals pass. Strengths: ${passes.join(', ')}.`;
  else if (score === 4) summary = `Good signals (4/6). Passes: ${passes.join(', ')}.`;
  else if (score === 3) summary = `Moderate signals (3/6). Passes: ${passes.join(', ')}.`;
  else if (score > 0)   summary = `Weak signals (${score}/6). Fails: ${fails.join(', ')}.`;
  else                  summary = `No signals pass. Fails: ${fails.join(', ')}.`;
 
  return {
    ticker, company, exchange,
    price:     `$${curPx.toFixed(2)}`,
    change:    q.dp != null ? `${q.dp > 0 ? '+' : ''}${q.dp.toFixed(2)}%` : null,
    marketCap: mcs,
    score, signals, summary,
    rating:    getRating(score),
    peerPE:    d.peerPE || null,
    updatedAt: new Date().toISOString(),
  };
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────
 
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error:'Method not allowed' });
  if (!FINNHUB_KEY)          return res.status(500).json({ error:'FINNHUB_KEY not set' });
 
  const { tickers } = req.body;
  if (!Array.isArray(tickers) || tickers.length === 0)
    return res.status(400).json({ error:'tickers array required' });
 
  const cleaned = tickers.slice(0, 20).map(t => t.toUpperCase().trim());
 
  // Fetch Yahoo crumb ONCE for the entire batch — all tickers share it
  const crumbInfo = await getYahooCrumb();
 
  // Clear per-request peer PE cache
  Object.keys(AV_PE_CACHE).forEach(k => delete AV_PE_CACHE[k]);
 
  const results = {};
  await Promise.allSettled(cleaned.map(async ticker => {
    try {
      const raw = await fetchStockData(ticker, crumbInfo);
      const ev  = evaluate(ticker, raw);
      results[ticker] = ev || { ticker, error:'No quote data' };
    } catch (e) {
      results[ticker] = { ticker, error: e.message };
    }
  }));
 
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
  return res.status(200).json({ results, fetchedAt: new Date().toISOString() });
}
 
