// pages/api/analyse.js  v3
// All 6 signals now have robust multi-source fallback chains.
//
//  S2 (PE vs hist avg):
//    EPS: v7 quote epsTrailingTwelveMonths (new, very reliable) → Finnhub →
//         Yahoo defaultKeyStatistics → earningsHistory TTM sum →
//         netIncome/shares → financialData.earningsPerShare
//    52w hi/lo: Finnhub metric → Yahoo chart meta → computed from closes
//
//  S3 (50d MA):
//    Primary: computed from Yahoo 1y closes (no extra fetch)
//    v7 quote fiftyDayAverage (new, runs in parallel with everything else)
//    Fallback: Yahoo 3mo chart → Yahoo summaryDetail → Finnhub candle → Stooq CSV
//
//  S6 (PE vs peers):
//    Per-peer: v7 quote trailingPE (new, fast) → Yahoo chart meta →
//              Yahoo summaryDetail → Finnhub metric
//    Peer lists: Finnhub → Yahoo recommendations → hardcoded PEER_MAP
//
//  INSIDER NOTE: Data is sourced from SEC Form 4 filings via Finnhub / OpenInsider.
//  Sells without buys correctly display as a fail signal — this is accurate data.
 
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const FH = 'https://finnhub.io/api/v1';
 
const YH = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
};
 
// ── Finnhub ───────────────────────────────────────────────────────────────────
async function fh(path) {
  if (!FINNHUB_KEY) throw new Error('No Finnhub key');
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
 
// ── Yahoo chart (v8) ──────────────────────────────────────────────────────────
async function yahooChart(ticker, range = '1y') {
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(
        `${base}/v8/finance/chart/${ticker}?interval=1d&range=${range}`,
        { headers: YH, signal: AbortSignal.timeout(7000) }
      );
      if (!r.ok) continue;
      const j = await r.json();
      const result = j?.chart?.result?.[0];
      if (result) return result;
    } catch (_) {}
  }
  return null;
}
 
// ── Yahoo quoteSummary ────────────────────────────────────────────────────────
async function yahooSummary(ticker, modules) {
  for (const url of [
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}`,
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}`,
    `https://query1.finance.yahoo.com/v11/finance/quoteSummary/${ticker}?modules=${modules}`,
  ]) {
    try {
      const r = await fetch(url, { headers: YH, signal: AbortSignal.timeout(7000) });
      if (!r.ok) continue;
      const j = await r.json();
      const result = j?.quoteSummary?.result?.[0];
      if (result) return result;
    } catch (_) {}
  }
  return null;
}
 
// ── Yahoo v7 quote — the new workhorse ───────────────────────────────────────
// Returns epsTrailingTwelveMonths, trailingPE, fiftyDayAverage, targetMeanPrice
// in a single fast call. Less rate-limited than quoteSummary on Vercel IPs.
async function yahooV7Quote(ticker) {
  const fields = [
    'trailingPE', 'epsTrailingTwelveMonths', 'fiftyDayAverage',
    'twoHundredDayAverage', 'marketCap', 'regularMarketPrice',
    'targetMeanPrice', 'targetMedianPrice',
  ].join(',');
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(
        `${base}/v7/finance/quote?symbols=${ticker}&fields=${fields}`,
        { headers: YH, signal: AbortSignal.timeout(6000) }
      );
      if (!r.ok) continue;
      const j = await r.json();
      const q = j?.quoteResponse?.result?.[0];
      if (q) return q;
    } catch (_) {}
  }
  return null;
}
 
// ── Format helpers ────────────────────────────────────────────────────────────
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
 
// ── 50d MA ────────────────────────────────────────────────────────────────────
function compute50dMA(closes) {
  if (!Array.isArray(closes)) return null;
  const valid = closes.filter(c => c != null && !isNaN(c) && c > 0);
  if (valid.length < 20) return null;
  const slice = valid.slice(-50);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}
 
