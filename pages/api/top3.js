// pages/api/top3.js
//
// Two-tier architecture:
// TIER 1 — Yahoo Finance scans ~280 stocks (free, no key, batched in parallel)
//           Quick-scores every stock. Only ONE hard gate: market cap > $2B.
//           PE absence is never a rejection — many profitable stocks don't
//           expose trailingPE on Yahoo's chart endpoint.
//
// TIER 2 — Top 6 candidates get full Finnhub signal analysis, run sequentially.
//           EPS, PE, insider, analyst all have Yahoo fallbacks.
//
// Cache: 1 hour in-memory. First load ~25–40s, subsequent instant.
 
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const FH = 'https://finnhub.io/api/v1';
 
const UNIVERSE = [
  // Mega-cap tech
  'AAPL','MSFT','GOOGL','AMZN','META','NVDA','AVGO','ORCL','ADBE','INTU',
  // Large-cap tech (profitable)
  'AMD','INTC','QCOM','TXN','AMAT','MU','CSCO','IBM','HPQ','ACN',
  'NOW','CRM','PANW','FTNT','KLAC','LRCX','SNPS','CDNS','PTC','ANSS',
  // Finance
  'JPM','BAC','WFC','GS','MS','BLK','C','AXP','SCHW','USB',
  'PNC','TFC','COF','DFS','AIG','MET','PRU','AFL','CB','TRV',
  'CME','ICE','SPGI','MCO','MA','V','FIS','FI',
  // Healthcare
  'LLY','JNJ','UNH','ABBV','MRK','PFE','TMO','ABT','AMGN','CVS',
  'MDT','ISRG','BSX','SYK','EW','REGN','BIIB','VRTX','CI','HUM',
  'ELV','CNC','IQV','A','ZBH','BAX','BDX','COO','HOLX','TECH',
  // Energy
  'XOM','CVX','COP','EOG','SLB','MPC','PSX','VLO','OXY','DVN',
  'HAL','BKR','HES','MRO','APA','FANG','TPL','NOG','SM','CTRA',
  // Consumer discretionary
  'HD','MCD','NKE','SBUX','LOW','TGT','COST','WMT','TJX','ROST',
  'BKNG','MAR','HLT','YUM','CMG','DRI','TSCO','ORLY','AZO','BBY',
  // Consumer staples
  'KO','PEP','PG','PM','MO','KHC','GIS','K','HSY','MDLZ',
  'CL','CLX','CHD','SYY','KR','CAG','MKC','HRL','CPB','TSN',
  // Industrials
  'CAT','HON','MMM','GE','RTX','LMT','NOC','GD','UPS','FDX',
  'UNP','CSX','NSC','DE','EMR','ROK','ITW','ETN','PH','DOV',
  'AME','ROP','IR','XYL','LDOS','SAIC','BAH','TDY','HII','L',
  // Materials
  'LIN','APD','ECL','DD','DOW','NEM','FCX','ALB','PPG','SHW',
  'CF','MOS','FMC','CE','EMN','RPM','OLN','HUN','WLK','AXTA',
  // Telecom / Utilities
  'T','VZ','TMUS','NEE','DUK','SO','AEP','EXC','SRE','PCG',
  'D','ETR','FE','CNP','AEE','WEC','ES','CMS','NI','LNT',
  // REITs
  'AMT','PLD','EQIX','CCI','SPG','O','VICI','WPC','NNN','PSA',
  'EXR','AVB','EQR','MAA','UDR','CPT','ESS','AIV','BRT','NHI',
  // International ADRs (profitable large-caps)
  'TSM','ASML','NVO','SAP','TM','AZN','HSBC','SHEL','BHP','RIO',
  'NVS','UL','DEO','BTI','GSK','RELX','SAN','ING','BBVA','ENB',
];
 
const UNIQ_UNIVERSE = [...new Set(UNIVERSE)];
 
