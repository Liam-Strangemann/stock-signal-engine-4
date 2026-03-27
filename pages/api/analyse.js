// pages/api/analyse.js
// Single source of truth for all 6-signal analysis.
// Used by custom scan AND called directly from the browser for top picks.
 
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const FH = 'https://finnhub.io/api/v1';
 
// Full browser headers — Yahoo blocks requests without these
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
  if (!res.ok) throw new Error(`Finnhub ${res.status}`);
  const d = await res.json();
  if (d?.error) throw new Error(d.error);
  return d;
}
 
// ── Yahoo quoteSummary — tries v11 then v10, both query domains ───────────────
async function yahooSummary(ticker, modules) {
  const mod = Array.isArray(modules) ? modules.join(',') : modules;
  for (const base of [
    `https://query1.finance.yahoo.com`,
    `https://query2.finance.yahoo.com`,
  ]) {
    for (const ver of ['v11', 'v10']) {
      try {
        const r = await fetch(
          `${base}/finance/quoteSummary/${ticker}?modules=${mod}`,
          { headers: YH, signal: AbortSignal.timeout(7000) }
        );
        if (r.ok) {
          const j = await r.json();
          const result = j?.quoteSummary?.result?.[0];
          if (result) return result;
        }
      } catch (_) {}
    }
  }
  return null;
}
 
// ── Format helpers ────────────────────────────────────────────────────────────
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
  if (days < 7) return `${days}d ago`;
  if (days < 14) return '1w ago';
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
 
// ── 50d MA — Yahoo chart primary (with full headers), Finnhub candle fallback ─
function maFromCloses(closes) {
  if (!Array.isArray(closes) || closes.length < 10) return null;
  const s = closes.slice(-50);
  return s.reduce((a, b) => a + b, 0) / s.length;
}
 
async function fetch50dMA(ticker) {
  // Primary: Yahoo chart with full browser headers
  try {
    const now = Math.floor(Date.now() / 1000);
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&period1=${now - 100 * 86400}&period2=${now}`,
      { headers: YH, signal: AbortSignal.timeout(7000) }
    );
    if (r.ok) {
      const j = await r.json();
      const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c => c != null && !isNaN(c));
      const ma = maFromCloses(closes);
      if (ma > 0) return ma;
    }
  } catch (_) {}
  // Secondary: query2
  try {
    const now = Math.floor(Date.now() / 1000);
    const r = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&period1=${now - 100 * 86400}&period2=${now}`,
      { headers: YH, signal: AbortSignal.timeout(7000) }
    );
    if (r.ok) {
      const j = await r.json();
      const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c => c != null && !isNaN(c));
      const ma = maFromCloses(closes);
      if (ma > 0) return ma;
    }
  } catch (_) {}
  // Fallback: Finnhub candle
  try {
    const d = await fh(`/stock/candle?symbol=${ticker}&resolution=D&count=60`);
    if (d?.s === 'ok' && Array.isArray(d.c) && d.c.length >= 10) {
      const ma = maFromCloses(d.c);
      if (ma > 0) return ma;
    }
  } catch (_) {}
  return null;
}
 
