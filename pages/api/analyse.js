// pages/api/analyse.js
// Restored from last known working version.
// Fixes applied:
//   1. exchange field added (needed by feature cards)
//   2. fetch50dMA: 4 sources — Finnhub candle, Yahoo query1, Yahoo query2, Stooq
//      Stooq.com is a free financial data site that doesn't block server requests
//   3. fetchAnalystTarget: Finnhub /stock/price-target added as primary source
//   4. fetchPeerPE: peer PE from Yahoo chart meta (parallel, no rate limit)
//      Finnhub /stock/metric kept as per-peer fallback only
 
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const FH = 'https://finnhub.io/api/v1';
 
// Full browser headers for Yahoo Finance
const YH = {
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
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000),
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
 
// ── 50d MA — 4 sources ────────────────────────────────────────────────────────
function maFromCloses(closes) {
  if (!Array.isArray(closes) || closes.length < 10) return null;
  const slice = closes.slice(-50);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}
 
async function fetch50dMA(ticker) {
  // Source 1: Finnhub candle (free, reliable when data exists)
  try {
    const d = await fh(`/stock/candle?symbol=${ticker}&resolution=D&count=60`);
    if (d?.s === 'ok' && Array.isArray(d.c) && d.c.length >= 10) {
      const ma = maFromCloses(d.c);
      if (ma > 0) return ma;
    }
  } catch (_) {}
 
  // Source 2: Yahoo query1 with full browser headers
  try {
    const now = Math.floor(Date.now() / 1000);
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&period1=${now - 100*86400}&period2=${now}`,
      { headers: YH, signal: AbortSignal.timeout(7000) }
    );
    if (r.ok) {
      const j = await r.json();
      const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close
        ?.filter(c => c != null && !isNaN(c));
      const ma = maFromCloses(closes);
      if (ma > 0) return ma;
    }
  } catch (_) {}
 
  // Source 3: Yahoo query2 domain (different IP, often succeeds when query1 fails)
  try {
    const now = Math.floor(Date.now() / 1000);
    const r = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&period1=${now - 100*86400}&period2=${now}`,
      { headers: YH, signal: AbortSignal.timeout(7000) }
    );
    if (r.ok) {
      const j = await r.json();
      const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close
        ?.filter(c => c != null && !isNaN(c));
      const ma = maFromCloses(closes);
      if (ma > 0) return ma;
    }
  } catch (_) {}
 
  // Source 4: Stooq — free financial data, no API key, doesn't block server requests
  // Returns CSV: Date,Open,High,Low,Close,Volume
  try {
    const r = await fetch(
      `https://stooq.com/q/d/l/?s=${ticker.toLowerCase()}.us&i=d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
    );
    if (r.ok) {
      const text = await r.text();
      const lines = text.trim().split('\n').slice(1); // skip header
      // Lines are oldest→newest. Take last 60 rows, extract close (col 4)
      const closes = lines
        .slice(-60)
        .map(l => parseFloat(l.split(',')[4]))
        .filter(c => !isNaN(c) && c > 0);
      const ma = maFromCloses(closes);
      if (ma > 0) return ma;
    }
  } catch (_) {}
 
  return null;
}
 
// ── Analyst target — 5 sources ────────────────────────────────────────────────
async function fetchAnalystTarget(ticker) {
  // Source 1: Finnhub price target (most reliable on Vercel)
  try {
    const d = await fh(`/stock/price-target?symbol=${ticker}`);
    const t = d?.targetMedian || d?.targetMean;
    if (t && t > 0) return t;
  } catch (_) {}
 
  // Sources 2–4: Yahoo Finance (multiple URLs/versions)
  for (const url of [
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData`,
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData`,
    `https://query1.finance.yahoo.com/v11/finance/quoteSummary/${ticker}?modules=financialData`,
  ]) {
    try {
      const r = await fetch(url, { headers: YH, signal: AbortSignal.timeout(7000) });
      if (r.ok) {
        const j  = await r.json();
        const fd = j?.quoteSummary?.result?.[0]?.financialData;
        const t  = fd?.targetMedianPrice?.raw || fd?.targetMeanPrice?.raw;
        if (t && t > 0) return t;
      }
    } catch (_) {}
  }
 
  // Source 5: Stockanalysis scrape
  try {
    const r = await fetch(
      `https://stockanalysis.com/stocks/${ticker.toLowerCase()}/forecast/`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(7000) }
    );
    if (r.ok) {
      const html = await r.text();
      for (const p of [
        /price\s+target[^$]*\$\s*([\d,]+\.?\d*)/i,
        /consensus[^$]*\$\s*([\d,]+\.?\d*)/i,
        /mean\s+target[^$]*\$\s*([\d,]+\.?\d*)/i,
      ]) {
        const m = html.match(p);
        if (m) {
          const v = parseFloat(m[1].replace(/,/g, ''));
          if (v > 0 && v < 100000) return v;
        }
      }
    }
  } catch (_) {}
 
  return null;
}
 