const EXCHANGE_MAP = {
  AAPL:'NASDAQ',MSFT:'NASDAQ',GOOGL:'NASDAQ',AMZN:'NASDAQ',META:'NASDAQ',
  NVDA:'NASDAQ',AVGO:'NASDAQ',ORCL:'NYSE',ADBE:'NASDAQ',INTU:'NASDAQ',
  AMD:'NASDAQ',INTC:'NASDAQ',QCOM:'NASDAQ',TXN:'NASDAQ',AMAT:'NASDAQ',
  MU:'NASDAQ',NOW:'NYSE',CRM:'NYSE',PANW:'NASDAQ',CSCO:'NASDAQ',
  IBM:'NYSE',HPQ:'NYSE',KLAC:'NASDAQ',LRCX:'NASDAQ',SNPS:'NASDAQ',CDNS:'NASDAQ',
  JPM:'NYSE',BAC:'NYSE',WFC:'NYSE',GS:'NYSE',MS:'NYSE',BLK:'NYSE',
  C:'NYSE',AXP:'NYSE',SCHW:'NYSE',USB:'NYSE',PNC:'NYSE',TFC:'NYSE',
  COF:'NYSE',DFS:'NYSE',AIG:'NYSE',MET:'NYSE',PRU:'NYSE',AFL:'NYSE',
  CB:'NYSE',TRV:'NYSE',CME:'NASDAQ',ICE:'NYSE',SPGI:'NYSE',MCO:'NYSE',
  MA:'NYSE',V:'NYSE',
  LLY:'NYSE',JNJ:'NYSE',UNH:'NYSE',ABBV:'NYSE',MRK:'NYSE',PFE:'NYSE',
  TMO:'NYSE',ABT:'NYSE',AMGN:'NASDAQ',CVS:'NYSE',MDT:'NYSE',
  ISRG:'NASDAQ',BSX:'NYSE',SYK:'NYSE',REGN:'NASDAQ',BIIB:'NASDAQ',VRTX:'NASDAQ',
  XOM:'NYSE',CVX:'NYSE',COP:'NYSE',EOG:'NYSE',SLB:'NYSE',MPC:'NYSE',
  PSX:'NYSE',VLO:'NYSE',OXY:'NYSE',DVN:'NYSE',HAL:'NYSE',BKR:'NYSE',
  HD:'NYSE',MCD:'NYSE',NKE:'NYSE',SBUX:'NASDAQ',LOW:'NYSE',TGT:'NYSE',
  COST:'NASDAQ',WMT:'NYSE',BKNG:'NASDAQ',MAR:'NASDAQ',
  CAT:'NYSE',HON:'NASDAQ',MMM:'NYSE',GE:'NYSE',RTX:'NYSE',LMT:'NYSE',
  NOC:'NYSE',GD:'NYSE',UPS:'NYSE',FDX:'NYSE',UNP:'NYSE',CSX:'NASDAQ',NSC:'NYSE',DE:'NYSE',
  KO:'NYSE',PEP:'NASDAQ',PG:'NYSE',PM:'NYSE',MO:'NYSE',T:'NYSE',VZ:'NYSE',TMUS:'NASDAQ',NEE:'NYSE',
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
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(7000) }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta || !meta.regularMarketPrice) return null;
    const price = meta.regularMarketPrice;
    const hi = meta.fiftyTwoWeekHigh || price * 1.2;
    const lo = meta.fiftyTwoWeekLow  || price * 0.8;
    const range = hi - lo;
    return {
      symbol,
      price,
      yearHigh:     hi,
      yearLow:      lo,
      peRatio:      meta.trailingPE ?? null,   // often null — never reject on this
      marketCap:    meta.marketCap  ?? null,
      lowProximity: range > 0 ? ((price - lo) / range) * 100 : 50,
      pctFromHigh:  hi > 0 ? ((hi - price) / hi) * 100 : 0,
    };
  } catch { return null; }
}
 