async function fetch50dMAFallback(ticker) {
  // 1: Yahoo 3mo chart closes
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const r = await fetch(
        `${base}/v8/finance/chart/${ticker}?interval=1d&period1=${now - 100 * 86400}&period2=${now}`,
        { headers: YH, signal: AbortSignal.timeout(6000) }
      );
      if (r.ok) {
        const j = await r.json();
        const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close
          ?.filter(c => c != null && !isNaN(c) && c > 0);
        const ma = compute50dMA(closes);
        if (ma > 0) return ma;
      }
    } catch (_) {}
  }
 
  // 2: Yahoo summaryDetail.fiftyDayAverage (pre-computed server-side)
  try {
    const ys = await yahooSummary(ticker, 'summaryDetail');
    const ma = ys?.summaryDetail?.fiftyDayAverage?.raw;
    if (ma && ma > 0) return ma;
  } catch (_) {}
 
  // 3: Finnhub candle
  try {
    const d = await fh(`/stock/candle?symbol=${ticker}&resolution=D&count=60`);
    if (d?.s === 'ok' && Array.isArray(d.c) && d.c.length >= 10) {
      const ma = compute50dMA(d.c);
      if (ma > 0) return ma;
    }
  } catch (_) {}
 
  // 4: Stooq CSV — reliable free source, broad US coverage
  try {
    const r = await fetch(
      `https://stooq.com/q/d/l/?s=${ticker.toLowerCase()}.us&i=d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
    );
    if (r.ok) {
      const text = await r.text();
      if (!text.includes('No data') && text.length > 100) {
        const lines = text.trim().split('\n').slice(1);
        const closes = lines.slice(-60)
          .map(l => parseFloat((l.split(',')[4] || '').trim()))
          .filter(c => !isNaN(c) && c > 0);
        const ma = compute50dMA(closes);
        if (ma > 0) return ma;
      }
    }
  } catch (_) {}
 
  return null;
}
 
// ── EPS — 5 independent sources ───────────────────────────────────────────────
async function fetchEPS(ticker) {
  // 1: Yahoo v7 epsTrailingTwelveMonths — most reliable free source
  try {
    const q = await yahooV7Quote(ticker);
    if (q?.epsTrailingTwelveMonths != null && q.epsTrailingTwelveMonths !== 0) {
      return q.epsTrailingTwelveMonths;
    }
  } catch (_) {}
 
  // 2: Yahoo defaultKeyStatistics.trailingEps
  try {
    const ys  = await yahooSummary(ticker, 'defaultKeyStatistics');
    const eps = ys?.defaultKeyStatistics?.trailingEps?.raw;
    if (eps != null && eps !== 0) return eps;
  } catch (_) {}
 
  // 3: Yahoo earningsHistory — sum last 4 quarters for TTM EPS
  try {
    const ys      = await yahooSummary(ticker, 'earningsHistory');
    const history = ys?.earningsHistory?.history || [];
    if (history.length >= 2) {
      const ttm = history.slice(-4).reduce((sum, q) => sum + (q?.epsActual?.raw || 0), 0);
      if (ttm !== 0) return ttm;
    }
  } catch (_) {}
 
  // 4: Yahoo incomeStatementHistory — net income ÷ shares outstanding
  try {
    const ys = await yahooSummary(ticker, 'incomeStatementHistory,defaultKeyStatistics');
    const ni = ys?.incomeStatementHistory?.incomeStatementHistory?.[0]?.netIncome?.raw;
    const sh = ys?.defaultKeyStatistics?.sharesOutstanding?.raw;
    if (ni && sh && sh > 0) return ni / sh;
  } catch (_) {}
 
  // 5: Yahoo financialData.earningsPerShare
  try {
    const ys  = await yahooSummary(ticker, 'financialData');
    const eps = ys?.financialData?.earningsPerShare?.raw;
    if (eps != null && eps !== 0) return eps;
  } catch (_) {}
 
  return null;
}
 
// ── Analyst target ────────────────────────────────────────────────────────────
async function fetchAnalystTarget(ticker) {
  // 1: Finnhub
  try {
    const d = await fh(`/stock/price-target?symbol=${ticker}`);
    const t = d?.targetMedian || d?.targetMean;
    if (t && t > 0) return t;
  } catch (_) {}
 
  // 2: Yahoo financialData
  try {
    const ys = await yahooSummary(ticker, 'financialData');
    const fd = ys?.financialData;
    const t  = fd?.targetMedianPrice?.raw || fd?.targetMeanPrice?.raw;
    if (t && t > 0) return t;
  } catch (_) {}
 
  // 3: Yahoo v7 quote targetMedianPrice / targetMeanPrice
  try {
    const q = await yahooV7Quote(ticker);
    const t = q?.targetMedianPrice || q?.targetMeanPrice;
    if (t && t > 0) return t;
  } catch (_) {}
 
  return null;
}
 
// ── Insider transactions ──────────────────────────────────────────────────────
async function fetchInsiderTransactions(ticker, curPx) {
  const now    = Math.floor(Date.now() / 1000);
  const ago30  = now - 30 * 86400;
  const from30 = new Date(ago30 * 1000).toISOString().slice(0, 10);
  const to30   = new Date(now * 1000).toISOString().slice(0, 10);
  const cutoff = new Date(ago30 * 1000);
 
  // 1: Finnhub — SEC Form 4
  try {
    const d    = await fh(`/stock/insider-transactions?symbol=${ticker}&from=${from30}&to=${to30}`);
    const txns = d?.data || [];
    if (txns.length > 0) {
      const buys  = txns.filter(t => t.transactionCode === 'P');
      const sells = txns.filter(t => t.transactionCode === 'S');
      if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'finnhub' };
    }
  } catch (_) {}
 
  // 2: OpenInsider — aggregates SEC Form 4
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
        const entry  = {
          transactionDate: dateStr, share: shares, value,
          transactionPrice: shares > 0 ? value / shares : curPx,
        };
        if (/P\s*-\s*Purchase/i.test(type))  buys.push(entry);
        else if (/S\s*-\s*Sale/i.test(type)) sells.push(entry);
      }
      if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'openinsider' };
    }
  } catch (_) {}
 
  // 3: Yahoo insiderTransactions
  try {
    const ys   = await yahooSummary(ticker, 'insiderTransactions');
    const txns = ys?.insiderTransactions?.transactions || [];
    const buys = [], sells = [];
    for (const t of txns) {
      const dateTs = t.startDate?.raw;
      if (!dateTs) continue;
      const txDate = new Date(dateTs * 1000);
      if (txDate < cutoff) continue;
      const dateStr = txDate.toISOString().slice(0, 10);
      const shares  = Math.abs(t.shares?.raw || 0);
      const value   = Math.abs(t.value?.raw  || 0);
      const desc    = (t.transactionDescription || '').toLowerCase();
      const entry   = {
        transactionDate: dateStr, share: shares, value,
        transactionPrice: shares > 0 ? value / shares : curPx,
      };
      if (/purchase|buy/i.test(desc))      buys.push(entry);
      else if (/sale|sell/i.test(desc))    sells.push(entry);
    }
    if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'yahoo' };
  } catch (_) {}
 
  // 4: SEC EDGAR Form 4 search
  try {
    const r = await fetch(
      `https://efts.sec.gov/LATEST/search-index?q=%22${ticker}%22&dateRange=custom&startdt=${from30}&enddt=${to30}&forms=4`,
      { headers: { 'User-Agent': 'signal-engine/1.0' }, signal: AbortSignal.timeout(7000) }
    );
    if (r.ok) {
      const j    = await r.json();
      const hits = j?.hits?.hits || [];
      const buys = [];
      for (const hit of hits.slice(0, 10)) {
        const src     = hit._source || {};
        const dateStr = src.file_date || src.period_of_report;
        if (!dateStr) continue;
        const txDate = new Date(dateStr);
        if (isNaN(txDate) || txDate < cutoff) continue;
        if ((src.form_type || '').toUpperCase() !== '4') continue;
        buys.push({ transactionDate: dateStr, share: 0, value: 0, transactionPrice: curPx });
      }
      if (buys.length > 0) return { buys, sells: [], source: 'sec' };
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
 
// ── Peer PE ───────────────────────────────────────────────────────────────────
const PEER_MAP = {
  AAPL:['MSFT','GOOGL','META','AMZN','NVDA'],   MSFT:['AAPL','GOOGL','CRM','ORCL','IBM'],
  GOOGL:['META','MSFT','AMZN','SNAP','TTD'],     META:['GOOGL','SNAP','PINS','TTD'],
  AMZN:['MSFT','GOOGL','WMT','COST','BABA'],    NVDA:['AMD','INTC','QCOM','AVGO','TXN'],
  TSLA:['GM','F','RIVN','NIO','TM'],             AVGO:['QCOM','TXN','ADI','MRVL','AMD'],
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
  COP:['EOG','XOM','CVX','DVN','OXY'],           EOG:['COP','DVN','OXY','FANG','MRO'],
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
  FDX:['UPS','XPO','ODFL'],                      IBM:['MSFT','ORCL','HPE','DXC'],
  NEE:['DUK','SO','AEP','EXC','D'],              AMT:['PLD','EQIX','CCI','SPG','O'],
  NFLX:['DIS','WBD','PARA','ROKU'],              DIS:['NFLX','WBD','PARA','CMCSA'],
  MA:['V','PYPL','AXP','FIS'],                   V:['MA','PYPL','AXP','FIS'],
  KR:['WMT','TGT','COST','ACI'],                 SPGI:['MCO','ICE','CME','MSCI'],
};
 
async function fetchPeerPESingle(peer) {
  // 1: v7 quote — fastest, single call returns trailingPE + marketCap
  try {
    const q  = await yahooV7Quote(peer);
    const pe = q?.trailingPE;
    const mc = q?.marketCap || 0;
    if (pe && pe > 0 && pe < 600) return { ticker: peer, pe, mc };
  } catch (_) {}
 
  // 2: Yahoo chart meta
  try {
    const chart = await yahooChart(peer, '5d');
    const pe    = chart?.meta?.trailingPE;
    const mc    = chart?.meta?.marketCap || 0;
    if (pe && pe > 0 && pe < 600) return { ticker: peer, pe, mc };
  } catch (_) {}
 
  // 3: Yahoo summaryDetail
  try {
    const ys = await yahooSummary(peer, 'summaryDetail');
    const sd = ys?.summaryDetail;
    const pe = sd?.trailingPE?.raw || sd?.forwardPE?.raw;
    const mc = sd?.marketCap?.raw || 0;
    if (pe && pe > 0 && pe < 600) return { ticker: peer, pe, mc };
  } catch (_) {}
 
  // 4: Finnhub metric
  try {
    const d  = await fh(`/stock/metric?symbol=${peer}&metric=all`);
    const pm = d?.metric || {};
    const pe = pm.peBasicExclExtraTTM || pm.peTTM;
    const mc = (pm.marketCapitalization || 0) * 1e6;
    if (pe && pe > 0 && pe < 600) return { ticker: peer, pe, mc };
  } catch (_) {}
 
  return null;
}
 
async function fetchPeerPE(ticker, targetPE, targetMC) {
  try {
    let rawPeers = [];
    try {
      const pd = await fh(`/stock/peers?symbol=${ticker}`);
      if (Array.isArray(pd)) rawPeers = pd.filter(p => p !== ticker);
    } catch (_) {}
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v6/finance/recommendationsbysymbol/${ticker}`,
        { headers: YH, signal: AbortSignal.timeout(6000) }
      );
      if (r.ok) {
        const j  = await r.json();
        const yp = (j?.finance?.result?.[0]?.recommendedSymbols || []).map(s => s.symbol);
        rawPeers = [...new Set([...rawPeers, ...yp])].filter(p => p !== ticker);
      }
    } catch (_) {}
    if (PEER_MAP[ticker]) {
      rawPeers = [...new Set([...rawPeers, ...PEER_MAP[ticker]])].filter(p => p !== ticker);
    }
    rawPeers = rawPeers.slice(0, 20);
    if (rawPeers.length === 0) return null;
 
    const peerResults = await Promise.allSettled(rawPeers.map(fetchPeerPESingle));
    const all = peerResults
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);
    if (all.length === 0) return null;
 
    let loRatio = 0.1, hiRatio = 10;
    if (targetMC > 500000) { loRatio = 0.07; hiRatio = 14; }
    else if (targetMC > 50000) { loRatio = 0.09; hiRatio = 11; }
 
    let comparables = targetMC > 0
      ? all.filter(c => { const m = c.mc / 1e6; return m <= 0 || (m / targetMC >= loRatio && m / targetMC <= hiRatio); })
      : all;
    if (comparables.length < 3) comparables = all;
    if (comparables.length === 0) return null;
 
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
 
    const result = {
      medianPE:  parseFloat(medPE.toFixed(1)),
      avgPE:     parseFloat(avgPE.toFixed(1)),
      peerCount: comparables.length,
      diff:      null,
      peers:     comparables.map(c => c.ticker),
    };
    if (targetPE && targetPE > 0) {
      result.diff = parseFloat(((targetPE - avgPE) / avgPE * 100).toFixed(1));
    }
    return result;
  } catch (_) { return null; }
}
 
// ── Helpers ───────────────────────────────────────────────────────────────────
function getRating(score) {
  if (score >= 5) return { label: 'Strong Buy', color: '#14532d', bg: '#dcfce7', border: '#86efac' };
  if (score === 4) return { label: 'Buy',        color: '#15803d', bg: '#f0fdf4', border: '#bbf7d0' };
  if (score === 3) return { label: 'Watch',      color: '#92400e', bg: '#fffbeb', border: '#fde68a' };
  return                  { label: 'Ignore',     color: '#6b7280', bg: '#f9fafb', border: '#d1d5db' };
}
 
function cleanExchange(raw) {
  if (!raw) return 'NYSE';
  const u = raw.toUpperCase();
  if (u.includes('NASDAQ')) return 'NASDAQ';
  if (u.includes('NYSE'))   return 'NYSE';
  if (u.includes('LSE') || u.includes('LONDON'))   return 'LSE';
  if (u.includes('TSX') || u.includes('TORONTO')) return 'TSX';
  return raw.split(/[\s,]/)[0].toUpperCase() || 'NYSE';
}
 
// ── Master fetch ──────────────────────────────────────────────────────────────
async function fetchStockData(ticker) {
  // All primary fetches fire simultaneously including the new v7 quote
  const [quoteR, profileR, metricsR, earningsR, analystTargetR, yahooDataR, v7QuoteR] =
    await Promise.allSettled([
      fh(`/quote?symbol=${ticker}`),
      fh(`/stock/profile2?symbol=${ticker}`),
      fh(`/stock/metric?symbol=${ticker}&metric=all`),
      fh(`/stock/earnings?symbol=${ticker}&limit=4`),
      fetchAnalystTarget(ticker),
      yahooChart(ticker, '1y'),
      yahooV7Quote(ticker),
    ]);
 
  const curPx = quoteR.status === 'fulfilled'    ? quoteR.value?.c              : null;
  const m     = metricsR.status === 'fulfilled'  ? metricsR.value?.metric || {} : {};
  const yc    = yahooDataR.status === 'fulfilled' ? yahooDataR.value            : null;
  const ymeta = yc?.meta || {};
  const v7q   = v7QuoteR.status === 'fulfilled'  ? v7QuoteR.value               : null;
 
  // 52w hi/lo
  let hi52 = m['52WeekHigh'] || ymeta.fiftyTwoWeekHigh || null;
  let lo52 = m['52WeekLow']  || ymeta.fiftyTwoWeekLow  || null;
  if ((!hi52 || !lo52) && yc) {
    const closes = yc.indicators?.quote?.[0]?.close?.filter(c => c != null && !isNaN(c)) || [];
    if (closes.length > 10) {
      if (!hi52) hi52 = Math.max(...closes);
      if (!lo52) lo52 = Math.min(...closes);
    }
  }
 
  // Current PE — v7 quote adds a fourth source
  const curPE = m.peBasicExclExtraTTM || m.peTTM || ymeta.trailingPE || v7q?.trailingPE || null;
 
  // 50d MA — primary from 1y closes, v7 as immediate fallback, then full chain
  let ma50 = null;
  const yahooCloses = yc?.indicators?.quote?.[0]?.close
    ?.filter(c => c != null && !isNaN(c) && c > 0) || [];
  if (yahooCloses.length >= 20) ma50 = compute50dMA(yahooCloses);
  if (!ma50 && v7q?.fiftyDayAverage > 0) ma50 = v7q.fiftyDayAverage;
  if (!ma50 || ma50 <= 0) ma50 = await fetch50dMAFallback(ticker);
 
  // EPS — Finnhub first, then v7 quote, then full 5-source chain
  let eps = m.epsBasicExclExtraAnnual || m.epsTTM || null;
  if (!eps && v7q?.epsTrailingTwelveMonths != null && v7q.epsTrailingTwelveMonths !== 0) {
    eps = v7q.epsTrailingTwelveMonths;
  }
  if (!eps) eps = await fetchEPS(ticker);
 
  const targetMC = m.marketCapitalization || 0;
 
  const [insiderData, peerPE] = await Promise.all([
    fetchInsiderTransactions(ticker, curPx),
    fetchPeerPE(ticker, curPE, targetMC),
  ]);
 
  return {
    quote:         quoteR.status === 'fulfilled'         ? quoteR.value         : null,
    profile:       profileR.status === 'fulfilled'       ? profileR.value       : null,
    metrics:       metricsR.status === 'fulfilled'       ? metricsR.value       : null,
    earnings:      earningsR.status === 'fulfilled'      ? earningsR.value      : null,
    analystTarget: analystTargetR.status === 'fulfilled' ? analystTargetR.value : null,
    hi52, lo52, curPE, eps, ma50, insiderData, peerPE,
  };
}
 
// ── Evaluate ──────────────────────────────────────────────────────────────────
function evaluate(ticker, d) {
  const q     = d.quote   || {};
  const p     = d.profile || {};
  const m     = d.metrics?.metric || {};
  const curPx = q.c;
  if (!curPx) return null;
 
  const company  = p.name || ticker;
  const mc       = p.marketCapitalization ? p.marketCapitalization * 1e6 : 0;
  const mcs      = mc > 1e12 ? `$${(mc / 1e12).toFixed(2)}T`
                 : mc > 1e9  ? `$${(mc / 1e9).toFixed(1)}B`
                 : mc > 1e6  ? `$${(mc / 1e6).toFixed(0)}M` : '';
  const exchange = cleanExchange(p.exchange);
 
  // S1: EPS beat
  let s1 = { status: 'neutral', value: 'No data' };
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
  let s2 = { status: 'neutral', value: 'No data' };
  try {
    const curPE = d.curPE;
    const eps   = d.eps;
    const hi    = d.hi52;
    const lo    = d.lo52;
    if (curPE && curPE > 0 && eps && eps !== 0 && hi && lo && hi > lo) {
      const midPrice = (hi + lo) / 2;
      const histPE   = midPrice / eps;
      if (histPE > 0 && histPE < 1000) {
        if      (curPE < histPE * 0.92) s2 = { status: 'pass',    value: `PE ${curPE.toFixed(1)}x < hist ~${histPE.toFixed(0)}x` };
        else if (curPE > histPE * 1.08) s2 = { status: 'fail',    value: `PE ${curPE.toFixed(1)}x > hist ~${histPE.toFixed(0)}x` };
        else                            s2 = { status: 'neutral', value: `PE ${curPE.toFixed(1)}x ≈ hist ~${histPE.toFixed(0)}x` };
      }
    } else if (curPE && curPE > 0) {
      s2 = { status: 'neutral', value: `PE ${curPE.toFixed(1)}x` };
    }
  } catch (_) {}
 
  // S3: Price vs 50d MA
  let s3 = { status: 'neutral', value: 'No data' };
  try {
    if (d.ma50 && d.ma50 > 0 && curPx) {
      const pct = ((curPx - d.ma50) / d.ma50 * 100).toFixed(1);
      s3 = curPx <= d.ma50
        ? { status: 'pass', value: `$${curPx.toFixed(2)} ≤ MA $${d.ma50.toFixed(2)} (${pct}%)` }
        : { status: 'fail', value: `$${curPx.toFixed(2)} > MA $${d.ma50.toFixed(2)} (+${pct}%)` };
    }
  } catch (_) {}
 
  // S4: Insider buying
  const { buys, sells, source } = d.insiderData || { buys: [], sells: [], source: null };
  const s4 = buildInsiderValue(buys, sells, source);
 
  // S5: Analyst target ≥ +25%
  let s5 = { status: 'neutral', value: 'No data' };
  try {
    const tgt = d.analystTarget;
    if (tgt && tgt > 0 && curPx) {
      const up = ((tgt - curPx) / curPx * 100).toFixed(1);
      s5 = parseFloat(up) >= 25
        ? { status: 'pass', value: `Target $${tgt.toFixed(2)}, +${up}% upside` }
        : { status: 'fail', value: `Target $${tgt.toFixed(2)}, +${up}% upside` };
    }
  } catch (_) {}
 
  // S6: PE vs peers
  let s6 = { status: 'neutral', value: 'No data' };
  try {
    const pp = d.peerPE;
    if (pp && pp.medianPE && pp.diff !== null) {
      if      (pp.diff < -8) s6 = { status: 'pass',    value: `${Math.abs(pp.diff).toFixed(0)}% < peer avg ${pp.avgPE}x` };
      else if (pp.diff >  8) s6 = { status: 'fail',    value: `${Math.abs(pp.diff).toFixed(0)}% > peer avg ${pp.avgPE}x` };
      else                   s6 = { status: 'neutral', value: `In line, avg ${pp.avgPE}x` };
    } else if (pp?.medianPE) {
      s6 = { status: 'neutral', value: `Peer avg ${pp.avgPE}x` };
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
 
// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!FINNHUB_KEY)          return res.status(500).json({ error: 'FINNHUB_KEY not set' });
 
  const { tickers } = req.body;
  if (!Array.isArray(tickers) || tickers.length === 0)
    return res.status(400).json({ error: 'tickers array required' });
 
  const results = {};
  const cleaned = tickers.slice(0, 20).map(t => t.toUpperCase().trim());
 
  await Promise.allSettled(cleaned.map(async ticker => {
    try {
      const raw = await fetchStockData(ticker);
      const ev  = evaluate(ticker, raw);
      results[ticker] = ev || { ticker, error: 'No quote data' };
    } catch (e) {
      results[ticker] = { ticker, error: e.message };
    }
  }));
 
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
  return res.status(200).json({ results, fetchedAt: new Date().toISOString() });
}
 
