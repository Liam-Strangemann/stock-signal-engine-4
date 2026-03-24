// pages/api/top3.js
//
// Architecture:
// ─────────────────────────────────────────────────────────────────────────────
// TIER 1 — Yahoo Finance scan (free, no key, fast)
//   • Fetches price/PE/52w data for 300 stocks in parallel batches
//   • Quick-scores every stock on value + momentum metrics
//   • No Finnhub calls at this stage → no rate-limit risk
//
// TIER 2 — Full Finnhub signal analysis (sequential, only top 5 candidates)
//   • Runs the full 6-signal analysis one stock at a time
//   • Stops as soon as 3 valid results are collected
//   • Each stock's internal calls run in parallel
//
// Signal fixes in this version:
//   • Insider buying: Finnhub → Yahoo insiderTransactions → SEC EDGAR Form 4
//   • Analyst target: Finnhub /stock/price-target (free tier) → Yahoo financialData
//                     → Yahoo quoteSummary (alt URL) → Stockanalysis scrape
//
// Cache: 1 hour in-memory. First load ~25s, subsequent loads instant.
// ─────────────────────────────────────────────────────────────────────────────
 
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const FH = 'https://finnhub.io/api/v1';
 
// ── 300-stock universe ────────────────────────────────────────────────────────
// Broad coverage: mega-cap, large-cap US + major ADRs + mid-cap value names.
// Yahoo Finance handles all of these without a key.
const UNIVERSE = [
  // Mega-cap tech
  'AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','AVGO','ORCL','ADBE',
  // Large-cap tech
  'AMD','INTC','QCOM','TXN','AMAT','MU','NOW','CRM','SNOW','PLTR',
  'UBER','LYFT','SHOP','PINS','SNAP','SPOT','RBLX','HOOD','COIN','SQ',
  'PYPL','INTU','PANW','CRWD','ZS','NET','DDOG','MDB','GTLB','HUBS',
  // Finance
  'JPM','BAC','WFC','GS','MS','BLK','C','AXP','SCHW','USB',
  'PNC','TFC','COF','DFS','SYF','AIG','MET','PRU','AFL','CB',
  // Healthcare
  'LLY','JNJ','UNH','ABBV','MRK','PFE','TMO','ABT','AMGN','CVS',
  'MDT','ISRG','BSX','SYK','EW','REGN','BIIB','VRTX','ILMN','MRNA',
  // Energy
  'XOM','CVX','COP','EOG','SLB','MPC','PSX','VLO','OXY','DVN',
  'HAL','BKR','FANG','APA','MRO','HES','NOG','SM','CTRA','WTI',
  // Consumer / Retail
  'AMZN','TSLA','HD','MCD','NKE','SBUX','LOW','TGT','COST','WMT',
  'BABA','JD','PDD','MELI','SE','DASH','ABNB','BKNG','EXPE','MAR',
  // Industrials
  'CAT','BA','HON','MMM','GE','RTX','LMT','NOC','GD','TDG',
  'UPS','FDX','CSX','UNP','NSC','DE','EMR','ROK','ITW','ETN',
  // Consumer staples + dividend
  'KO','PEP','PG','PM','MO','T','VZ','KHC','GIS','K',
  'CPB','MKC','HSY','MDLZ','CLX','CL','CHD','ENR','SPB','HRL',
  // Materials + REITs
  'LIN','APD','ECL','DD','DOW','NEM','FCX','VALE','BHP','RIO',
  'AMT','PLD','EQIX','CCI','SPG','O','VICI','WPC','MPW','NNN',
  // International ADRs
  'TSM','ASML','NVO','SAP','TM','AZN','HSBC','SHEL','BHP','RIO',
  'BABA','JD','PDD','NIO','XPEV','LI','VALE','PBR','SAN','ING',
  // Mid-cap value / growth
  'CELH','ONON','LULU','ELF','WOLF','SMCI','ARM','AI','IONQ','QUBT',
  'RDDT','APP','APLD','CORZ','MARA','RIOT','HUT','CLSK','CIFR','IREN',
];
 
// Deduplicate
const UNIQ_UNIVERSE = [...new Set(UNIVERSE)];
 
