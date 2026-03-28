// pages/api/analyse.js
// All 6-signal analysis. Called by the custom scan (POST from browser)
// and by top3.js (POST from browser after /api/top3 returns candidates).
 
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const FH = 'https://finnhub.io/api/v1';
 
// Full browser headers — Yahoo 403s without these on server-side requests
const YH = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
};
 
// ── Core fetch helpers ────────────────────────────────────────────────────────
 
async function fh(path) {
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
 
// Yahoo chart — fastest source, returns price + PE + 52w + closes
async function yahooChart(ticker, range = '1y') {
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(
        `${base}/v8/finance/chart/${ticker}?interval=1d&range=${range}`,
        { headers: YH, signal: AbortSignal.timeout(7000) }
      );
      if (!r.ok) continue;
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      if (res) return res;
    } catch (_) {}
  }
  return null;
}
 
// Yahoo quoteSummary — one shot, fastest domain first, no sequential retries
async function yahooModule(ticker, mod) {
  for (const url of [
    `https://query1.finance.yahoo.com/v11/finance/quoteSummary/${ticker}?modules=${mod}`,
    `https://query2.finance.yahoo.com/v11/finance/quoteSummary/${ticker}?modules=${mod}`,
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${mod}`,
  ]) {
    try {
      const r = await fetch(url, { headers: YH, signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const j = await r.json();
      const result = j?.quoteSummary?.result?.[0];
      if (result) return result;
    } catch (_) {}
  }
  return null;
}
 
// ── Format helpers ────────────────────────────────────────────────────────────
 
function fmtShares(n) {
  if (!n || n <= 0) return null;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M shares`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K shares`;
  return `${Math.round(n).toLocaleString()} shares`;
}
function fmtDollars(n) {
  if (!n || n <= 0) return null;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n)}`;
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
function maFromCloses(closes) {
  if (!Array.isArray(closes) || closes.length < 10) return null;
  const s = closes.slice(-50);
  return s.reduce((a, b) => a + b, 0) / s.length;
}
 
// ── Hardcoded peer map — guarantees peer PE even when APIs return nothing ─────
const PEERS = {
  AAPL: ['MSFT','GOOGL','META','AMZN','NVDA','SONY'],
  MSFT: ['AAPL','GOOGL','CRM','ORCL','SAP','IBM'],
  GOOGL:['META','MSFT','AMZN','SNAP','TTD','PINS'],
  AMZN: ['MSFT','GOOGL','BABA','WMT','COST','TGT'],
  META: ['GOOGL','SNAP','PINS','RDDT','TTD'],
  NVDA: ['AMD','INTC','QCOM','AVGO','TXN','MU'],
  TSLA: ['F','GM','RIVN','NIO','STLA','TM'],
  AVGO: ['QCOM','TXN','INTC','ADI','MRVL','AMD'],
  ORCL: ['SAP','MSFT','CRM','IBM','WDAY','NOW'],
  AMD:  ['NVDA','INTC','QCOM','TXN','MU','AVGO'],
  INTC: ['AMD','NVDA','QCOM','TXN','AVGO','MRVL'],
  QCOM: ['AVGO','TXN','ADI','MRVL','AMD','INTC'],
  JPM:  ['BAC','WFC','C','GS','MS','USB'],
  BAC:  ['JPM','WFC','C','USB','PNC','TFC'],
  WFC:  ['JPM','BAC','C','USB','PNC','COF'],
  GS:   ['MS','JPM','C','BLK','SCHW','RJF'],
  MS:   ['GS','JPM','C','BLK','SCHW','UBS'],
  BLK:  ['SCHW','MS','GS','IVZ','AMG','BEN'],
  LLY:  ['NVO','PFE','MRK','ABBV','BMY','REGN'],
  JNJ:  ['PFE','ABBV','MRK','TMO','ABT','MDT'],
  UNH:  ['CVS','CI','HUM','ELV','CNC','MOH'],
  ABBV: ['PFE','LLY','MRK','BMY','REGN','BIIB'],
  MRK:  ['PFE','JNJ','ABBV','LLY','BMY','NVO'],
  PFE:  ['MRK','JNJ','ABBV','BMY','LLY','AZN'],
  XOM:  ['CVX','COP','SLB','EOG','OXY','BP'],
  CVX:  ['XOM','COP','SLB','EOG','DVN','OXY'],
  COP:  ['EOG','XOM','CVX','DVN','OXY','HES'],
  HD:   ['LOW','WMT','TGT','COST','AMZN','TJX'],
  WMT:  ['TGT','COST','KR','HD','AMZN','DG'],
  MCD:  ['YUM','CMG','QSR','DRI','SHAK','WEN'],
  NKE:  ['ADDYY','PUMA','UAA','DECK','LULU','SKX'],
  KO:   ['PEP','MDLZ','MNST','KHC','TAP','STZ'],
  PEP:  ['KO','MDLZ','MNST','KHC','TAP','STZ'],
  PM:   ['MO','BTI','IMBBY','VGR','UVV'],
  MO:   ['PM','BTI','IMBBY','VGR'],
  T:    ['VZ','TMUS','CMCSA','CHTR','LUMN'],
  VZ:   ['T','TMUS','CMCSA','CHTR','LUMN'],
  TMUS: ['T','VZ','CMCSA','CHTR'],
  CAT:  ['DE','HON','EMR','ITW','PH','ROK'],
  DE:   ['CAT','AGCO','CNH','HON','EMR'],
  HON:  ['CAT','EMR','ITW','ROK','PH','ETN'],
  NEE:  ['DUK','SO','AEP','EXC','D','XEL'],
  AMT:  ['PLD','EQIX','CCI','SPG','O','VICI'],
  TMO:  ['DHR','A','WAT','BIO','IDXX','MTD'],
  COST: ['WMT','TGT','BJ','SFM','CASY'],
  SBUX: ['MCD','CMG','YUM','QSR','DRI'],
  IBM:  ['MSFT','ORCL','HPE','DXC','LDOS'],
};
 
// ── Signal data fetchers ──────────────────────────────────────────────────────
 
async function fetchAllYahooData(ticker) {
  // Fire chart (gives us price, PE, 52w, closes for MA) and summary in parallel
  const [chartResult, summaryResult] = await Promise.allSettled([
    yahooChart(ticker, '1y'),
    yahooModule(ticker, 'summaryDetail,defaultKeyStatistics,financialData,earningsTrend'),
  ]);
 
  const chart   = chartResult.status   === 'fulfilled' ? chartResult.value   : null;
  const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : null;
 
  const meta   = chart?.meta || {};
  const closes = chart?.indicators?.quote?.[0]?.close?.filter(c => c != null && !isNaN(c)) || [];
  const sd     = summary?.summaryDetail      || {};
  const ks     = summary?.defaultKeyStatistics || {};
  const fd     = summary?.financialData      || {};
  const et     = summary?.earningsTrend      || {};
 
  // Price
  const price = meta.regularMarketPrice || null;
 
  // PE ratio — from chart meta first, then summaryDetail, then defaultKeyStatistics
  const pe = (meta.trailingPE && meta.trailingPE > 0 && meta.trailingPE < 2000)
    ? meta.trailingPE
    : (sd.trailingPE?.raw && sd.trailingPE.raw > 0 ? sd.trailingPE.raw : null)
    ?? (ks.trailingPE?.raw && ks.trailingPE.raw > 0 ? ks.trailingPE.raw : null);
 
  // EPS (trailing twelve months)
  const eps = ks.trailingEps?.raw || null;
 
  // 52w hi/lo — chart meta first, then summaryDetail
  const hi52 = meta.fiftyTwoWeekHigh || sd.fiftyTwoWeekHigh?.raw
    || (closes.length > 0 ? Math.max(...closes) : null);
  const lo52 = meta.fiftyTwoWeekLow  || sd.fiftyTwoWeekLow?.raw
    || (closes.length > 0 ? Math.min(...closes) : null);
 
  // 50d MA from closes
  const ma50 = maFromCloses(closes);
 
  // Market cap
  const marketCap = meta.marketCap || sd.marketCap?.raw || 0;
 
  // Analyst target — financialData
  const analystTarget = fd.targetMedianPrice?.raw || fd.targetMeanPrice?.raw || null;
 
  // EPS beat from earningsTrend (most recent quarter actual vs estimate)
  let epsBeat = null;
  try {
    const trends = et.trend || [];
    const q = trends.find(t => t.period === '0q') || trends[0];
    if (q?.earningsEstimate?.avg?.raw != null && q?.revenueEstimate?.avg?.raw != null) {
      // earningsTrend doesn't give actuals; use ks for last actual
      const lastActual = ks.mostRecentQuarter?.raw ? null : null; // not reliable here
    }
  } catch (_) {}
 
  // Day change %
  const dayChange = meta.regularMarketChangePercent ?? null;
 
  // Exchange
  const exchange = meta.exchangeName || meta.fullExchangeName || '';
 
  return { price, pe, eps, hi52, lo52, ma50, marketCap, analystTarget, dayChange, exchange, closes };
}
 
async function fetchFinnhubData(ticker) {
  const [quote, profile, metrics, earnings] = await Promise.allSettled([
    fh(`/quote?symbol=${ticker}`),
    fh(`/stock/profile2?symbol=${ticker}`),
    fh(`/stock/metric?symbol=${ticker}&metric=all`),
    fh(`/stock/earnings?symbol=${ticker}&limit=4`),
  ]);
  return {
    quote:    quote.status    === 'fulfilled' ? quote.value    : null,
    profile:  profile.status  === 'fulfilled' ? profile.value  : null,
    metrics:  metrics.status  === 'fulfilled' ? metrics.value  : null,
    earnings: earnings.status === 'fulfilled' ? earnings.value : null,
  };
}
 
async function fetchInsiderTransactions(ticker, curPx) {
  const cutoff = new Date(Date.now() - 60 * 86400000);
 
  // Yahoo insider transactions
  try {
    const result = await yahooModule(ticker, 'insiderTransactions');
    const txns = result?.insiderTransactions?.transactions || [];
    const buys = [], sells = [];
    for (const t of txns) {
      const ts = t.startDate?.raw;
      if (!ts || new Date(ts * 1000) < cutoff) continue;
      const ds  = new Date(ts * 1000).toISOString().slice(0, 10);
      const sh  = Math.abs(t.shares?.raw || 0);
      const val = Math.abs(t.value?.raw  || 0);
      const desc = (t.transactionDescription || '').toLowerCase();
      const entry = { transactionDate: ds, share: sh, value: val,
        transactionPrice: sh > 0 ? val / sh : curPx };
      if (/purchase|buy/i.test(desc))      buys.push(entry);
      else if (/sale|sell/i.test(desc))    sells.push(entry);
    }
    if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'yahoo' };
  } catch (_) {}
 
  // Finnhub fallback
  try {
    const from = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    const to   = new Date().toISOString().slice(0, 10);
    const d    = await fh(`/stock/insider-transactions?symbol=${ticker}&from=${from}&to=${to}`);
    const txns = d?.data || [];
    const buys  = txns.filter(t => t.transactionCode === 'P');
    const sells = txns.filter(t => t.transactionCode === 'S');
    if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'finnhub' };
  } catch (_) {}
 
  return { buys: [], sells: [], source: null };
}
 
function buildInsiderValue(buys, sells) {
  if (buys.length > 0) {
    const totalShares = buys.reduce((s, t) => s + (t.share || 0), 0);
    const totalValue  = buys.reduce((s, t) => s + (t.value || (t.share || 0) * (t.transactionPrice || 0)), 0);
    const parts = [`${buys.length} buy${buys.length > 1 ? 's' : ''}`];
    const sh = fmtShares(totalShares); if (sh) parts.push(sh);
    const dl = fmtDollars(totalValue); if (dl) parts.push(dl);
    const rc = timeAgo(buys.map(t => t.transactionDate).filter(Boolean).sort().reverse()[0]);
    if (rc) parts.push(rc);
    return { status: 'pass', value: parts.join(' · ') };
  }
  if (sells.length > 0) {
    const recent = sells.filter(s => (Date.now() - new Date(s.transactionDate).getTime()) < 30 * 86400000);
    const rc = timeAgo(sells.map(t => t.transactionDate).filter(Boolean).sort().reverse()[0]);
    const parts = [`${sells.length} sell${sells.length > 1 ? 's' : ''}, no buys`];
    if (rc) parts.push(rc);
    return { status: recent.length > 0 ? 'fail' : 'neutral', value: parts.join(' · ') };
  }
  return { status: 'neutral', value: 'No activity (60d)' };
}
 
async function fetchPeerPE(ticker, targetPE, targetMC) {
  try {
    // Build peer list: hardcoded map + Yahoo recommendations + Finnhub peers
    let peers = [...(PEERS[ticker] || [])];
 
    await Promise.allSettled([
      // Yahoo recommendations
      fetch(`https://query1.finance.yahoo.com/v6/finance/recommendationsbysymbol/${ticker}`,
        { headers: YH, signal: AbortSignal.timeout(5000) })
        .then(r => r.ok ? r.json() : null)
        .then(j => {
          const yp = (j?.finance?.result?.[0]?.recommendedSymbols || []).map(s => s.symbol);
          peers.push(...yp);
        }),
      // Finnhub peers
      fh(`/stock/peers?symbol=${ticker}`)
        .then(pd => { if (Array.isArray(pd)) peers.push(...pd.filter(p => p !== ticker)); })
        .catch(() => {}),
    ]);
 
    peers = [...new Set(peers)].filter(p => p !== ticker).slice(0, 20);
    if (peers.length === 0) return null;
 
    // Fetch PE for each peer using Yahoo chart (fastest, no API key)
    const peerResults = await Promise.allSettled(
      peers.map(p =>
        yahooChart(p, '5d').then(res => {
          const meta = res?.meta || {};
          const pe   = meta.trailingPE;
          const mc   = meta.marketCap || 0;
          if (pe && pe > 0 && pe < 600) return { ticker: p, pe, mc };
          return null;
        }).catch(() => null)
      )
    );
 
    let valid = peerResults
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);
 
    if (valid.length < 2) return null;
 
    // Market-cap band filter
    if (targetMC > 0) {
      const lo = targetMC > 500e9 ? 0.08 : targetMC > 50e9 ? 0.12 : 0.2;
      const hi = targetMC > 500e9 ? 10   : targetMC > 50e9 ? 8    : 5;
      const banded = valid.filter(c => c.mc <= 0 || (c.mc / targetMC >= lo && c.mc / targetMC <= hi));
      if (banded.length >= 2) valid = banded;
    }
 
    // Trim PE outliers (top & bottom 10%)
    if (valid.length >= 6) {
      const sorted = [...valid].sort((a, b) => a.pe - b.pe);
      const trim   = Math.floor(sorted.length * 0.1);
      valid = sorted.slice(trim, sorted.length - trim);
    }
 
    if (valid.length < 2) return null;
 
    const pes     = valid.map(c => c.pe).sort((a, b) => a - b);
    const mid     = Math.floor(pes.length / 2);
    const median  = pes.length % 2 === 0 ? (pes[mid - 1] + pes[mid]) / 2 : pes[mid];
    const avg     = pes.reduce((a, b) => a + b, 0) / pes.length;
    const diff    = targetPE && targetPE > 0
      ? parseFloat(((targetPE - avg) / avg * 100).toFixed(1))
      : null;
 
    return {
      medianPE:  parseFloat(median.toFixed(1)),
      avgPE:     parseFloat(avg.toFixed(1)),
      peerCount: valid.length,
      diff,
      peers:     valid.map(c => c.ticker),
    };
  } catch (_) { return null; }
}
 
