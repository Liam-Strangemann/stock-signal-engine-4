// pages/api/analyse-signal.js
//
// Re-fetches a single signal for a single ticker.
// POST { ticker: 'AAPL', signalIndex: 5 }
// Returns { signal: { status, value } }
//
// Signal indices match the order in the main analyse.js evaluate():
//   0 = EPS beat
//   1 = PE vs hist avg
//   2 = Price vs 50d MA
//   3 = Insider buying
//   4 = Analyst upside
//   5 = PE vs peers
 
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const AV_KEY      = process.env.AV_KEY;
const FH          = 'https://finnhub.io/api/v1';
const AV          = 'https://www.alphavantage.co/query';
 
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
 
// ── Core fetchers ─────────────────────────────────────────────────────────────
 
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
 
async function getYahooCrumb() {
  try {
    const home = await fetch('https://finance.yahoo.com/', {
      headers: { 'User-Agent': BROWSER['User-Agent'], 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow', signal: AbortSignal.timeout(8000),
    });
    const setCookie = home.headers.get('set-cookie') || '';
    const cookies = setCookie.split(',').map(c => c.split(';')[0].trim()).filter(c => c.includes('=')).join('; ');
    for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
      try {
        const cr = await fetch(`${base}/v1/test/getcrumb`, {
          headers: { 'User-Agent': BROWSER['User-Agent'], 'Accept': '*/*', 'Cookie': cookies },
          signal: AbortSignal.timeout(6000),
        });
        if (cr.ok) {
          const text = await cr.text();
          if (text && text.length < 50 && !text.startsWith('{')) return { crumb: text.trim(), cookies };
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
 
async function fetchAV(ticker) {
  if (!AV_KEY) return null;
  try {
    const r = await fetch(`${AV}?function=OVERVIEW&symbol=${ticker}&apikey=${AV_KEY}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d?.Symbol || d?.Information || d?.Note) return null;
    return d;
  } catch (_) { return null; }
}
 
// ── stockanalysis.com ─────────────────────────────────────────────────────────
 
async function fetchStockAnalysis(ticker) {
  try {
    const html = await getPage(`https://stockanalysis.com/stocks/${ticker.toLowerCase()}/`);
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    const data = JSON.parse(m[1]);
    const props = data?.props?.pageProps;
    const quote = props?.data?.quote || props?.quote || null;
    if (quote) return quote;
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
 
// ── Zacks ─────────────────────────────────────────────────────────────────────
 
async function fetchZacks(ticker) {
  try {
    return await getPage(`https://www.zacks.com/stock/quote/${ticker.toUpperCase()}`);
  } catch (_) { return null; }
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
 
// ── SEC EDGAR ─────────────────────────────────────────────────────────────────
 
async function getSecCIK(ticker) {
  try {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': 'signal-engine/1.0 admin@example.com' },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const j = await r.json();
      for (const e of Object.values(j)) {
        if (e.ticker?.toUpperCase() === ticker.toUpperCase()) {
          return String(e.cik_str).padStart(10, '0');
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
 
// ── Format helpers ────────────────────────────────────────────────────────────
 
function fmt$M(n) { return !n||n===0?null:n>=1e9?`$${(n/1e9).toFixed(2)}B`:n>=1e6?`$${(n/1e6).toFixed(2)}M`:n>=1e3?`$${(n/1e3).toFixed(0)}K`:`$${n.toFixed(0)}`; }
function fmtSh(n) { return !n||n===0?null:n>=1e6?`${(n/1e6).toFixed(2)}M shares`:n>=1e3?`${(n/1e3).toFixed(1)}K shares`:`${n.toLocaleString()} shares`; }
function timeAgo(ds) {
  if (!ds) return null;
  const d = new Date(ds); if (isNaN(d)) return null;
  const days = Math.floor((Date.now()-d)/86400000);
  return days===0?'today':days===1?'1d ago':days<7?`${days}d ago`:days<14?'1w ago':days<30?`${Math.floor(days/7)}w ago`:`${Math.floor(days/30)}mo ago`;
}
 
// ── Peer PE map ───────────────────────────────────────────────────────────────
 
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
  KO:['PEP','MDLZ','MNST','KHC'],               PEP:['KO','MDLZ','MNST','KHC'],
  PM:['MO','BTI'],                               MO:['PM','BTI'],
  T:['VZ','TMUS','CMCSA','CHTR'],               VZ:['T','TMUS','CMCSA','CHTR'],
  TMUS:['T','VZ','CMCSA'],                       CAT:['DE','HON','EMR','ITW','PH'],
  DE:['CAT','AGCO','HON'],                       HON:['CAT','EMR','ITW','ROK','ETN'],
  GE:['HON','RTX','EMR','ETN'],                 RTX:['LMT','NOC','GD','BA'],
  LMT:['NOC','RTX','GD','BA'],                  UPS:['FDX','XPO','ODFL'],
  FDX:['UPS','XPO','ODFL'],                      IBM:['MSFT','ORCL','HPE','ACN'],
  NEE:['DUK','SO','AEP','EXC','D'],             AMT:['PLD','EQIX','CCI','SPG','O'],
  NFLX:['DIS','WBD','PARA','ROKU'],             DIS:['NFLX','WBD','PARA','CMCSA'],
  MA:['V','PYPL','AXP','FIS'],                  V:['MA','PYPL','AXP','FIS'],
  SPGI:['MCO','ICE','CME','MSCI'],
};
 
// ── Signal 0: EPS beat ────────────────────────────────────────────────────────
 
async function resolveSignal0(ticker) {
  try {
    const d = await fh(`/stock/earnings?symbol=${ticker}&limit=4`);
    const earns = Array.isArray(d) ? d : [];
    if (earns.length > 0) {
      const e = earns[0], diff = e.actual - e.estimate, beat = diff >= 0;
      const ds = Math.abs(diff) < 0.005 ? 'in-line' : beat ? `+$${Math.abs(diff).toFixed(2)}` : `-$${Math.abs(diff).toFixed(2)}`;
      return { status: beat ? 'pass' : 'fail', value: beat ? `Beat by ${ds}` : `Missed ${ds}` };
    }
  } catch (_) {}
  return { status: 'neutral', value: 'No data' };
}
 
// ── Signal 1: PE vs hist avg ──────────────────────────────────────────────────
 
async function resolveSignal1(ticker, crumbInfo) {
  const avData = await fetchAV(ticker);
 
  // Get current PE
  let curPE = null;
  const avPE = parseFloat(avData?.PERatio);
  if (!isNaN(avPE) && avPE > 0 && avPE < 600) curPE = avPE;
  if (!curPE) {
    try {
      const d = await fh(`/stock/metric?symbol=${ticker}&metric=all`);
      const p = d?.metric?.peBasicExclExtraTTM || d?.metric?.peTTM;
      if (p > 0 && p < 600) curPE = p;
    } catch (_) {}
  }
  if (!curPE) {
    const j = await yahooFetch(`/v8/finance/chart/${ticker}?interval=1d&range=5d`, crumbInfo);
    const p = j?.chart?.result?.[0]?.meta?.trailingPE;
    if (p > 0 && p < 600) curPE = p;
  }
 
  // Get EPS
  let eps = null;
  const avEPS = parseFloat(avData?.EPS);
  if (!isNaN(avEPS) && avEPS !== 0) eps = avEPS;
  if (!eps) {
    try {
      const d = await fh(`/stock/metric?symbol=${ticker}&metric=all`);
      const e = d?.metric?.epsTTM || d?.metric?.epsBasicExclExtraAnnual;
      if (e && e !== 0) eps = e;
    } catch (_) {}
  }
  if (!eps) {
    try {
      const j = await yahooFetch(`/v10/finance/quoteSummary/${ticker}?modules=defaultKeyStatistics`, crumbInfo);
      const e = j?.quoteSummary?.result?.[0]?.defaultKeyStatistics?.trailingEps?.raw;
      if (e != null && e !== 0) eps = e;
    } catch (_) {}
  }
  if (!eps) eps = await fetchSecEPS(ticker);
 
  // Get 52w hi/lo
  let hi52 = null, lo52 = null;
  try {
    const d = await fh(`/stock/metric?symbol=${ticker}&metric=all`);
    hi52 = d?.metric?.['52WeekHigh'] || null;
    lo52 = d?.metric?.['52WeekLow']  || null;
  } catch (_) {}
  if (!hi52 || !lo52) {
    const avHi = parseFloat(avData?.['52WeekHigh']);
    const avLo = parseFloat(avData?.['52WeekLow']);
    if (!isNaN(avHi) && avHi > 0) hi52 = avHi;
    if (!isNaN(avLo) && avLo > 0) lo52 = avLo;
  }
 
  if (curPE && curPE > 0 && eps && eps !== 0 && hi52 && lo52 && hi52 > lo52) {
    const histPE = (hi52 + lo52) / 2 / eps;
    if (histPE > 0 && histPE < 1000) {
      if      (curPE < histPE * 0.92) return { status: 'pass',    value: `PE ${curPE.toFixed(1)}x < hist ~${histPE.toFixed(0)}x` };
      else if (curPE > histPE * 1.08) return { status: 'fail',    value: `PE ${curPE.toFixed(1)}x > hist ~${histPE.toFixed(0)}x` };
      else                            return { status: 'neutral',  value: `PE ${curPE.toFixed(1)}x ≈ hist ~${histPE.toFixed(0)}x` };
    }
  } else if (curPE && curPE > 0) {
    return { status: 'neutral', value: `PE ${curPE.toFixed(1)}x` };
  }
  return { status: 'neutral', value: 'No data' };
}
 
// ── Signal 2: Price vs 50d MA ─────────────────────────────────────────────────
 
function compute50dMA(closes) {
  if (!Array.isArray(closes)) return null;
  const v = closes.filter(c => c != null && !isNaN(c) && c > 0);
  if (v.length < 20) return null;
  const sl = v.slice(-50);
  return sl.reduce((a, b) => a + b, 0) / sl.length;
}
 
async function resolveSignal2(ticker, crumbInfo) {
  let curPx = null;
  try { const q = await fh(`/quote?symbol=${ticker}`); curPx = q?.c || null; } catch (_) {}
 
  let ma50 = null;
  const avData = await fetchAV(ticker);
  const av = parseFloat(avData?.['50DayMovingAverage']);
  if (av > 0 && !isNaN(av)) ma50 = av;
 
  if (!ma50) {
    const j = await yahooFetch(`/v8/finance/chart/${ticker}?interval=1d&range=1y`, crumbInfo);
    const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c => c != null && !isNaN(c) && c > 0) || [];
    const m = compute50dMA(closes);
    if (m > 0) ma50 = m;
  }
 
  if (!ma50) {
    try {
      const to = Math.floor(Date.now() / 1000), from = to - 90 * 86400;
      const d = await fh(`/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${to}`);
      if (d?.s === 'ok' && Array.isArray(d.c) && d.c.length >= 20) {
        const m = compute50dMA(d.c);
        if (m > 0) ma50 = m;
      }
    } catch (_) {}
  }
 
  if (!ma50) {
    try {
      const j = await yahooFetch(`/v10/finance/quoteSummary/${ticker}?modules=summaryDetail`, crumbInfo);
      const m = j?.quoteSummary?.result?.[0]?.summaryDetail?.fiftyDayAverage?.raw;
      if (m > 0) ma50 = m;
    } catch (_) {}
  }
 
  if (ma50 && ma50 > 0 && curPx) {
    const pct = ((curPx - ma50) / ma50 * 100).toFixed(1);
    return curPx <= ma50
      ? { status: 'pass', value: `$${curPx.toFixed(2)} ≤ MA $${ma50.toFixed(2)} (${pct}%)` }
      : { status: 'fail', value: `$${curPx.toFixed(2)} > MA $${ma50.toFixed(2)} (+${pct}%)` };
  }
  return { status: 'neutral', value: 'No data' };
}
 
// ── Signal 3: Insider buying ──────────────────────────────────────────────────
 
async function resolveSignal3(ticker) {
  let curPx = null;
  try { const q = await fh(`/quote?symbol=${ticker}`); curPx = q?.c || null; } catch (_) {}
 
  const now = Math.floor(Date.now() / 1000), ago30 = now - 30 * 86400;
  const from = new Date(ago30 * 1000).toISOString().slice(0, 10);
  const to   = new Date(now * 1000).toISOString().slice(0, 10);
  const cut  = new Date(ago30 * 1000);
 
  let buys = [], sells = [], source = null;
 
  try {
    const d = await fh(`/stock/insider-transactions?symbol=${ticker}&from=${from}&to=${to}`);
    const txns = d?.data || [];
    buys  = txns.filter(t => t.transactionCode === 'P');
    sells = txns.filter(t => t.transactionCode === 'S');
    if (buys.length > 0 || sells.length > 0) source = 'finnhub';
  } catch (_) {}
 
  if (!source) {
    try {
      const r = await fetch(
        `https://openinsider.com/screener?s=${ticker}&fd=-30&td=0&xs=1&vl=0&grp=0&cnt=20&action=1`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(7000) }
      );
      if (r.ok) {
        const html = await r.text();
        const rows = [...html.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/gi)];
        buys = []; sells = [];
        for (const row of rows) {
          const cells = [...row[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => c[1].replace(/<[^>]+>/g, '').trim());
          if (cells.length < 10) continue;
          const [, dateStr, , , type, , , , sharesRaw, valueRaw] = cells;
          if (!dateStr || !type) continue;
          const txDate = new Date(dateStr);
          if (isNaN(txDate) || txDate < cut) continue;
          const shares = parseInt((sharesRaw || '').replace(/[^0-9]/g, '')) || 0;
          const value  = parseInt((valueRaw  || '').replace(/[^0-9]/g, '')) || 0;
          const entry  = { transactionDate: dateStr, share: shares, value, transactionPrice: shares > 0 ? value / shares : curPx };
          if (/P\s*-\s*Purchase/i.test(type)) buys.push(entry);
          else if (/S\s*-\s*Sale/i.test(type)) sells.push(entry);
        }
        if (buys.length > 0 || sells.length > 0) source = 'openinsider';
      }
    } catch (_) {}
  }
 
  if (buys.length > 0) {
    const sh  = buys.reduce((s, t) => s + (t.share || 0), 0);
    const val = buys.reduce((s, t) => s + (t.value || Math.abs((t.share || 0) * (t.transactionPrice || 0))), 0);
    const parts = [`${buys.length} buy${buys.length > 1 ? 's' : ''}`];
    const sv = fmtSh(sh); if (sv) parts.push(sv);
    const dv = fmt$M(val); if (dv) parts.push(dv);
    const dates = buys.map(t => t.transactionDate).filter(Boolean).sort().reverse();
    const rc = dates[0] ? timeAgo(dates[0]) : null; if (rc) parts.push(rc);
    return { status: 'pass', value: parts.join(' · ') };
  }
  if (sells.length > 0) {
    const sh  = sells.reduce((s, t) => s + (t.share || 0), 0);
    const val = sells.reduce((s, t) => s + (t.value || Math.abs((t.share || 0) * (t.transactionPrice || 0))), 0);
    const parts = [`${sells.length} sell${sells.length > 1 ? 's' : ''}, no buys`];
    const sv = fmtSh(sh); if (sv) parts.push(sv);
    const dv = fmt$M(val); if (dv) parts.push(dv);
    const dates = sells.map(t => t.transactionDate).filter(Boolean).sort().reverse();
    const rc = dates[0] ? timeAgo(dates[0]) : null; if (rc) parts.push(rc);
    return { status: 'fail', value: parts.join(' · ') };
  }
  return { status: 'neutral', value: source ? 'No activity (30d)' : 'No data' };
}
 
// ── Signal 4: Analyst target ──────────────────────────────────────────────────
 
async function resolveSignal4(ticker, crumbInfo) {
  let curPx = null;
  try { const q = await fh(`/quote?symbol=${ticker}`); curPx = q?.c || null; } catch (_) {}
 
  let target = null;
  const avData = await fetchAV(ticker);
  const avT = parseFloat(avData?.AnalystTargetPrice);
  if (!isNaN(avT) && avT > 0) target = avT;
 
  if (!target) {
    try {
      const d = await fh(`/stock/price-target?symbol=${ticker}`);
      const t = d?.targetMedian || d?.targetMean;
      if (t > 0) target = t;
    } catch (_) {}
  }
 
  if (!target) {
    try {
      const j = await yahooFetch(`/v10/finance/quoteSummary/${ticker}?modules=financialData`, crumbInfo);
      const fd = j?.quoteSummary?.result?.[0]?.financialData;
      const t  = fd?.targetMedianPrice?.raw || fd?.targetMeanPrice?.raw;
      if (t > 0) target = t;
    } catch (_) {}
  }
 
  if (!target) {
    try {
      const html = await getPage(`https://stockanalysis.com/stocks/${ticker.toLowerCase()}/forecast/`);
      const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (m) {
        const d = JSON.parse(m[1]);
        const ppts = d?.props?.pageProps;
        const t = ppts?.data?.priceTarget || ppts?.priceTarget;
        if (t > 0) target = t;
      }
      if (!target) {
        for (const p of [
          /price\s+target[^$<]*\$\s*([\d,]+\.?\d*)/i,
          /consensus[^$<]*\$\s*([\d,]+\.?\d*)/i,
          /target\s+price[^$<]*\$\s*([\d,]+\.?\d*)/i,
        ]) {
          const match = html.match(p);
          if (match) { const v = parseFloat(match[1].replace(/,/g, '')); if (v > 0 && v < 100000) { target = v; break; } }
        }
      }
    } catch (_) {}
  }
 
  if (!target) {
    try {
      const html = await fetchZacks(ticker);
      const t = zacksExtractTarget(html);
      if (t > 0) target = t;
    } catch (_) {}
  }
 
  if (target && target > 0 && curPx) {
    const up = ((target - curPx) / curPx * 100).toFixed(1);
    return parseFloat(up) >= 25
      ? { status: 'pass', value: `Target $${target.toFixed(2)}, +${up}% upside` }
      : { status: 'fail', value: `Target $${target.toFixed(2)}, +${up}% upside` };
  }
  return { status: 'neutral', value: 'No data' };
}
 
// ── Signal 5: PE vs peers ─────────────────────────────────────────────────────
 
async function getPeerPE(peer, crumbInfo) {
  try {
    const j = await yahooFetch(`/v8/finance/chart/${peer}?interval=1d&range=5d`, crumbInfo);
    const pe = j?.chart?.result?.[0]?.meta?.trailingPE;
    const mc = j?.chart?.result?.[0]?.meta?.marketCap || 0;
    if (pe > 0 && pe < 600) return { ticker: peer, pe, mc };
  } catch (_) {}
 
  try {
    const d = await fh(`/stock/metric?symbol=${peer}&metric=all`);
    const pe = d?.metric?.peBasicExclExtraTTM || d?.metric?.peTTM;
    const mc = (d?.metric?.marketCapitalization || 0) * 1e6;
    if (pe > 0 && pe < 600) return { ticker: peer, pe, mc };
  } catch (_) {}
 
  if (AV_KEY) {
    try {
      const d = await fetchAV(peer);
      const pe = parseFloat(d?.PERatio);
      const mc = parseFloat(d?.MarketCapitalization) || 0;
      if (!isNaN(pe) && pe > 0 && pe < 600) return { ticker: peer, pe, mc };
    } catch (_) {}
  }
 
  try {
    const sa = await fetchStockAnalysis(peer);
    const pe = saExtract(sa, ['pe', 'peRatio', 'trailingPE']);
    const mc = saExtract(sa, ['marketCap', 'marketCapitalization']) || 0;
    if (pe > 0 && pe < 600) return { ticker: peer, pe, mc };
  } catch (_) {}
 
  return null;
}
 
async function resolveSignal5(ticker, crumbInfo) {
  // Get current PE for this ticker
  let curPE = null;
  try {
    const j = await yahooFetch(`/v8/finance/chart/${ticker}?interval=1d&range=5d`, crumbInfo);
    const pe = j?.chart?.result?.[0]?.meta?.trailingPE;
    if (pe > 0 && pe < 600) curPE = pe;
  } catch (_) {}
  if (!curPE) {
    try {
      const d = await fh(`/stock/metric?symbol=${ticker}&metric=all`);
      const pe = d?.metric?.peBasicExclExtraTTM || d?.metric?.peTTM;
      if (pe > 0 && pe < 600) curPE = pe;
    } catch (_) {}
  }
 
  // Get peer list
  let peerList = [];
  try {
    const pd = await fh(`/stock/peers?symbol=${ticker}`);
    if (Array.isArray(pd)) peerList = pd.filter(p => p !== ticker && /^[A-Z]{1,5}$/.test(p));
  } catch (_) {}
  if (PEERS[ticker]) peerList = [...new Set([...peerList, ...PEERS[ticker]])].filter(p => p !== ticker);
  peerList = peerList.slice(0, 10);
  if (!peerList.length) return { status: 'neutral', value: 'No data' };
 
  const all = [];
  for (let i = 0; i < peerList.length; i += 2) {
    const batch = peerList.slice(i, i + 2);
    const res = await Promise.allSettled(batch.map(p => getPeerPE(p, crumbInfo)));
    all.push(...res.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value));
  }
  if (!all.length) return { status: 'neutral', value: 'No data' };
 
  let comps = all;
  if (comps.length >= 5) {
    const s = [...comps].sort((a, b) => a.pe - b.pe), t = Math.max(1, Math.floor(s.length * 0.1));
    comps = s.slice(t, s.length - t);
  }
  if (comps.length < 2) return { status: 'neutral', value: 'No data' };
 
  const pes = comps.map(c => c.pe).sort((a, b) => a - b);
  const avg = pes.reduce((a, b) => a + b, 0) / pes.length;
  const diff = curPE && curPE > 0 ? parseFloat(((curPE - avg) / avg * 100).toFixed(1)) : null;
 
  if (diff === null) return { status: 'neutral', value: `Peer avg ${avg.toFixed(1)}x` };
  if (diff < -8) return { status: 'pass',    value: `${Math.abs(diff).toFixed(0)}% < peer avg ${avg.toFixed(1)}x` };
  if (diff > 8)  return { status: 'fail',    value: `${Math.abs(diff).toFixed(0)}% > peer avg ${avg.toFixed(1)}x` };
  return           { status: 'neutral',  value: `In line, avg ${avg.toFixed(1)}x` };
}
 
// ── Handler ───────────────────────────────────────────────────────────────────
 
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!FINNHUB_KEY)          return res.status(500).json({ error: 'FINNHUB_KEY not set' });
 
  const { ticker, signalIndex } = req.body;
  if (!ticker || signalIndex === undefined) return res.status(400).json({ error: 'ticker and signalIndex required' });
 
  const t = ticker.toUpperCase().trim();
  const i = parseInt(signalIndex);
  if (isNaN(i) || i < 0 || i > 5) return res.status(400).json({ error: 'signalIndex must be 0–5' });
 
  const crumbInfo = await getYahooCrumb();
 
  let signal;
  try {
    switch (i) {
      case 0: signal = await resolveSignal0(t); break;
      case 1: signal = await resolveSignal1(t, crumbInfo); break;
      case 2: signal = await resolveSignal2(t, crumbInfo); break;
      case 3: signal = await resolveSignal3(t); break;
      case 4: signal = await resolveSignal4(t, crumbInfo); break;
      case 5: signal = await resolveSignal5(t, crumbInfo); break;
      default: signal = { status: 'neutral', value: 'No data' };
    }
  } catch (e) {
    signal = { status: 'neutral', value: 'No data' };
  }
 
  return res.status(200).json({ signal });
}
 