// Quick score — only ONE hard gate (market cap).
// PE absence is treated as neutral, not a rejection.
function quickScore(s) {
  // Only hard gate: need enough market cap for analyst coverage
  if (!s.marketCap || s.marketCap < 2_000_000_000) return null;
 
  let score = 0;
 
  // PE value score — only applied when PE is available and sensible
  if (s.peRatio && s.peRatio > 0 && s.peRatio <= 150) {
    if      (s.peRatio <= 12) score += 40;
    else if (s.peRatio <= 18) score += 32;
    else if (s.peRatio <= 25) score += 22;
    else if (s.peRatio <= 35) score += 12;
    else if (s.peRatio <= 50) score += 5;
    // PE > 50: no PE score bonus, but not rejected
  }
  // When PE is null, still eligible — will score on other factors
 
  // Price position vs 52w range
  // Avoid extreme freefalls (>50% below high) — likely distressed
  if (s.pctFromHigh > 50) {
    score -= 15; // penalty but not rejection
  } else if (s.lowProximity < 20)      score += 25;
  else if (s.lowProximity < 35)        score += 18;
  else if (s.lowProximity < 55)        score += 10;
  else if (s.lowProximity < 75)        score += 4;
 
  // Size bonus — larger caps have more signal data
  if      (s.marketCap > 500_000_000_000) score += 15;
  else if (s.marketCap > 100_000_000_000) score += 10;
  else if (s.marketCap >  20_000_000_000) score += 5;
  else if (s.marketCap >   5_000_000_000) score += 2;
 
  // Minimum threshold — must score > 0 after all factors
  return score > 0 ? score : null;
}
 
async function fetchBatch(symbols, delayMs = 0) {
  if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  return Promise.all(symbols.map(fetchYahooQuote));
}
 
// ── Finnhub helper ────────────────────────────────────────────────────────────
async function fh(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${FH}${path}${sep}token=${FINNHUB_KEY}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(7000),
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
  try {
    const d = await fh(`/stock/candle?symbol=${ticker}&resolution=D&count=60`);
    if (d?.s === 'ok' && Array.isArray(d.c) && d.c.length >= 10) {
      const ma = maFromCloses(d.c); if (ma > 0) return ma;
    }
  } catch (_) {}
  try {
    const now = Math.floor(Date.now() / 1000);
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&period1=${now - 100*86400}&period2=${now}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j = await r.json();
      const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c => c != null && !isNaN(c));
      const ma = maFromCloses(closes); if (ma > 0) return ma;
    }
  } catch (_) {}
  return null;
}
 
// ── EPS beat — Finnhub primary, two Yahoo fallbacks ───────────────────────────
async function fetchEarningsSignal(ticker, finnhubEarnings) {
  try {
    const earns = Array.isArray(finnhubEarnings) ? finnhubEarnings : [];
    if (earns.length > 0 && earns[0].actual != null && earns[0].estimate != null) {
      const e = earns[0], diff = e.actual - e.estimate, beat = diff >= 0;
      const ds = Math.abs(diff) < 0.005 ? 'in-line' : beat ? `+$${Math.abs(diff).toFixed(2)}` : `-$${Math.abs(diff).toFixed(2)}`;
      return { status: beat ? 'pass' : 'fail', value: beat ? `Beat by ${ds}` : `Missed ${ds}` };
    }
  } catch (_) {}
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=earningsHistory`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j = await r.json();
      const history = j?.quoteSummary?.result?.[0]?.earningsHistory?.history || [];
      if (history.length > 0) {
        const recent = history[history.length - 1];
        const actual = recent?.epsActual?.raw, estimate = recent?.epsEstimate?.raw;
        if (actual != null && estimate != null) {
          const diff = actual - estimate, beat = diff >= 0;
          const ds = Math.abs(diff) < 0.005 ? 'in-line' : beat ? `+$${Math.abs(diff).toFixed(2)}` : `-$${Math.abs(diff).toFixed(2)}`;
          return { status: beat ? 'pass' : 'fail', value: beat ? `Beat by ${ds}` : `Missed ${ds}` };
        }
      }
    }
  } catch (_) {}
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=earningsTrend`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j = await r.json();
      const trend = j?.quoteSummary?.result?.[0]?.earningsTrend?.trend || [];
      for (const t of trend) {
        if (t?.period === '0q' && t?.earningsEstimate?.avg?.raw != null) {
          return { status: 'neutral', value: `Est. EPS $${t.earningsEstimate.avg.raw.toFixed(2)} (curr. qtr)` };
        }
      }
    }
  } catch (_) {}
  return { status: 'neutral', value: 'No data' };
}
 