// ── 52-week high/low — Yahoo chart fallback when Finnhub metric is null ───────
async function fetch52wRange(ticker) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`,
      { headers: YH, signal: AbortSignal.timeout(7000) }
    );
    if (r.ok) {
      const j = await r.json();
      const meta = j?.chart?.result?.[0]?.meta;
      if (meta?.fiftyTwoWeekHigh && meta?.fiftyTwoWeekLow) {
        return { hi: meta.fiftyTwoWeekHigh, lo: meta.fiftyTwoWeekLow };
      }
      // Compute from closes if meta fields missing
      const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c => c != null && !isNaN(c));
      if (closes && closes.length > 10) {
        return { hi: Math.max(...closes), lo: Math.min(...closes) };
      }
    }
  } catch (_) {}
  try {
    const result = await yahooSummary(ticker, 'summaryDetail');
    const sd = result?.summaryDetail;
    if (sd?.fiftyTwoWeekHigh?.raw && sd?.fiftyTwoWeekLow?.raw) {
      return { hi: sd.fiftyTwoWeekHigh.raw, lo: sd.fiftyTwoWeekLow.raw };
    }
  } catch (_) {}
  return null;
}
 
// ── Analyst price target — Finnhub → Yahoo financialData ──────────────────────
async function fetchAnalystTarget(ticker) {
  // Finnhub first
  try {
    const d = await fh(`/stock/price-target?symbol=${ticker}`);
    const t = d?.targetMedian || d?.targetMean;
    if (t && t > 0) return t;
  } catch (_) {}
  // Yahoo financialData
  try {
    const result = await yahooSummary(ticker, 'financialData');
    const fd = result?.financialData;
    const t = fd?.targetMedianPrice?.raw || fd?.targetMeanPrice?.raw;
    if (t && t > 0) return t;
  } catch (_) {}
  return null;
}
 
// ── Insider transactions — Yahoo → Finnhub ────────────────────────────────────
async function fetchInsiderTransactions(ticker, curPx) {
  const cutoff = new Date(Date.now() - 60 * 86400000);
 
  // Yahoo insiderTransactions
  try {
    const result = await yahooSummary(ticker, 'insiderTransactions');
    const txns = result?.insiderTransactions?.transactions || [];
    const buys = [], sells = [];
    for (const t of txns) {
      const ts = t.startDate?.raw;
      if (!ts || new Date(ts * 1000) < cutoff) continue;
      const ds = new Date(ts * 1000).toISOString().slice(0, 10);
      const sh = Math.abs(t.shares?.raw || 0);
      const val = Math.abs(t.value?.raw || 0);
      const desc = (t.transactionDescription || '').toLowerCase();
      const entry = { transactionDate: ds, share: sh, value: val, transactionPrice: sh > 0 ? val / sh : curPx };
      if (/purchase|buy/i.test(desc)) buys.push(entry);
      else if (/sale|sell/i.test(desc)) sells.push(entry);
    }
    if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'yahoo' };
  } catch (_) {}
 
  // Finnhub fallback
  try {
    const now = Math.floor(Date.now() / 1000);
    const from = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const d = await fh(`/stock/insider-transactions?symbol=${ticker}&from=${from}&to=${to}`);
    const txns = d?.data || [];
    const buys = txns.filter(t => t.transactionCode === 'P');
    const sells = txns.filter(t => t.transactionCode === 'S');
    if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'finnhub' };
  } catch (_) {}
 
  return { buys: [], sells: [], source: null };
}
 
function buildInsiderValue(buys, sells, source) {
  if (buys.length > 0) {
    const totalShares = buys.reduce((s, t) => s + (t.share || 0), 0);
    const totalValue = buys.reduce((s, t) => s + (t.value || Math.abs((t.share || 0) * (t.transactionPrice || 0))), 0);
    const parts = [`${buys.length} buy${buys.length > 1 ? 's' : ''}`];
    const sh = fmtShares(totalShares); if (sh) parts.push(sh);
    const dl = fmtDollars(totalValue); if (dl) parts.push(dl);
    const dates = buys.map(t => t.transactionDate).filter(Boolean).sort().reverse();
    const rc = timeAgo(dates[0]); if (rc) parts.push(rc);
    return { status: 'pass', value: parts.join(' · ') };
  }
  if (sells.length > 0) {
    const dates = sells.map(t => t.transactionDate).filter(Boolean).sort().reverse();
    const rc = timeAgo(dates[0]);
    const recentSells = sells.filter(s => (Date.now() - new Date(s.transactionDate).getTime()) < 30 * 86400000);
    const parts = [`${sells.length} sell${sells.length > 1 ? 's' : ''}, no buys`];
    if (rc) parts.push(rc);
    return { status: recentSells.length > 0 ? 'fail' : 'neutral', value: parts.join(' · ') };
  }
  return { status: 'neutral', value: source ? 'No activity (60d)' : 'No data' };
}
 
// ── Peer PE comparison ────────────────────────────────────────────────────────
// Strategy: get peers from multiple sources, fetch their PE from Yahoo (not Finnhub)
// to avoid rate limits. Filter by same industry + market-cap band.
async function fetchPeerPE(ticker, targetPE, targetMC, targetIndustry) {
  try {
    let rawPeers = [];
 
    // Source A: Yahoo recommended symbols
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v6/finance/recommendationsbysymbol/${ticker}`,
        { headers: YH, signal: AbortSignal.timeout(6000) }
      );
      if (r.ok) {
        const j = await r.json();
        const yp = (j?.finance?.result?.[0]?.recommendedSymbols || []).map(s => s.symbol);
        rawPeers = [...rawPeers, ...yp];
      }
    } catch (_) {}
 
    // Source B: Finnhub peers
    try {
      const pd = await fh(`/stock/peers?symbol=${ticker}`);
      if (Array.isArray(pd)) rawPeers = [...rawPeers, ...pd.filter(p => p !== ticker)];
    } catch (_) {}
 
    // Source C: If still thin, use a hardcoded industry peer map for common tickers
    const INDUSTRY_PEERS = {
      // Tech
      AAPL:  ['MSFT','GOOGL','META','AMZN','NVDA'],
      MSFT:  ['AAPL','GOOGL','CRM','ORCL','SAP'],
      GOOGL: ['META','MSFT','AMZN','SNAP','TTD'],
      META:  ['GOOGL','SNAP','PINS','TWTR','TTD'],
      NVDA:  ['AMD','INTC','QCOM','AVGO','TXN'],
      AMD:   ['NVDA','INTC','QCOM','AVGO','MU'],
      // Finance
      JPM:   ['BAC','WFC','C','GS','MS'],
      BAC:   ['JPM','WFC','C','USB','PNC'],
      GS:    ['MS','JPM','C','BLK','SCHW'],
      // Healthcare
      LLY:   ['NVO','PFE','MRK','ABBV','BMY'],
      JNJ:   ['PFE','ABBV','MRK','TMO','ABT'],
      UNH:   ['CVS','CI','HUM','ELV','CNC'],
      // Energy
      XOM:   ['CVX','COP','SLB','EOG','OXY'],
      CVX:   ['XOM','COP','SLB','EOG','DVN'],
      // Consumer
      HD:    ['LOW','WMT','TGT','COST','AMZN'],
      WMT:   ['TGT','COST','KR','HD','AMZN'],
      // Pharma
      PFE:   ['MRK','JNJ','ABBV','BMY','LLY'],
      ABBV:  ['PFE','LLY','MRK','BMY','REGN'],
      // Industrials
      CAT:   ['DE','HON','EMR','ITW','PH'],
      // Telecom
      T:     ['VZ','TMUS','CMCSA','CHTR'],
      VZ:    ['T','TMUS','CMCSA','CHTR'],
      // Beverages/Consumer
      KO:    ['PEP','MDLZ','MNST','KHC'],
      PEP:   ['KO','MDLZ','MNST','KHC'],
    };
    if (INDUSTRY_PEERS[ticker]) {
      rawPeers = [...new Set([...rawPeers, ...INDUSTRY_PEERS[ticker]])];
    }
 
    rawPeers = [...new Set(rawPeers)].filter(p => p !== ticker).slice(0, 18);
    if (rawPeers.length === 0) return null;
 
    // Fetch PE for each peer — use Yahoo quoteSummary (no rate limit)
    const peerData = await Promise.allSettled(
      rawPeers.map(async p => {
        // Try Yahoo chart meta first (fastest)
        try {
          const r = await fetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${p}?interval=1d&range=5d`,
            { headers: YH, signal: AbortSignal.timeout(5000) }
          );
          if (r.ok) {
            const j = await r.json();
            const meta = j?.chart?.result?.[0]?.meta;
            const pe = meta?.trailingPE;
            const mc = meta?.marketCap;
            if (pe && pe > 0 && pe < 500) return { ticker: p, pe, mc: mc || 0 };
          }
        } catch (_) {}
        // Fallback: Finnhub metric
        try {
          const d = await fh(`/stock/metric?symbol=${p}&metric=all`);
          const pm = d?.metric || {};
          const pe = pm.peBasicExclExtraTTM || pm.peTTM;
          const mc = (pm.marketCapitalization || 0) * 1e6;
          if (pe && pe > 0 && pe < 500) return { ticker: p, pe, mc };
        } catch (_) {}
        return null;
      })
    );
 
    const validPeers = peerData
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)
      .filter(p => p.pe > 0 && p.pe < 500);
 
    if (validPeers.length < 2) return null;
 
    // Market-cap band filter — keep peers within 0.15x–6.5x of target
    let comparables = validPeers;
    if (targetMC > 0) {
      const loRatio = targetMC > 500e9 ? 0.1 : targetMC > 50e9 ? 0.15 : 0.2;
      const hiRatio = targetMC > 500e9 ? 8 : targetMC > 50e9 ? 6 : 5;
      const filtered = validPeers.filter(c => c.mc <= 0 || (c.mc / targetMC >= loRatio && c.mc / targetMC <= hiRatio));
      if (filtered.length >= 2) comparables = filtered;
    }
 
    // Trim outliers
    if (comparables.length >= 5) {
      const sorted = [...comparables].sort((a, b) => a.pe - b.pe);
      const trim = Math.max(1, Math.floor(sorted.length * 0.1));
      comparables = sorted.slice(trim, sorted.length - trim);
    }
 
    if (comparables.length < 2) return null;
 
    const pes = comparables.map(c => c.pe).sort((a, b) => a - b);
    const mid = Math.floor(pes.length / 2);
    const medianPE = pes.length % 2 === 0 ? (pes[mid - 1] + pes[mid]) / 2 : pes[mid];
    const avgPE = pes.reduce((a, b) => a + b, 0) / pes.length;
    const diff = targetPE && targetPE > 0 ? parseFloat(((targetPE - avgPE) / avgPE * 100).toFixed(1)) : null;
 
    return {
      medianPE: parseFloat(medianPE.toFixed(1)),
      avgPE: parseFloat(avgPE.toFixed(1)),
      peerCount: comparables.length,
      diff,
      peers: comparables.map(c => c.ticker),
    };
  } catch (_) { return null; }
}
 
// ── Rating ────────────────────────────────────────────────────────────────────
function getRating(score) {
  if (score >= 5) return { label: 'Strong Buy', color: '#14532d', bg: '#dcfce7', border: '#86efac' };
  if (score === 4) return { label: 'Buy', color: '#15803d', bg: '#f0fdf4', border: '#bbf7d0' };
  if (score === 3) return { label: 'Watch', color: '#92400e', bg: '#fffbeb', border: '#fde68a' };
  return { label: 'Ignore', color: '#6b7280', bg: '#f9fafb', border: '#d1d5db' };
}
 
// ── Fetch all data for one ticker ─────────────────────────────────────────────
async function fetchStockData(ticker) {
  // Fire all independent requests in parallel
  const [quote, profile, metrics, earnings, yahooData, range52w] = await Promise.allSettled([
    fh(`/quote?symbol=${ticker}`),
    fh(`/stock/profile2?symbol=${ticker}`),
    fh(`/stock/metric?symbol=${ticker}&metric=all`),
    fh(`/stock/earnings?symbol=${ticker}&limit=4`),
    yahooSummary(ticker, ['summaryDetail', 'defaultKeyStatistics', 'financialData'].join(',')),
    fetch52wRange(ticker),
  ]);
 
  const curPx = quote.status === 'fulfilled' ? quote.value?.c : null;
  const m = metrics.status === 'fulfilled' ? metrics.value?.metric || {} : {};
 
  // Enrich 52w hi/lo — Finnhub metric first, Yahoo fallback
  let hi52 = m['52WeekHigh'];
  let lo52 = m['52WeekLow'];
  if ((!hi52 || !lo52) && range52w.status === 'fulfilled' && range52w.value) {
    hi52 = range52w.value.hi;
    lo52 = range52w.value.lo;
  }
  // Also check Yahoo summaryDetail
  if (!hi52 || !lo52) {
    const sd = yahooData.status === 'fulfilled' ? yahooData.value?.summaryDetail : null;
    if (sd?.fiftyTwoWeekHigh?.raw) hi52 = sd.fiftyTwoWeekHigh.raw;
    if (sd?.fiftyTwoWeekLow?.raw) lo52 = sd.fiftyTwoWeekLow.raw;
  }
 
  // PE — Finnhub first, then Yahoo
  let curPE = m.peBasicExclExtraTTM || m.peTTM;
  if (!curPE) {
    const ks = yahooData.status === 'fulfilled' ? yahooData.value?.defaultKeyStatistics : null;
    const sd = yahooData.status === 'fulfilled' ? yahooData.value?.summaryDetail : null;
    curPE = ks?.trailingEps?.raw || sd?.trailingPE?.raw || null;
  }
 
  // EPS — Finnhub first, then Yahoo
  let eps = m.epsBasicExclExtraAnnual || m.epsTTM;
  if (!eps) {
    const ks = yahooData.status === 'fulfilled' ? yahooData.value?.defaultKeyStatistics : null;
    eps = ks?.trailingEps?.raw || null;
  }
 
  const targetPE = curPE;
  const marketCapRaw = m.marketCapitalization
    ? m.marketCapitalization * 1e6
    : (yahooData.status === 'fulfilled' ? (yahooData.value?.summaryDetail?.marketCap?.raw || 0) : 0);
  const targetMargin = m.netProfitMarginAnnual || m.netProfitMarginTTM || 0;
 
  // Industry from profile
  const industry = profile.status === 'fulfilled' ? (profile.value?.finnhubIndustry || '') : '';
 
  // Fire dependent fetches in parallel
  const [ma50, insiderData, analystTarget, peerPE] = await Promise.all([
    fetch50dMA(ticker),
    fetchInsiderTransactions(ticker, curPx),
    fetchAnalystTarget(ticker),
    fetchPeerPE(ticker, targetPE, marketCapRaw, industry),
  ]);
 
  return {
    quote: quote.status === 'fulfilled' ? quote.value : null,
    profile: profile.status === 'fulfilled' ? profile.value : null,
    metrics: metrics.status === 'fulfilled' ? metrics.value : null,
    earnings: earnings.status === 'fulfilled' ? earnings.value : null,
    hi52, lo52, curPE, eps, marketCapRaw,
    ma50, insiderData, analystTarget, peerPE,
  };
}
 
// ── Evaluate all 6 signals ────────────────────────────────────────────────────
function evaluate(ticker, d) {
  const q = d.quote || {};
  const p = d.profile || {};
  const m = d.metrics?.metric || {};
  const curPx = q.c;
  if (!curPx) return null;
 
  const company = p.name || ticker;
  const mc = d.marketCapRaw || 0;
  const mcs = mc > 1e12 ? `$${(mc / 1e12).toFixed(2)}T` : mc > 1e9 ? `$${(mc / 1e9).toFixed(1)}B` : mc > 1e6 ? `$${(mc / 1e6).toFixed(0)}M` : '';
  const rawEx = (p.exchange || '').replace(/NASDAQ.*/i, 'NASDAQ').replace(/New York Stock Exchange.*/i, 'NYSE').toUpperCase().trim();
 
  // ── S1: EPS beat ─────────────────────────────────────────────────────────
  let s1 = { status: 'neutral', value: 'No data' };
  try {
    const earns = Array.isArray(d.earnings) ? d.earnings : [];
    if (earns.length > 0) {
      const e = earns[0];
      if (e.actual != null && e.estimate != null) {
        const diff = e.actual - e.estimate;
        const beat = diff >= 0;
        const ds = Math.abs(diff) < 0.005 ? 'in-line' : beat ? `+$${Math.abs(diff).toFixed(2)}` : `-$${Math.abs(diff).toFixed(2)}`;
        s1 = { status: beat ? 'pass' : 'fail', value: beat ? `Beat by ${ds}` : `Missed ${ds}` };
      }
    }
  } catch (_) {}
 
  // ── S2: PE vs historical average ─────────────────────────────────────────
  // Uses 52w hi+lo to estimate a midpoint "historical" PE for comparison.
  // Now uses enriched hi52/lo52 from Yahoo fallback.
  let s2 = { status: 'neutral', value: 'No data' };
  try {
    const curPE = d.curPE;
    const eps   = d.eps;
    const hi    = d.hi52;
    const lo    = d.lo52;
    if (curPE && curPE > 0 && eps && eps > 0 && hi && lo) {
      const histPE = ((hi + lo) / 2) / eps;
      if (histPE > 0 && histPE < 500) {
        if (curPE < histPE * 0.92)      s2 = { status: 'pass',    value: `PE ${curPE.toFixed(1)}x < hist ~${histPE.toFixed(0)}x` };
        else if (curPE > histPE * 1.08) s2 = { status: 'fail',    value: `PE ${curPE.toFixed(1)}x > hist ~${histPE.toFixed(0)}x` };
        else                             s2 = { status: 'neutral', value: `PE ${curPE.toFixed(1)}x ≈ hist ~${histPE.toFixed(0)}x` };
      }
    } else if (curPE && curPE > 0) {
      s2 = { status: 'neutral', value: `PE ${curPE.toFixed(1)}x` };
    }
  } catch (_) {}
 
  // ── S3: Price vs 50d MA ───────────────────────────────────────────────────
  let s3 = { status: 'neutral', value: 'No data' };
  try {
    if (d.ma50 && curPx) {
      const pct = ((curPx - d.ma50) / d.ma50 * 100).toFixed(1);
      s3 = curPx <= d.ma50
        ? { status: 'pass', value: `$${curPx.toFixed(2)} ≤ MA $${d.ma50.toFixed(2)} (${pct}%)` }
        : { status: 'fail', value: `$${curPx.toFixed(2)} > MA $${d.ma50.toFixed(2)} (+${pct}%)` };
    }
  } catch (_) {}
 
  // ── S4: Insider buying ───────────────────────────────────────────────────
  const { buys, sells, source } = d.insiderData || { buys: [], sells: [], source: null };
  const s4 = buildInsiderValue(buys, sells, source);
 
  // ── S5: Analyst price target ≥ +15% upside ───────────────────────────────
  let s5 = { status: 'neutral', value: 'No data' };
  try {
    if (d.analystTarget && curPx) {
      const up = ((d.analystTarget - curPx) / curPx * 100).toFixed(1);
      s5 = parseFloat(up) >= 15
        ? { status: 'pass', value: `Target $${d.analystTarget.toFixed(2)}, +${up}% upside` }
        : { status: 'fail', value: `Target $${d.analystTarget.toFixed(2)}, +${up}% upside` };
    }
  } catch (_) {}
 
  // ── S6: PE vs peers ──────────────────────────────────────────────────────
  let s6 = { status: 'neutral', value: 'No data' };
  try {
    const pp = d.peerPE;
    if (pp && pp.diff !== null) {
      if (pp.diff < -8)      s6 = { status: 'pass',    value: `${Math.abs(pp.diff).toFixed(0)}% < peer avg ${pp.avgPE}x (${pp.peerCount} peers)` };
      else if (pp.diff > 8)  s6 = { status: 'fail',    value: `${Math.abs(pp.diff).toFixed(0)}% > peer avg ${pp.avgPE}x (${pp.peerCount} peers)` };
      else                   s6 = { status: 'neutral', value: `In line w/ peers ${pp.avgPE}x` };
    } else if (pp?.medianPE) {
      s6 = { status: 'neutral', value: `Peer median ${pp.medianPE}x` };
    }
  } catch (_) {}
 
  const signals = [s1, s2, s3, s4, s5, s6];
  const score = signals.filter(s => s.status === 'pass').length;
  const SIG_NAMES = ['EPS beat', 'Low PE', 'Below 50d MA', 'Insider buying', 'Analyst upside', 'PE vs peers'];
  const passes = signals.map((s, i) => s.status === 'pass' ? SIG_NAMES[i] : null).filter(Boolean);
  const fails  = signals.map((s, i) => s.status === 'fail' ? SIG_NAMES[i] : null).filter(Boolean);
 
  let summary;
  if (score >= 5)      summary = `Strong value candidate — ${score}/6 signals pass. Strengths: ${passes.join(', ')}.`;
  else if (score === 4) summary = `Good signals (4/6). Passes: ${passes.join(', ')}.`;
  else if (score === 3) summary = `Moderate signals (3/6). Passes: ${passes.join(', ')}.`;
  else if (score > 0)   summary = `Weak signals (${score}/6). Passes: ${passes.join(', ')}. Fails: ${fails.join(', ')}.`;
  else                  summary = `No signals pass. Fails: ${fails.join(', ')}.`;
 
  return {
    ticker, company,
    exchange: rawEx || 'NYSE',
    price: `$${curPx.toFixed(2)}`,
    change: q.dp != null ? `${q.dp > 0 ? '+' : ''}${q.dp.toFixed(2)}%` : null,
    marketCap: mcs,
    score, signals, summary,
    rating: getRating(score),
    updatedAt: new Date().toISOString(),
  };
}
 
// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!FINNHUB_KEY) return res.status(500).json({ error: 'FINNHUB_KEY not set' });
 
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
 