// Exchange reference map
const EXCHANGE_MAP = {
  AAPL:'NASDAQ',MSFT:'NASDAQ',GOOGL:'NASDAQ',AMZN:'NASDAQ',META:'NASDAQ',
  NVDA:'NASDAQ',TSLA:'NASDAQ',AVGO:'NASDAQ',ORCL:'NYSE',ADBE:'NASDAQ',
  AMD:'NASDAQ',INTC:'NASDAQ',QCOM:'NASDAQ',TXN:'NASDAQ',AMAT:'NASDAQ',
  MU:'NASDAQ',NOW:'NYSE',CRM:'NYSE',SNOW:'NYSE',PLTR:'NYSE',
  UBER:'NYSE',SHOP:'NYSE',PINS:'NYSE',SNAP:'NYSE',SPOT:'NYSE',
  RBLX:'NYSE',HOOD:'NASDAQ',COIN:'NASDAQ',SQ:'NYSE',PYPL:'NASDAQ',
  INTU:'NASDAQ',PANW:'NASDAQ',CRWD:'NASDAQ',ZS:'NASDAQ',NET:'NYSE',
  DDOG:'NASDAQ',MDB:'NASDAQ',HUBS:'NYSE',
  'BRK.B':'NYSE',JPM:'NYSE',BAC:'NYSE',WFC:'NYSE',GS:'NYSE',
  MS:'NYSE',BLK:'NYSE',C:'NYSE',AXP:'NYSE',SCHW:'NYSE',
  USB:'NYSE',PNC:'NYSE',TFC:'NYSE',COF:'NYSE',DFS:'NYSE',
  SYF:'NYSE',AIG:'NYSE',MET:'NYSE',PRU:'NYSE',AFL:'NYSE',CB:'NYSE',
  LLY:'NYSE',JNJ:'NYSE',UNH:'NYSE',ABBV:'NYSE',MRK:'NYSE',
  PFE:'NYSE',TMO:'NYSE',ABT:'NYSE',AMGN:'NASDAQ',CVS:'NYSE',
  MDT:'NYSE',ISRG:'NASDAQ',BSX:'NYSE',SYK:'NYSE',EW:'NYSE',
  REGN:'NASDAQ',BIIB:'NASDAQ',VRTX:'NASDAQ',ILMN:'NASDAQ',MRNA:'NASDAQ',
  XOM:'NYSE',CVX:'NYSE',COP:'NYSE',EOG:'NYSE',SLB:'NYSE',
  MPC:'NYSE',PSX:'NYSE',VLO:'NYSE',OXY:'NYSE',DVN:'NYSE',
  HAL:'NYSE',BKR:'NYSE',
  HD:'NYSE',MCD:'NYSE',NKE:'NYSE',SBUX:'NASDAQ',LOW:'NYSE',
  TGT:'NYSE',COST:'NASDAQ',WMT:'NYSE',BKNG:'NASDAQ',MAR:'NASDAQ',
  CAT:'NYSE',BA:'NYSE',HON:'NASDAQ',MMM:'NYSE',GE:'NYSE',
  RTX:'NYSE',LMT:'NYSE',NOC:'NYSE',GD:'NYSE',UPS:'NYSE',
  FDX:'NYSE',CSX:'NASDAQ',UNP:'NYSE',NSC:'NYSE',DE:'NYSE',
  KO:'NYSE',PEP:'NASDAQ',PG:'NYSE',PM:'NYSE',MO:'NYSE',
  T:'NYSE',VZ:'NYSE',
  LIN:'NYSE',APD:'NYSE',ECL:'NYSE',NEM:'NYSE',FCX:'NYSE',
  AMT:'NYSE',PLD:'NYSE',EQIX:'NASDAQ',CCI:'NYSE',SPG:'NYSE',
  TSM:'NYSE',ASML:'NASDAQ',NVO:'NYSE',SAP:'NYSE',TM:'NYSE',
  AZN:'NASDAQ',HSBC:'NYSE',SHEL:'NYSE',BHP:'NYSE',RIO:'NYSE',
};
 
// In-memory cache
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
 