// ── Insider transactions — 4 sources ─────────────────────────────────────────
async function fetchInsiderTransactions(ticker, curPx) {
  const now    = Math.floor(Date.now() / 1000);
  const ago30  = now - 30 * 86400;
  const from30 = new Date(ago30 * 1000).toISOString().slice(0, 10);
  const to30   = new Date(now * 1000).toISOString().slice(0, 10);
  const cutoff = new Date(ago30 * 1000);
 
  // Source 1: Finnhub
  try {
    const d    = await fh(`/stock/insider-transactions?symbol=${ticker}&from=${from30}&to=${to30}`);
    const txns = d?.data || [];
    if (txns.length > 0) {
      const buys  = txns.filter(t => t.transactionCode === 'P');
      const sells = txns.filter(t => t.transactionCode === 'S');
      if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'finnhub' };
    }
  } catch (_) {}
 
  // Source 2: OpenInsider
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
        if (/P\s*-\s*Purchase/i.test(type)) buys.push(entry);
        else if (/S\s*-\s*Sale/i.test(type)) sells.push(entry);
      }
      if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'openinsider' };
    }
  } catch (_) {}
 
  // Source 3: Yahoo Finance
  for (const url of [
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=insiderTransactions`,
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=insiderTransactions`,
  ]) {
    try {
      const r = await fetch(url, { headers: YH, signal: AbortSignal.timeout(7000) });
      if (r.ok) {
        const j    = await r.json();
        const txns = j?.quoteSummary?.result?.[0]?.insiderTransactions?.transactions || [];
        const buys = [], sells = [];
        for (const t of txns) {
          const dateTs = t.startDate?.raw;
          if (!dateTs) continue;
          const txDate  = new Date(dateTs * 1000);
          if (txDate < cutoff) continue;
          const dateStr = txDate.toISOString().slice(0, 10);
          const shares  = Math.abs(t.shares?.raw || 0);
          const value   = Math.abs(t.value?.raw  || 0);
          const desc    = (t.transactionDescription || '').toLowerCase();
          const entry   = { transactionDate: dateStr, share: shares, value,
            transactionPrice: shares > 0 ? value / shares : curPx };
          if (/purchase|buy/i.test(desc)) buys.push(entry);
          else if (/sale|sell/i.test(desc)) sells.push(entry);
        }
        if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'yahoo' };
      }
    } catch (_) {}
  }
 
  // Source 4: SEC EDGAR Form 4
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
    const totalValue  = buys.reduce((s, t) => {
      const v = t.value || Math.abs((t.share||0) * (t.transactionPrice||0));
      return s + v;
    }, 0);
    const sharesStr = totalShares > 0 ? fmtShares(totalShares) : null;
    const dollarStr = totalValue  > 0 ? fmtDollars(totalValue)  : null;
    const dates     = buys.map(t => t.transactionDate).filter(Boolean).sort().reverse();
    const recency   = dates[0] ? timeAgo(dates[0]) : null;
    const parts     = [`${buys.length} buy${buys.length > 1 ? 's' : ''}`];
    if (sharesStr) parts.push(sharesStr);
    if (dollarStr) parts.push(dollarStr);
    if (recency)   parts.push(recency);
    return { status: 'pass', value: parts.join(' · ') };
  }
  if (sells.length > 0) {
    const totalShares = sells.reduce((s, t) => s + (t.share || 0), 0);
    const totalValue  = sells.reduce((s, t) => {
      const v = t.value || Math.abs((t.share||0) * (t.transactionPrice||0));
      return s + v;
    }, 0);
    const sharesStr = totalShares > 0 ? fmtShares(totalShares) : null;
    const dollarStr = totalValue  > 0 ? fmtDollars(totalValue)  : null;
    const dates     = sells.map(t => t.transactionDate).filter(Boolean).sort().reverse();
    const recency   = dates[0] ? timeAgo(dates[0]) : null;
    const parts     = [`${sells.length} sell${sells.length > 1 ? 's' : ''}, no buys`];
    if (sharesStr) parts.push(sharesStr);
    if (dollarStr) parts.push(dollarStr);
    if (recency)   parts.push(recency);
    return { status: 'fail', value: parts.join(' · ') };
  }
  return { status: 'neutral', value: source ? 'No activity (30d)' : 'No data' };
}
 