// ── PE vs historical — Finnhub primary, Yahoo fallback ───────────────────────
async function fetchPESignal(ticker, m) {
  try {
    const curPE = m.peBasicExclExtraTTM || m.peTTM;
    const eps   = m.epsBasicExclExtraAnnual || m.epsTTM;
    const hi = m['52WeekHigh'], lo = m['52WeekLow'];
    if (curPE && eps > 0 && hi && lo) {
      const histPE = ((hi + lo) / 2) / eps;
      if      (curPE < histPE * 0.92) return { status: 'pass',    value: `PE ${curPE.toFixed(1)}x < hist ~${histPE.toFixed(0)}x` };
      else if (curPE > histPE * 1.08) return { status: 'fail',    value: `PE ${curPE.toFixed(1)}x > hist ~${histPE.toFixed(0)}x` };
      else                            return { status: 'neutral', value: `PE ${curPE.toFixed(1)}x ≈ hist ~${histPE.toFixed(0)}x` };
    }
    if (curPE) return { status: 'neutral', value: `PE ${curPE.toFixed(1)}x` };
  } catch (_) {}
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=summaryDetail,defaultKeyStatistics`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j  = await r.json();
      const sd = j?.quoteSummary?.result?.[0]?.summaryDetail || {};
      const ks = j?.quoteSummary?.result?.[0]?.defaultKeyStatistics || {};
      const pe  = sd?.trailingPE?.raw || sd?.forwardPE?.raw;
      const eps = ks?.trailingEps?.raw;
      const hi  = sd?.fiftyTwoWeekHigh?.raw, lo = sd?.fiftyTwoWeekLow?.raw;
      if (pe && eps && hi && lo) {
        const histPE = ((hi + lo) / 2) / eps;
        if      (pe < histPE * 0.92) return { status: 'pass',    value: `PE ${pe.toFixed(1)}x < hist ~${histPE.toFixed(0)}x` };
        else if (pe > histPE * 1.08) return { status: 'fail',    value: `PE ${pe.toFixed(1)}x > hist ~${histPE.toFixed(0)}x` };
        else                         return { status: 'neutral', value: `PE ${pe.toFixed(1)}x ≈ hist ~${histPE.toFixed(0)}x` };
      }
      if (pe) return { status: 'neutral', value: `PE ${pe.toFixed(1)}x` };
    }
  } catch (_) {}
  return { status: 'neutral', value: 'No data' };
}
 
// ── Analyst target — 4 sources ────────────────────────────────────────────────
async function fetchAnalystTarget(ticker) {
  try {
    const d = await fh(`/stock/price-target?symbol=${ticker}`);
    const t = d?.targetMedian || d?.targetMean;
    if (t && t > 0) return t;
  } catch (_) {}
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(
        `https://${host}.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
      );
      if (r.ok) {
        const j = await r.json();
        const fd = j?.quoteSummary?.result?.[0]?.financialData;
        const t  = fd?.targetMedianPrice?.raw || fd?.targetMeanPrice?.raw;
        if (t && t > 0) return t;
      }
    } catch (_) {}
  }
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}&fields=targetMeanPrice,targetMedianPrice`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }
    );
    if (r.ok) {
      const j = await r.json();
      const q = j?.quoteResponse?.result?.[0];
      const t = q?.targetMedianPrice || q?.targetMeanPrice;
      if (t && t > 0) return t;
    }
  } catch (_) {}
  return null;
}
 
// ── Insider transactions — 4 sources ─────────────────────────────────────────
function fmtShares(n) {
  if (!n) return null;
  if (n >= 1e6) return `${(n/1e6).toFixed(2)}M shares`;
  if (n >= 1e3) return `${(n/1e3).toFixed(1)}K shares`;
  return `${n.toLocaleString()} shares`;
}
function fmtDollars(n) {
  if (!n) return null;
  if (n >= 1e9) return `$${(n/1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
function timeAgo(dateStr) {
  if (!dateStr) return null;
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 7)  return `${days}d ago`;
  if (days < 14) return '1w ago';
  if (days < 30) return `${Math.floor(days/7)}w ago`;
  return `${Math.floor(days/30)}mo ago`;
}
 
async function fetchInsiderTransactions(ticker, curPx) {
  const now    = Math.floor(Date.now() / 1000);
  const ago60  = now - 60 * 86400;
  const from60 = new Date(ago60 * 1000).toISOString().slice(0, 10);
  const to60   = new Date(now * 1000).toISOString().slice(0, 10);
  const cutoff = new Date(ago60 * 1000);
 
  try {
    const d     = await fh(`/stock/insider-transactions?symbol=${ticker}&from=${from60}&to=${to60}`);
    const txns  = d?.data || [];
    const buys  = txns.filter(t => t.transactionCode === 'P');
    const sells = txns.filter(t => t.transactionCode === 'S');
    if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'finnhub' };
  } catch (_) {}
 
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=insiderTransactions`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j = await r.json();
      const txns = j?.quoteSummary?.result?.[0]?.insiderTransactions?.transactions || [];
      const buys = [], sells = [];
      for (const t of txns) {
        const dateTs = t.startDate?.raw; if (!dateTs) continue;
        const txDate = new Date(dateTs * 1000); if (txDate < cutoff) continue;
        const dateStr = txDate.toISOString().slice(0, 10);
        const shares = Math.abs(t.shares?.raw || 0), value = Math.abs(t.value?.raw || 0);
        const desc = (t.transactionDescription || '').toLowerCase();
        const entry = { transactionDate: dateStr, share: shares, value, transactionPrice: shares > 0 ? value / shares : curPx };
        if (/purchase|buy/i.test(desc)) buys.push(entry);
        else if (/sale|sell/i.test(desc)) sells.push(entry);
      }
      if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'yahoo' };
    }
  } catch (_) {}
 
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=insiderHolders`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j = await r.json();
      const holders = j?.quoteSummary?.result?.[0]?.insiderHolders?.holders || [];
      const buys = [], sells = [];
      for (const h of holders) {
        const dateTs = h.latestTransDate?.raw; if (!dateTs) continue;
        const txDate = new Date(dateTs * 1000); if (txDate < cutoff) continue;
        const dateStr = txDate.toISOString().slice(0, 10);
        const desc = (h.transactionDescription || '').toLowerCase();
        const entry = { transactionDate: dateStr, share: 0, value: 0, transactionPrice: curPx };
        if (/purchase|buy|acquisition/i.test(desc)) buys.push(entry);
        else if (/sale|sell|disposition/i.test(desc)) sells.push(entry);
      }
      if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'yahoo-holders' };
    }
  } catch (_) {}
 
  try {
    const r = await fetch(
      `https://efts.sec.gov/LATEST/search-index?q=%22${ticker}%22&dateRange=custom&startdt=${from60}&enddt=${to60}&forms=4`,
      { headers: { 'User-Agent': 'signal-engine/1.0' }, signal: AbortSignal.timeout(7000) }
    );
    if (r.ok) {
      const j = await r.json();
      const hits = j?.hits?.hits || [];
      const buys = [];
      for (const hit of hits.slice(0, 10)) {
        const src = hit._source || {};
        if ((src.form_type || '').toUpperCase() !== '4') continue;
        const dateStr = src.file_date || src.period_of_report;
        if (!dateStr || new Date(dateStr) < cutoff) continue;
        buys.push({ transactionDate: dateStr, share: 0, value: 0, transactionPrice: curPx });
      }
      if (buys.length > 0) return { buys, sells: [], source: 'sec-edgar' };
    }
  } catch (_) {}
 
  return { buys: [], sells: [], source: null };
}
 