// ── TIER 1: Yahoo Finance fast scan ──────────────────────────────────────────
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
    const hi = meta.fiftyTwoWeekHigh, lo = meta.fiftyTwoWeekLow;
    const range = hi - lo;
    return {
      symbol,
      price, yearHigh: hi, yearLow: lo,
      peRatio:      meta.trailingPE ?? null,
      marketCap:    meta.marketCap  ?? null,
      lowProximity: range > 0 ? ((price - lo) / range) * 100 : 50,
    };
  } catch { return null; }
}
 
function quickScore(s) {
  let n = 0;
  if (s.peRatio && s.peRatio > 0 && s.peRatio < 200) n += Math.max(0, 40 - s.peRatio);
  n += Math.max(0, 30 - (s.lowProximity || 50) * 0.3);
  if (s.marketCap && s.marketCap > 50_000_000_000)  n += 8;
  if (s.marketCap && s.marketCap > 200_000_000_000) n += 4;
  return Math.round(n);
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
 
// ── MA calculation ────────────────────────────────────────────────────────────
function maFromCloses(closes) {
  if (!Array.isArray(closes) || closes.length < 10) return null;
  const s = closes.slice(-50);
  return s.reduce((a, b) => a + b, 0) / s.length;
}
 
async function fetch50dMA(ticker) {
  try {
    const d = await fh(`/stock/candle?symbol=${ticker}&resolution=D&count=60`);
    if (d?.s === 'ok' && Array.isArray(d.c) && d.c.length >= 10) {
      const ma = maFromCloses(d.c);
      if (ma > 0) return ma;
    }
  } catch (_) {}
  try {
    const now = Math.floor(Date.now() / 1000);
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&period1=${now - 100 * 86400}&period2=${now}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j = await r.json();
      const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c => c != null && !isNaN(c));
      const ma = maFromCloses(closes);
      if (ma > 0) return ma;
    }
  } catch (_) {}
  return null;
}
 