// ── Peer PE — Yahoo chart meta primary, Finnhub fallback, hardcoded guarantee ─
const FALLBACK_PEERS = {
  AAPL: ['MSFT','GOOGL','META','AMZN','NVDA'],
  MSFT: ['AAPL','GOOGL','CRM','ORCL','IBM'],
  GOOGL:['META','MSFT','AMZN','SNAP','TTD'],
  META: ['GOOGL','SNAP','PINS','TTD','RDDT'],
  AMZN: ['MSFT','GOOGL','WMT','COST','BABA'],
  NVDA: ['AMD','INTC','QCOM','AVGO','TXN'],
  TSLA: ['GM','F','RIVN','NIO','TM'],
  AVGO: ['QCOM','TXN','ADI','MRVL','AMD'],
  ORCL: ['SAP','MSFT','CRM','IBM','WDAY'],
  AMD:  ['NVDA','INTC','QCOM','TXN','MU'],
  INTC: ['AMD','NVDA','QCOM','TXN','AVGO'],
  QCOM: ['AVGO','TXN','ADI','MRVL','AMD'],
  JPM:  ['BAC','WFC','C','GS','MS'],
  BAC:  ['JPM','WFC','C','USB','PNC'],
  WFC:  ['JPM','BAC','C','USB','PNC'],
  GS:   ['MS','JPM','C','BLK','SCHW'],
  MS:   ['GS','JPM','C','BLK','SCHW'],
  LLY:  ['NVO','PFE','MRK','ABBV','BMY'],
  JNJ:  ['PFE','ABBV','MRK','TMO','ABT'],
  UNH:  ['CVS','CI','HUM','ELV','CNC'],
  ABBV: ['PFE','LLY','MRK','BMY','REGN'],
  MRK:  ['PFE','JNJ','ABBV','LLY','BMY'],
  PFE:  ['MRK','JNJ','ABBV','BMY','LLY'],
  XOM:  ['CVX','COP','SLB','EOG','OXY'],
  CVX:  ['XOM','COP','SLB','EOG','DVN'],
  COP:  ['EOG','XOM','CVX','DVN','OXY'],
  HD:   ['LOW','WMT','TGT','COST','AMZN'],
  WMT:  ['TGT','COST','KR','HD','AMZN'],
  TGT:  ['WMT','COST','HD','KR','DG'],
  COST: ['WMT','TGT','BJ','HD','AMZN'],
  MCD:  ['YUM','CMG','QSR','DRI','WEN'],
  NKE:  ['ADDYY','UAA','DECK','LULU','SKX'],
  KO:   ['PEP','MDLZ','MNST','KHC'],
  PEP:  ['KO','MDLZ','MNST','KHC'],
  PM:   ['MO','BTI','IMBBY'],
  MO:   ['PM','BTI','IMBBY'],
  T:    ['VZ','TMUS','CMCSA','CHTR'],
  VZ:   ['T','TMUS','CMCSA','CHTR'],
  TMUS: ['T','VZ','CMCSA','CHTR'],
  CAT:  ['DE','HON','EMR','ITW','PH'],
  DE:   ['CAT','AGCO','CNH','HON'],
  IBM:  ['MSFT','ORCL','HPE','DXC','LDOS'],
  NEE:  ['DUK','SO','AEP','EXC','D'],
  AMT:  ['PLD','EQIX','CCI','SPG','O'],
};
 