function getRating(score) {
  if (score >= 5) return { label: 'Strong Buy', color: '#14532d', bg: '#dcfce7', border: '#86efac' };
  if (score === 4) return { label: 'Buy',        color: '#15803d', bg: '#f0fdf4', border: '#bbf7d0' };
  if (score === 3) return { label: 'Watch',      color: '#92400e', bg: '#fffbeb', border: '#fde68a' };
  return               { label: 'Ignore',        color: '#6b7280', bg: '#f9fafb', border: '#d1d5db' };
}
 
// ── Main per-ticker analysis ──────────────────────────────────────────────────
async function analyseOne(ticker) {
  // Fire Yahoo (chart + summary) and Finnhub in parallel — neither blocks the other
  const [yahoo, fhData, insiderData] = await Promise.allSettled([
    fetchAllYahooData(ticker),
    fetchFinnhubData(ticker),
    fetchInsiderTransactions(ticker, null), // curPx filled in below
  ]);
 
  const yh  = yahoo.status   === 'fulfilled' ? yahoo.value   : {};
  const fhd = fhData.status  === 'fulfilled' ? fhData.value  : {};
  const ins = insiderData.status === 'fulfilled' ? insiderData.value : { buys: [], sells: [], source: null };
 
  const fhq  = fhd.quote    || {};
  const fhp  = fhd.profile  || {};
  const fhm  = fhd.metrics?.metric || {};
  const fhEarnings = Array.isArray(fhd.earnings) ? fhd.earnings : [];
 
  // ── Resolve best value for each field ──────────────────────────────────────
 
  // Price — Finnhub quote is authoritative (real-time), Yahoo as fallback
  const curPx = fhq.c || yh.price || null;
  if (!curPx) return null;
 
  // Day change %
  const dayChangePct = fhq.dp != null ? fhq.dp : yh.dayChange;
 
  // PE — Yahoo chart/summary (usually works), Finnhub metric fallback
  // BUG FIX: was previously assigning trailingEps to curPE
  const pe = yh.pe
    || (fhm.peBasicExclExtraTTM > 0 ? fhm.peBasicExclExtraTTM : null)
    || (fhm.peTTM > 0 ? fhm.peTTM : null)
    || null;
 
  // EPS — Finnhub epsBasicExclExtraAnnual is most reliable, Yahoo trailingEps fallback
  const eps = (fhm.epsBasicExclExtraAnnual || fhm.epsTTM || yh.eps || null);
 
  // 52w range
  const hi52 = yh.hi52 || fhm['52WeekHigh'] || null;
  const lo52 = yh.lo52 || fhm['52WeekLow']  || null;
 
  // 50d MA — Yahoo closes (already computed), Finnhub candle fallback
  let ma50 = yh.ma50 || null;
  if (!ma50) {
    try {
      const candle = await fh(`/stock/candle?symbol=${ticker}&resolution=D&count=60`);
      if (candle?.s === 'ok' && Array.isArray(candle.c)) ma50 = maFromCloses(candle.c);
    } catch (_) {}
  }
 
  // Market cap
  const marketCap = yh.marketCap
    || (fhm.marketCapitalization ? fhm.marketCapitalization * 1e6 : 0)
    || (fhp.marketCapitalization ? fhp.marketCapitalization * 1e6 : 0);
 
  // Analyst target
  let analystTarget = yh.analystTarget || null;
  if (!analystTarget) {
    try {
      const d = await fh(`/stock/price-target?symbol=${ticker}`);
      analystTarget = d?.targetMedian || d?.targetMean || null;
    } catch (_) {}
  }
 
  // Company name + exchange
  const company = fhp.name || ticker;
  const rawEx   = (fhp.exchange || yh.exchange || '')
    .replace(/NASDAQ.*/i, 'NASDAQ').replace(/New York Stock Exchange.*/i, 'NYSE').toUpperCase().trim();
 
  // Market cap formatted
  const mcs = marketCap > 1e12 ? `$${(marketCap / 1e12).toFixed(2)}T`
    : marketCap > 1e9  ? `$${(marketCap / 1e9).toFixed(1)}B`
    : marketCap > 1e6  ? `$${(marketCap / 1e6).toFixed(0)}M` : '';
 
  // Peer PE — fire after we have pe + marketCap
  const peerPE = await fetchPeerPE(ticker, pe, marketCap);
 
  // ── Build 6 signals ────────────────────────────────────────────────────────
 
  // S1: EPS beat (Finnhub earnings — actual vs estimate)
  let s1 = { status: 'neutral', value: 'No data' };
  try {
    if (fhEarnings.length > 0) {
      const e = fhEarnings[0];
      if (e.actual != null && e.estimate != null) {
        const diff = e.actual - e.estimate;
        const beat = diff >= 0;
        const label = Math.abs(diff) < 0.005 ? 'in-line'
          : beat ? `+$${Math.abs(diff).toFixed(2)}` : `-$${Math.abs(diff).toFixed(2)}`;
        s1 = { status: beat ? 'pass' : 'fail',
               value: beat ? `Beat by ${label}` : `Missed ${label}` };
      }
    }
  } catch (_) {}
 
  // S2: PE vs historical average (midpoint of 52w range / EPS)
  let s2 = { status: 'neutral', value: 'No data' };
  try {
    if (pe && pe > 0 && eps && eps > 0 && hi52 && lo52) {
      const histPE = ((hi52 + lo52) / 2) / eps;
      if (histPE > 0 && histPE < 1000) {
        if (pe < histPE * 0.92)      s2 = { status: 'pass',    value: `PE ${pe.toFixed(1)}x < hist ~${histPE.toFixed(0)}x` };
        else if (pe > histPE * 1.08) s2 = { status: 'fail',    value: `PE ${pe.toFixed(1)}x > hist ~${histPE.toFixed(0)}x` };
        else                          s2 = { status: 'neutral', value: `PE ${pe.toFixed(1)}x ≈ hist ~${histPE.toFixed(0)}x` };
      }
    } else if (pe && pe > 0) {
      s2 = { status: 'neutral', value: `PE ${pe.toFixed(1)}x` };
    }
  } catch (_) {}
 
  // S3: Price vs 50d MA
  let s3 = { status: 'neutral', value: 'No data' };
  try {
    if (ma50 && curPx) {
      const pct = ((curPx - ma50) / ma50 * 100).toFixed(1);
      s3 = curPx <= ma50
        ? { status: 'pass', value: `$${curPx.toFixed(2)} ≤ MA $${ma50.toFixed(2)} (${pct}%)` }
        : { status: 'fail', value: `$${curPx.toFixed(2)} > MA $${ma50.toFixed(2)} (+${pct}%)` };
    }
  } catch (_) {}
 
  // S4: Insider buying
  const s4 = buildInsiderValue(ins.buys || [], ins.sells || []);
 
  // S5: Analyst price target ≥ +25% upside
  let s5 = { status: 'neutral', value: 'No data' };
  try {
    if (analystTarget && curPx) {
      const up = ((analystTarget - curPx) / curPx * 100).toFixed(1);
      s5 = parseFloat(up) >= 25
        ? { status: 'pass', value: `Target $${analystTarget.toFixed(2)}, +${up}% upside` }
        : { status: 'fail', value: `Target $${analystTarget.toFixed(2)}, ${up}% upside` };
    }
  } catch (_) {}
 
  // S6: PE vs peers
  let s6 = { status: 'neutral', value: 'No data' };
  try {
    const pp = peerPE;
    if (pp && pp.diff !== null) {
      if (pp.diff < -8)      s6 = { status: 'pass',    value: `${Math.abs(pp.diff).toFixed(0)}% < peer avg ${pp.avgPE}x (n=${pp.peerCount})` };
      else if (pp.diff > 8)  s6 = { status: 'fail',    value: `${Math.abs(pp.diff).toFixed(0)}% > peer avg ${pp.avgPE}x (n=${pp.peerCount})` };
      else                   s6 = { status: 'neutral', value: `In line w/ peers ${pp.avgPE}x (n=${pp.peerCount})` };
    } else if (pp?.medianPE) {
      s6 = { status: 'neutral', value: `Peer median ${pp.medianPE}x` };
    }
  } catch (_) {}
 
  const signals = [s1, s2, s3, s4, s5, s6];
  const score   = signals.filter(s => s.status === 'pass').length;
  const NAMES   = ['EPS beat','Low PE','Below 50d MA','Insider buying','Analyst upside','PE vs peers'];
  const passes  = signals.map((s, i) => s.status === 'pass' ? NAMES[i] : null).filter(Boolean);
  const fails   = signals.map((s, i) => s.status === 'fail' ? NAMES[i] : null).filter(Boolean);
 
  let summary;
  if (score >= 5)       summary = `Strong value candidate — ${score}/6 signals pass. Strengths: ${passes.join(', ')}.`;
  else if (score === 4) summary = `Good signals (4/6). Passes: ${passes.join(', ')}.`;
  else if (score === 3) summary = `Moderate signals (3/6). Passes: ${passes.join(', ')}.`;
  else if (score > 0)   summary = `Weak signals (${score}/6). Passes: ${passes.join(', ')}. Fails: ${fails.join(', ')}.`;
  else                  summary = `No signals pass. Fails: ${fails.join(', ')}.`;
 
  return {
    ticker, company,
    exchange:  rawEx || 'NYSE',
    price:     `$${curPx.toFixed(2)}`,
    change:    dayChangePct != null ? `${dayChangePct > 0 ? '+' : ''}${dayChangePct.toFixed(2)}%` : null,
    marketCap: mcs,
    score, signals, summary,
    rating:    getRating(score),
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
  const cleaned = [...new Set(tickers.slice(0, 20).map(t => t.toUpperCase().trim()))];
 
  await Promise.allSettled(cleaned.map(async ticker => {
    try {
      const ev = await analyseOne(ticker);
      results[ticker] = ev || { ticker, error: 'No price data' };
    } catch (e) {
      results[ticker] = { ticker, error: e.message };
    }
  }));
 
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
  return res.status(200).json({ results, fetchedAt: new Date().toISOString() });
}
 