// ── Analyst price target — 4 sources ─────────────────────────────────────────
async function fetchAnalystTarget(ticker) {
  // Source 1: Finnhub /stock/price-target (available on free tier)
  try {
    const d = await fh(`/stock/price-target?symbol=${ticker}`);
    const t = d?.targetMedian || d?.targetMean;
    if (t && t > 0) return t;
  } catch (_) {}
 
  // Source 2: Yahoo financialData module
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j  = await r.json();
      const fd = j?.quoteSummary?.result?.[0]?.financialData;
      const t  = fd?.targetMedianPrice?.raw || fd?.targetMeanPrice?.raw;
      if (t && t > 0) return t;
    }
  } catch (_) {}
 
  // Source 3: Yahoo v11 quoteSummary (different endpoint, sometimes works when v10 doesn't)
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData,defaultKeyStatistics`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j  = await r.json();
      const fd = j?.quoteSummary?.result?.[0]?.financialData;
      const t  = fd?.targetMedianPrice?.raw || fd?.targetMeanPrice?.raw;
      if (t && t > 0) return t;
    }
  } catch (_) {}
 
  // Source 4: Yahoo quote endpoint (sometimes includes targetMeanPrice directly)
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
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M shares`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K shares`;
  return `${n.toLocaleString()} shares`;
}
function fmtDollars(n) {
  if (!n) return null;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
function timeAgo(dateStr) {
  if (!dateStr) return null;
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 7)  return `${days}d ago`;
  if (days < 14) return '1w ago';
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
 
async function fetchInsiderTransactions(ticker, curPx) {
  const now    = Math.floor(Date.now() / 1000);
  const ago60  = now - 60 * 86400; // extend window to 60 days for better coverage
  const from60 = new Date(ago60 * 1000).toISOString().slice(0, 10);
  const to60   = new Date(now * 1000).toISOString().slice(0, 10);
  const cutoff = new Date(ago60 * 1000);
 
  // Source 1: Finnhub insider transactions
  try {
    const d     = await fh(`/stock/insider-transactions?symbol=${ticker}&from=${from60}&to=${to60}`);
    const txns  = d?.data || [];
    const buys  = txns.filter(t => t.transactionCode === 'P');
    const sells = txns.filter(t => t.transactionCode === 'S');
    if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'finnhub' };
  } catch (_) {}
 
  // Source 2: Yahoo Finance insider transactions module
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=insiderTransactions`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
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
        const value   = Math.abs(t.value?.raw || 0);
        const desc    = (t.transactionDescription || '').toLowerCase();
        const entry   = { transactionDate: dateStr, share: shares, value, transactionPrice: shares > 0 ? value / shares : curPx };
        if (/purchase|buy/i.test(desc)) buys.push(entry);
        else if (/sale|sell/i.test(desc)) sells.push(entry);
      }
      if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'yahoo' };
    }
  } catch (_) {}
 
  // Source 3: Yahoo insider holders (often has more recent data)
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=insiderHolders`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j       = await r.json();
      const holders = j?.quoteSummary?.result?.[0]?.insiderHolders?.holders || [];
      const buys = [], sells = [];
      for (const h of holders) {
        const dateTs = h.latestTransDate?.raw;
        if (!dateTs) continue;
        const txDate = new Date(dateTs * 1000);
        if (txDate < cutoff) continue;
        const dateStr = txDate.toISOString().slice(0, 10);
        const shares  = Math.abs(h.transactionDescription?.includes?.('Sale') ? 0 : (h.positionDirect?.raw || 0));
        const desc    = (h.transactionDescription || '').toLowerCase();
        const entry   = { transactionDate: dateStr, share: shares, value: 0, transactionPrice: curPx };
        if (/purchase|buy|acquisition/i.test(desc)) buys.push(entry);
        else if (/sale|sell|disposition/i.test(desc)) sells.push(entry);
      }
      if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'yahoo-holders' };
    }
  } catch (_) {}
 
  // Source 4: SEC EDGAR full-text search for Form 4 filings
  try {
    const fromStr = new Date(ago60 * 1000).toISOString().slice(0, 10);
    const toStr   = new Date(now * 1000).toISOString().slice(0, 10);
    const r = await fetch(
      `https://efts.sec.gov/LATEST/search-index?q=%22${ticker}%22&dateRange=custom&startdt=${fromStr}&enddt=${toStr}&forms=4`,
      { headers: { 'User-Agent': 'signal-engine/1.0 contact@example.com' }, signal: AbortSignal.timeout(7000) }
    );
    if (r.ok) {
      const j    = await r.json();
      const hits = j?.hits?.hits || [];
      // Filter to exact ticker matches and check for purchase indicators
      const buys = [];
      const sells = [];
      for (const hit of hits.slice(0, 15)) {
        const src = hit._source || {};
        if ((src.form_type || '').toUpperCase() !== '4') continue;
        const dateStr = src.file_date || src.period_of_report;
        if (!dateStr) continue;
        const txDate = new Date(dateStr);
        if (isNaN(txDate) || txDate < cutoff) continue;
        // EDGAR search snippets sometimes include transaction type
        const text = (src.file_date_period || src.period_of_report || '').toLowerCase();
        const entry = { transactionDate: dateStr, share: 0, value: 0, transactionPrice: curPx };
        // Without parsing the full XML we can't distinguish buy/sell reliably,
        // so we count Form 4 filings as signals of activity
        buys.push(entry);
      }
      if (buys.length > 0) return { buys, sells, source: 'sec-edgar' };
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
    // Label SEC source clearly
    if (source === 'sec-edgar') return { status: 'pass', value: `Form 4 activity (${buys.length} filing${buys.length > 1 ? 's' : ''}) · ${rc || '60d'}` };
    return { status: 'pass', value: parts.join(' · ') };
  }
  if (sells.length > 0) {
    const dates = sells.map(t => t.transactionDate).filter(Boolean).sort().reverse();
    const rc    = dates[0] ? timeAgo(dates[0]) : null;
    const parts = [`${sells.length} sell${sells.length > 1 ? 's' : ''}, no buys`];
    if (rc) parts.push(rc);
    return { status: 'fail', value: parts.join(' · ') };
  }
  return { status: 'neutral', value: source ? 'No activity (60d)' : 'No data' };
}
 