function buildInsiderValue(buys, sells, source) {
  if (buys.length > 0) {
    if (source === 'sec-edgar') {
      const dates = buys.map(t => t.transactionDate).filter(Boolean).sort().reverse();
      const rc = dates[0] ? timeAgo(dates[0]) : '60d';
      return { status: 'pass', value: `Form 4 activity · ${buys.length} filing${buys.length > 1 ? 's' : ''} · ${rc}` };
    }
    const totalShares = buys.reduce((s, t) => s + (t.share || 0), 0);
    const totalValue  = buys.reduce((s, t) => s + (t.value || Math.abs((t.share||0)*(t.transactionPrice||0))), 0);
    const parts = [`${buys.length} buy${buys.length > 1 ? 's' : ''}`];
    const sh = fmtShares(totalShares); if (sh) parts.push(sh);
    const dl = fmtDollars(totalValue); if (dl) parts.push(dl);
    const dates = buys.map(t => t.transactionDate).filter(Boolean).sort().reverse();
    const rc = dates[0] ? timeAgo(dates[0]) : null; if (rc) parts.push(rc);
    return { status: 'pass', value: parts.join(' · ') };
  }
  if (sells.length > 0) {
    const dates = sells.map(t => t.transactionDate).filter(Boolean).sort().reverse();
    const rc = dates[0] ? timeAgo(dates[0]) : null;
    return { status: 'fail', value: [`${sells.length} sell${sells.length > 1 ? 's' : ''}, no buys`, rc].filter(Boolean).join(' · ') };
  }
  return { status: 'neutral', value: source ? 'No activity (60d)' : 'No data' };
}
 