async function fetchPeerPE(ticker, targetPE, targetMC, targetMargin) {
  try {
    let rawPeers = [];
 
    // Source A: Finnhub peers
    try {
      const pd = await fh(`/stock/peers?symbol=${ticker}`);
      if (Array.isArray(pd)) rawPeers = pd.filter(p => p !== ticker);
    } catch (_) {}
 
    // Source B: Yahoo recommended symbols
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
 
    // Source C: Hardcoded fallback (guarantees peers for common tickers)
    if (FALLBACK_PEERS[ticker]) {
      rawPeers = [...new Set([...rawPeers, ...FALLBACK_PEERS[ticker]])].filter(p => p !== ticker);
    }
 
    rawPeers = rawPeers.slice(0, 20);
    if (rawPeers.length === 0) return null;
 
    // Fetch PE for each peer — Yahoo chart meta in parallel (fast, no rate limit)
    const peerResults = await Promise.allSettled(
      rawPeers.map(async peer => {
        for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
          try {
            const r = await fetch(
              `${base}/v8/finance/chart/${peer}?interval=1d&range=5d`,
              { headers: YH, signal: AbortSignal.timeout(5000) }
            );
            if (r.ok) {
              const j    = await r.json();
              const meta = j?.chart?.result?.[0]?.meta;
              const pe   = meta?.trailingPE;
              const mc   = meta?.marketCap || 0;
              if (pe && pe > 0 && pe < 500) return { ticker: peer, pe, mc };
            }
          } catch (_) {}
        }
        // Fallback: Finnhub metric (rate-limited — only if Yahoo failed)
        try {
          const d  = await fh(`/stock/metric?symbol=${peer}&metric=all`);
          const pm = d?.metric || {};
          const pe = pm.peBasicExclExtraTTM || pm.peTTM;
          const mc = (pm.marketCapitalization || 0) * 1e6;
          if (pe && pe > 0 && pe < 500) return { ticker: peer, pe, mc };
        } catch (_) {}
        return null;
      })
    );
 
    const all = peerResults
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);
 
    if (all.length === 0) return null;
 
    // Market cap filter — targetMC is in MILLIONS (from Finnhub metric)
    let loRatio = 0.25, hiRatio = 4;
    if (targetMC > 500000)     { loRatio = 0.15; hiRatio = 6.5; }
    else if (targetMC > 50000) { loRatio = 0.2;  hiRatio = 5;   }
 
    let comparables = targetMC > 0
      ? all.filter(c => {
          const mc_m = c.mc / 1e6;
          return mc_m <= 0 || (mc_m / targetMC >= loRatio && mc_m / targetMC <= hiRatio);
        })
      : all;
 
    if (comparables.length < 3) comparables = all;
    if (comparables.length === 0) return null;
 
    if (comparables.length >= 5) {
      const sorted = [...comparables].sort((a, b) => a.pe - b.pe);
      const trim   = Math.max(1, Math.floor(sorted.length * 0.1));
      comparables  = sorted.slice(trim, sorted.length - trim);
    }
 
    if (comparables.length < 2) return null;
 
    const pes      = comparables.map(c => c.pe).sort((a, b) => a - b);
    const mid      = Math.floor(pes.length / 2);
    const medianPE = pes.length % 2 === 0 ? (pes[mid-1] + pes[mid]) / 2 : pes[mid];
    const avgPE    = pes.reduce((a, b) => a + b, 0) / pes.length;
 
    const result = {
      medianPE:  parseFloat(medianPE.toFixed(1)),
      avgPE:     parseFloat(avgPE.toFixed(1)),
      peerCount: comparables.length,
      diff:      null,
      peers:     comparables.map(c => c.ticker),
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
  if (score >= 5) return { label: 'Strong Buy', color: '#14532d', bg: '#dcfce7', border: '#86efac' };
  if (score === 4) return { label: 'Buy',        color: '#15803d', bg: '#f0fdf4', border: '#bbf7d0' };
  if (score === 3) return { label: 'Watch',      color: '#92400e', bg: '#fffbeb', border: '#fde68a' };
  return               { label: 'Ignore',        color: '#6b7280', bg: '#f9fafb', border: '#d1d5db' };
}
 