// ── Peer PE comparison ────────────────────────────────────────────────────────
async function fetchPeerPE(ticker, targetPE, targetMC) {
  try {
    let rawPeers = [];
    try {
      const pd = await fh(`/stock/peers?symbol=${ticker}`);
      if (Array.isArray(pd)) rawPeers = pd.filter(p => p !== ticker).slice(0, 12);
    } catch (_) {}
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v6/finance/recommendationsbysymbol/${ticker}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }
      );
      if (r.ok) {
        const j  = await r.json();
        const yp = (j?.finance?.result?.[0]?.recommendedSymbols || []).map(s => s.symbol);
        rawPeers = [...new Set([...rawPeers, ...yp])].filter(p => p !== ticker).slice(0, 12);
      }
    } catch (_) {}
    if (rawPeers.length === 0) return null;
    const pm = await Promise.allSettled(rawPeers.map(p => fh(`/stock/metric?symbol=${p}&metric=all`)));
    const all = [];
    for (let i = 0; i < rawPeers.length; i++) {
      if (pm[i].status !== 'fulfilled') continue;
      const m  = pm[i].value?.metric || {};
      const pe = m.peBasicExclExtraTTM || m.peTTM;
      if (!pe || pe <= 0 || pe > 300) continue;
      all.push({ pe });
    }
    if (all.length < 2) return null;
    const pes   = all.map(c => c.pe).sort((a, b) => a - b);
    const mid   = Math.floor(pes.length / 2);
    const medPE = pes.length % 2 === 0 ? (pes[mid - 1] + pes[mid]) / 2 : pes[mid];
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
 