// ── Peer PE ───────────────────────────────────────────────────────────────────
async function fetchPeerPE(ticker, targetPE) {
  try {
    let rawPeers = [];
    try { const pd = await fh(`/stock/peers?symbol=${ticker}`); if (Array.isArray(pd)) rawPeers = pd.filter(p => p !== ticker).slice(0, 12); } catch (_) {}
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v6/finance/recommendationsbysymbol/${ticker}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) });
      if (r.ok) { const j = await r.json(); const yp = (j?.finance?.result?.[0]?.recommendedSymbols || []).map(s => s.symbol); rawPeers = [...new Set([...rawPeers, ...yp])].filter(p => p !== ticker).slice(0, 12); }
    } catch (_) {}
    if (rawPeers.length === 0) return null;
    const pm = await Promise.allSettled(rawPeers.map(p => fh(`/stock/metric?symbol=${p}&metric=all`)));
    const all = [];
    for (let i = 0; i < rawPeers.length; i++) {
      if (pm[i].status !== 'fulfilled') continue;
      const mtr = pm[i].value?.metric || {};
      const pe  = mtr.peBasicExclExtraTTM || mtr.peTTM;
      if (!pe || pe <= 0 || pe > 300) continue;
      all.push({ pe });
    }
    if (all.length < 2) return null;
    const pes   = all.map(c => c.pe).sort((a, b) => a - b);
    const mid   = Math.floor(pes.length / 2);
    const medPE = pes.length % 2 === 0 ? (pes[mid-1]+pes[mid])/2 : pes[mid];
    const avgPE = pes.reduce((a, b) => a + b, 0) / pes.length;
    const diff  = targetPE && targetPE > 0 ? parseFloat(((targetPE - avgPE) / avgPE * 100).toFixed(1)) : null;
    return { medianPE: parseFloat(medPE.toFixed(1)), avgPE: parseFloat(avgPE.toFixed(1)), peerCount: all.length, diff };
  } catch (_) { return null; }
}
 
function getRating(score) {
  if (score >= 5) return { label: 'Strong Buy', color: '#14532d', bg: '#dcfce7', border: '#86efac' };
  if (score === 4) return { label: 'Buy',        color: '#15803d', bg: '#f0fdf4', border: '#bbf7d0' };
  if (score === 3) return { label: 'Watch',      color: '#92400e', bg: '#fffbeb', border: '#fde68a' };
  return                  { label: 'Ignore',     color: '#6b7280', bg: '#f9fafb', border: '#d1d5db' };
}
 