function cleanExchange(raw) {
  if (!raw) return 'NYSE';
  const u = raw.toUpperCase();
  if (u.includes('NASDAQ')) return 'NASDAQ';
  if (u.includes('NYSE'))   return 'NYSE';
  if (u.includes('LSE') || u.includes('LONDON')) return 'LSE';
  if (u.includes('TSX') || u.includes('TORONTO')) return 'TSX';
  return raw.split(/[\s,]/)[0].toUpperCase() || 'NYSE';
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
 
  const curPx        = quote.status   === 'fulfilled' ? quote.value?.c          : null;
  const m            = metrics.status === 'fulfilled' ? metrics.value?.metric || {} : {};
  const targetPE     = m.peBasicExclExtraTTM || m.peTTM || null;
  const targetMC     = m.marketCapitalization || 0; // millions
  const targetMargin = m.netProfitMarginAnnual || m.netProfitMarginTTM || 0;
 
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
    ma50, insiderData, peerPE,
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
  const mcs      = mc > 1e12 ? `$${(mc/1e12).toFixed(2)}T`
    : mc > 1e9  ? `$${(mc/1e9).toFixed(1)}B`
    : mc > 1e6  ? `$${(mc/1e6).toFixed(0)}M` : '';
  const exchange = cleanExchange(p.exchange);
 
  // S1: EPS beat
  let s1 = { status: 'neutral', value: 'No data' };
  try {
    const earns = Array.isArray(d.earnings) ? d.earnings : [];
    if (earns.length > 0) {
      const e    = earns[0];
      const diff = e.actual - e.estimate;
      const beat = diff >= 0;
      const ds   = Math.abs(diff) < 0.005
        ? 'in-line'
        : beat ? `+$${Math.abs(diff).toFixed(2)}` : `-$${Math.abs(diff).toFixed(2)}`;
      s1 = { status: beat ? 'pass' : 'fail', value: beat ? `Beat by ${ds}` : `Missed ${ds}` };
    }
  } catch (_) {}
 
  // S2: PE vs historical average
  let s2 = { status: 'neutral', value: 'No data' };
  try {
    const curPE = m.peBasicExclExtraTTM || m.peTTM;
    const eps   = m.epsBasicExclExtraAnnual || m.epsTTM;
    const hi    = m['52WeekHigh'];
    const lo    = m['52WeekLow'];
    if (curPE && eps > 0 && hi && lo) {
      const histPE = ((hi + lo) / 2) / eps;
      if (curPE < histPE * 0.92)      s2 = { status: 'pass',    value: `PE ${curPE.toFixed(1)}x < hist ~${histPE.toFixed(0)}x` };
      else if (curPE > histPE * 1.08) s2 = { status: 'fail',    value: `PE ${curPE.toFixed(1)}x > hist ~${histPE.toFixed(0)}x` };
      else                             s2 = { status: 'neutral', value: `PE ${curPE.toFixed(1)}x ≈ hist ~${histPE.toFixed(0)}x` };
    } else if (curPE) {
      s2 = { status: 'neutral', value: `PE ${curPE.toFixed(1)}x` };
    }
  } catch (_) {}
 
  // S3: Price vs 50d MA
  let s3 = { status: 'neutral', value: 'No data' };
  try {
    if (d.ma50 && curPx) {
      const pct = ((curPx - d.ma50) / d.ma50 * 100).toFixed(1);
      s3 = curPx <= d.ma50
        ? { status: 'pass', value: `$${curPx.toFixed(2)} ≤ MA $${d.ma50.toFixed(2)} (${pct}%)` }
        : { status: 'fail', value: `$${curPx.toFixed(2)} > MA $${d.ma50.toFixed(2)} (+${pct}%)` };
    }
  } catch (_) {}
 
  // S4: Insider buying
  const { buys, sells, source } = d.insiderData || { buys: [], sells: [], source: null };
  const s4 = buildInsiderValue(buys, sells, source);
 
  // S5: Analyst price target ≥ +25%
  let s5 = { status: 'neutral', value: 'No data' };
  try {
    const tgt = d.analystTarget;
    if (tgt && curPx) {
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
      if (pp.diff < -8)      s6 = { status: 'pass',    value: `${Math.abs(pp.diff).toFixed(0)}% < peer avg ${pp.avgPE}x` };
      else if (pp.diff > 8)  s6 = { status: 'fail',    value: `${Math.abs(pp.diff).toFixed(0)}% > peer avg ${pp.avgPE}x` };
      else                   s6 = { status: 'neutral', value: `In line, avg ${pp.avgPE}x` };
    } else if (pp?.medianPE) {
      s6 = { status: 'neutral', value: `Peer avg ${pp.avgPE}x` };
    }
  } catch (_) {}
 
  const signals   = [s1, s2, s3, s4, s5, s6];
  const score     = signals.filter(s => s.status === 'pass').length;
  const SIG_NAMES = ['EPS beat', 'Low PE', 'Below 50d MA', 'Insider buying', 'Analyst upside', 'PE vs peers'];
  const passes    = signals.map((s, i) => s.status === 'pass' ? SIG_NAMES[i] : null).filter(Boolean);
  const fails     = signals.map((s, i) => s.status === 'fail' ? SIG_NAMES[i] : null).filter(Boolean);
 
  let summary;
  if (score >= 5)       summary = `Strong value candidate — ${score}/6 signals pass. Strengths: ${passes.join(', ')}.`;
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
 