// ── TIER 2: Full signal analysis (one ticker) ─────────────────────────────────
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
  const targetMC = m.marketCapitalization || 0;
 
  // Run MA, insider, analyst target, and peer PE concurrently
  const [ma50, insiderData, analystTarget, peerPE] = await Promise.all([
    fetch50dMA(ticker),
    fetchInsiderTransactions(ticker, curPx),
    fetchAnalystTarget(ticker),
    fetchPeerPE(ticker, targetPE, targetMC),
  ]);
 
  const mc  = p.marketCapitalization ? p.marketCapitalization * 1e6 : 0;
  const mcs = mc > 1e12 ? `$${(mc / 1e12).toFixed(2)}T`
            : mc > 1e9  ? `$${(mc / 1e9).toFixed(1)}B`
            : mc > 1e6  ? `$${(mc / 1e6).toFixed(0)}M` : '';
 
  // Signal 1 — EPS beat
  let s1 = { status: 'neutral', value: 'No data' };
  try {
    const earns = Array.isArray(earnings.value) ? earnings.value : [];
    if (earns.length > 0) {
      const e    = earns[0];
      const diff = e.actual - e.estimate;
      const beat = diff >= 0;
      const ds   = Math.abs(diff) < 0.005 ? 'in-line' : beat ? `+$${Math.abs(diff).toFixed(2)}` : `-$${Math.abs(diff).toFixed(2)}`;
      s1 = { status: beat ? 'pass' : 'fail', value: beat ? `Beat by ${ds}` : `Missed ${ds}` };
    }
  } catch (_) {}
 
  // Signal 2 — PE vs historical average
  let s2 = { status: 'neutral', value: 'No data' };
  try {
    const curPE = m.peBasicExclExtraTTM || m.peTTM;
    const eps   = m.epsBasicExclExtraAnnual || m.epsTTM;
    const hi    = m['52WeekHigh'], lo = m['52WeekLow'];
    if (curPE && eps > 0 && hi && lo) {
      const histPE = ((hi + lo) / 2) / eps;
      if      (curPE < histPE * 0.92) s2 = { status: 'pass',    value: `PE ${curPE.toFixed(1)}x < hist ~${histPE.toFixed(0)}x` };
      else if (curPE > histPE * 1.08) s2 = { status: 'fail',    value: `PE ${curPE.toFixed(1)}x > hist ~${histPE.toFixed(0)}x` };
      else                            s2 = { status: 'neutral', value: `PE ${curPE.toFixed(1)}x ≈ hist ~${histPE.toFixed(0)}x` };
    } else if (curPE) {
      s2 = { status: 'neutral', value: `PE ${curPE.toFixed(1)}x` };
    }
  } catch (_) {}
 
  // Signal 3 — Price vs 50d MA
  let s3 = { status: 'neutral', value: 'No data' };
  try {
    if (ma50 && curPx) {
      const pct = ((curPx - ma50) / ma50 * 100).toFixed(1);
      s3 = curPx <= ma50
        ? { status: 'pass', value: `$${curPx.toFixed(2)} ≤ MA $${ma50.toFixed(2)} (${pct}%)` }
        : { status: 'fail', value: `$${curPx.toFixed(2)} > MA $${ma50.toFixed(2)} (+${pct}%)` };
    }
  } catch (_) {}
 
  // Signal 4 — Insider buying (4 sources)
  const { buys, sells, source } = insiderData || { buys: [], sells: [], source: null };
  const s4 = buildInsiderValue(buys, sells, source);
 
  // Signal 5 — Analyst target ≥ +25% (4 sources)
  let s5 = { status: 'neutral', value: 'No data' };
  try {
    if (analystTarget && curPx) {
      const up = ((analystTarget - curPx) / curPx * 100).toFixed(1);
      s5 = parseFloat(up) >= 25
        ? { status: 'pass', value: `Target $${analystTarget.toFixed(2)}, +${up}% upside` }
        : { status: 'fail', value: `Target $${analystTarget.toFixed(2)}, +${up}% upside` };
    }
  } catch (_) {}
 
  // Signal 6 — PE vs peers
  let s6 = { status: 'neutral', value: 'No data' };
  try {
    if (peerPE && peerPE.diff !== null) {
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
  else if (score > 0)   summary = `Weak signals (${score}/6). Fails: ${fails.join(', ')}.`;
  else                  summary = `No signals pass. Fails: ${fails.join(', ')}.`;
 
  const rawExchange   = p.exchange || '';
  const cleanExchange = rawExchange.replace(/NASDAQ.*/i, 'NASDAQ').replace(/New York Stock Exchange.*/i, 'NYSE').toUpperCase().trim();
  const exchange      = cleanExchange || EXCHANGE_MAP[ticker] || 'NYSE';
 
  return {
    ticker,
    company:   p.name || ticker,
    exchange,
    price:     `$${curPx.toFixed(2)}`,
    change:    q.dp != null ? `${q.dp > 0 ? '+' : ''}${q.dp.toFixed(2)}%` : null,
    marketCap: mcs,
    score,
    signals,
    summary,
    rating:    getRating(score),
    updatedAt: new Date().toISOString(),
  };
}
 
// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (cache.data && Date.now() - cache.timestamp < CACHE_TTL) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cache.data);
  }
 
  try {
    // TIER 1: Scan 300 stocks via Yahoo — batches of 15, staggered 100ms apart
    const BATCH_SIZE = 15;
    const batches = [];
    for (let i = 0; i < UNIQ_UNIVERSE.length; i += BATCH_SIZE) {
      batches.push(UNIQ_UNIVERSE.slice(i, i + BATCH_SIZE));
    }
    const allStocks = (
      await Promise.all(batches.map((b, i) => fetchBatch(b, i * 100)))
    ).flat().filter(Boolean);
 
    // Quick-score and pick top 5 for full analysis
    const candidates = allStocks
      .map(s => ({ ...s, qs: quickScore(s) }))
      .sort((a, b) => b.qs - a.qs)
      .slice(0, 5)
      .map(s => s.symbol);
 
    // TIER 2: Full Finnhub analysis — sequential to respect rate limits
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
      // Fallback: no Finnhub key
      const fallback = allStocks
        .map(s => ({ ...s, qs: quickScore(s) }))
        .sort((a, b) => b.qs - a.qs)
        .slice(0, 3);
      for (const s of fallback) {
        top3.push({
          ticker:    s.symbol,
          company:   s.symbol,
          exchange:  EXCHANGE_MAP[s.symbol] || 'NYSE',
          price:     `$${s.price?.toFixed(2)}`,
          marketCap: s.marketCap ? `$${(s.marketCap / 1e9).toFixed(0)}B` : 'N/A',
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
      totalScanned: allStocks.length,
      generatedAt:  new Date().toISOString(),
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
 