// ── TIER 2: Full signal analysis ──────────────────────────────────────────────
async function fullAnalyse(ticker) {
  const [quote, profile, metrics, earnings] = await Promise.allSettled([
    fh(`/quote?symbol=${ticker}`),
    fh(`/stock/profile2?symbol=${ticker}`),
    fh(`/stock/metric?symbol=${ticker}&metric=all`),
    fh(`/stock/earnings?symbol=${ticker}&limit=4`),
  ]);
 
  const q     = quote.status   === 'fulfilled' ? quote.value   || {} : {};
  const p     = profile.status === 'fulfilled' ? profile.value || {} : {};
  const m     = metrics.status === 'fulfilled' ? metrics.value?.metric || {} : {};
  const curPx = q.c;
  if (!curPx) return null;
 
  const targetPE = m.peBasicExclExtraTTM || m.peTTM || null;
 
  const [ma50, insiderData, analystTarget, peerPE, s1, s2] = await Promise.all([
    fetch50dMA(ticker),
    fetchInsiderTransactions(ticker, curPx),
    fetchAnalystTarget(ticker),
    fetchPeerPE(ticker, targetPE),
    fetchEarningsSignal(ticker, earnings.status === 'fulfilled' ? earnings.value : []),
    fetchPESignal(ticker, m),
  ]);
 
  const mc  = p.marketCapitalization ? p.marketCapitalization * 1e6 : 0;
  const mcs = mc > 1e12 ? `$${(mc/1e12).toFixed(2)}T` : mc > 1e9 ? `$${(mc/1e9).toFixed(1)}B` : mc > 1e6 ? `$${(mc/1e6).toFixed(0)}M` : '';
 
  let s3 = { status: 'neutral', value: 'No data' };
  try {
    if (ma50 && curPx) {
      const pct = ((curPx - ma50) / ma50 * 100).toFixed(1);
      s3 = curPx <= ma50
        ? { status: 'pass', value: `$${curPx.toFixed(2)} ≤ MA $${ma50.toFixed(2)} (${pct}%)` }
        : { status: 'fail', value: `$${curPx.toFixed(2)} > MA $${ma50.toFixed(2)} (+${pct}%)` };
    }
  } catch (_) {}
 
  const { buys, sells, source } = insiderData || { buys: [], sells: [], source: null };
  const s4 = buildInsiderValue(buys, sells, source);
 
  let s5 = { status: 'neutral', value: 'No data' };
  try {
    if (analystTarget && curPx) {
      const up = ((analystTarget - curPx) / curPx * 100).toFixed(1);
      s5 = parseFloat(up) >= 25
        ? { status: 'pass', value: `Target $${analystTarget.toFixed(2)}, +${up}% upside` }
        : { status: 'fail', value: `Target $${analystTarget.toFixed(2)}, +${up}% upside` };
    }
  } catch (_) {}
 
  let s6 = { status: 'neutral', value: 'No data' };
  try {
    if (peerPE?.diff !== null && peerPE?.diff !== undefined) {
      if      (peerPE.diff < -8) s6 = { status: 'pass',    value: `${Math.abs(peerPE.diff).toFixed(0)}% < peer avg ${peerPE.avgPE}x` };
      else if (peerPE.diff > 8)  s6 = { status: 'fail',    value: `${Math.abs(peerPE.diff).toFixed(0)}% > peer avg ${peerPE.avgPE}x` };
      else                       s6 = { status: 'neutral', value: `In line, avg ${peerPE.avgPE}x` };
    } else if (peerPE?.medianPE) {
      s6 = { status: 'neutral', value: `Peer avg ${peerPE.avgPE}x` };
    }
  } catch (_) {}
 
  const signals   = [s1, s2, s3, s4, s5, s6];
  const score     = signals.filter(s => s.status === 'pass').length;
  const SIG_NAMES = ['EPS beat', 'Low PE', 'Below 50d MA', 'Insider buying', 'Analyst upside', 'PE vs peers'];
  const passes    = signals.map((s, i) => s.status === 'pass' ? SIG_NAMES[i] : null).filter(Boolean);
  const fails     = signals.map((s, i) => s.status === 'fail' ? SIG_NAMES[i] : null).filter(Boolean);
 
  let summary;
  if      (score >= 5)  summary = `Strong value candidate — ${score}/6 signals pass. Strengths: ${passes.join(', ')}.`;
  else if (score === 4) summary = `Good signals (4/6). Passes: ${passes.join(', ')}.`;
  else if (score === 3) summary = `Moderate signals (3/6). Passes: ${passes.join(', ')}.`;
  else if (score > 0)   summary = `Weak signals (${score}/6). Passes: ${passes.join(', ')}. Fails: ${fails.join(', ')}.`;
  else                  summary = `No signals pass. Fails: ${fails.join(', ')}.`;
 
  const rawExchange   = p.exchange || '';
  const cleanExchange = rawExchange.replace(/NASDAQ.*/i, 'NASDAQ').replace(/New York Stock Exchange.*/i, 'NYSE').toUpperCase().trim();
  const exchange      = cleanExchange || EXCHANGE_MAP[ticker] || 'NYSE';
 
  return {
    ticker, company: p.name || ticker, exchange,
    price:     `$${curPx.toFixed(2)}`,
    change:    q.dp != null ? `${q.dp > 0 ? '+' : ''}${q.dp.toFixed(2)}%` : null,
    marketCap: mcs, score, signals, summary,
    rating:    getRating(score),
    updatedAt: new Date().toISOString(),
  };
}
 
// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (cache.data && Date.now() - cache.timestamp < CACHE_TTL) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cache.data);
  }
 
  try {
    // TIER 1: Yahoo scan — batches of 15, 100ms stagger
    const BATCH_SIZE = 15;
    const batches = [];
    for (let i = 0; i < UNIQ_UNIVERSE.length; i += BATCH_SIZE) {
      batches.push(UNIQ_UNIVERSE.slice(i, i + BATCH_SIZE));
    }
    const allStocks = (
      await Promise.all(batches.map((b, i) => fetchBatch(b, i * 100)))
    ).flat().filter(Boolean);
 
    // Score — only hard-reject if market cap too small or score <= 0
    const scored = allStocks
      .map(s => { const qs = quickScore(s); return qs !== null ? { ...s, qs } : null; })
      .filter(Boolean)
      .sort((a, b) => b.qs - a.qs);
 
    // Safety net: if quality filter leaves fewer than 6, just use top raw results
    const pool = scored.length >= 6 ? scored : allStocks
      .filter(s => s.marketCap && s.marketCap > 1_000_000_000)
      .sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
 
    const candidates = pool.slice(0, 6).map(s => s.symbol);
 
    // TIER 2: Sequential full Finnhub analysis
    const top3 = [];
 
    if (FINNHUB_KEY) {
      for (const ticker of candidates) {
        if (top3.length >= 3) break;
        try {
          const result = await fullAnalyse(ticker);
          if (result) top3.push(result);
        } catch (_) {}
      }
      top3.sort((a, b) => (b.score || 0) - (a.score || 0));
    } else {
      for (const s of pool.slice(0, 3)) {
        top3.push({
          ticker: s.symbol, company: s.symbol,
          exchange:  EXCHANGE_MAP[s.symbol] || 'NYSE',
          price:     `$${s.price?.toFixed(2)}`,
          marketCap: s.marketCap ? `$${(s.marketCap/1e9).toFixed(0)}B` : 'N/A',
          score:     0,
          signals:   Array(6).fill({ status: 'neutral', value: 'Add FINNHUB_KEY in Vercel for signals' }),
          summary:   'Add FINNHUB_KEY to Vercel environment variables to enable full signal analysis.',
          rating:    { label: 'Watch', color: '#92400e', bg: '#fffbeb', border: '#fde68a' },
          updatedAt: new Date().toISOString(),
        });
      }
    }
 
    const result = {
      top3,
      totalScanned:   allStocks.length,
      qualifiedCount: scored.length,
      generatedAt:    new Date().toISOString(),
    };
 
    cache = { data: result, timestamp: Date.now() };
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    return res.status(200).json(result);
 
  } catch (err) {
    console.error('top3 error:', err);
    return res.status(500).json({ error: 'Failed to fetch stock data', detail: err.message });
  }
}
 
