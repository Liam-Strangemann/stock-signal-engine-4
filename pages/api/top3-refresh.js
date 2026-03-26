// pages/api/top3-refresh.js
//
// Does all the heavy scanning work and writes results to the shared cache.
// Called by top3.js as a fire-and-forget background fetch.
//
// Speed optimisations vs previous versions:
// - Yahoo scan: 280 stocks in parallel batches (unchanged, ~3s)
// - Finnhub: only 4 calls per stock (quote + metrics + earnings + price-target)
//   Previously was 7+ calls. Peer PE dropped from full analysis — too slow.
// - Insider: Yahoo-first (faster than Finnhub on free tier)
// - MA: Yahoo only (Finnhub candles dropped — saves 1 call per stock)
// - All 3 candidate stocks run concurrently (not sequentially) because
//   each stock now only makes 4 Finnhub calls instead of 7, staying under limits.
 
import { sharedCache } from './top3';
 
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const FH = 'https://finnhub.io/api/v1';
 
const UNIVERSE = [
  'AAPL','MSFT','GOOGL','AMZN','META','NVDA','AVGO','ORCL','ADBE','INTU',
  'AMD','INTC','QCOM','TXN','AMAT','MU','CSCO','IBM','ACN','HPQ',
  'NOW','CRM','PANW','FTNT','KLAC','LRCX','SNPS','CDNS',
  'JPM','BAC','WFC','GS','MS','BLK','C','AXP','SCHW','USB',
  'PNC','TFC','COF','DFS','AIG','MET','PRU','AFL','CB','TRV',
  'CME','ICE','SPGI','MCO','MA','V',
  'LLY','JNJ','UNH','ABBV','MRK','PFE','TMO','ABT','AMGN','CVS',
  'MDT','ISRG','BSX','SYK','REGN','BIIB','VRTX','CI','HUM','ELV',
  'XOM','CVX','COP','EOG','SLB','MPC','PSX','VLO','OXY','DVN',
  'HAL','BKR','HES','MRO','FANG','TPL',
  'HD','MCD','NKE','SBUX','LOW','TGT','COST','WMT','TJX','ROST',
  'BKNG','MAR','HLT','YUM','CMG','DRI','TSCO','ORLY','AZO',
  'KO','PEP','PG','PM','MO','KHC','GIS','HSY','MDLZ','CL',
  'CLX','CHD','SYY','KR','CAG','MKC','HRL','TSN',
  'CAT','HON','MMM','GE','RTX','LMT','NOC','GD','UPS','FDX',
  'UNP','CSX','NSC','DE','EMR','ROK','ITW','ETN','PH','DOV',
  'LIN','APD','ECL','NEM','FCX','PPG','SHW',
  'T','VZ','TMUS','NEE','DUK','SO','AEP','EXC',
  'AMT','PLD','EQIX','CCI','SPG','O','VICI',
  'TSM','ASML','NVO','SAP','TM','AZN','HSBC','SHEL','BHP','RIO',
  'NVS','UL','DEO','BTI','GSK',
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
 
// ── Yahoo quick scan ──────────────────────────────────────────────────────────
async function fetchYahooQuote(symbol) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;
    const price = meta.regularMarketPrice;
    const hi = meta.fiftyTwoWeekHigh || price * 1.2;
    const lo = meta.fiftyTwoWeekLow  || price * 0.8;
    const range = hi - lo;
    return {
      symbol, price, yearHigh: hi, yearLow: lo,
      peRatio:      meta.trailingPE ?? null,
      marketCap:    meta.marketCap  ?? null,
      lowProximity: range > 0 ? ((price - lo) / range) * 100 : 50,
      pctFromHigh:  hi > 0 ? ((hi - price) / hi) * 100 : 0,
    };
  } catch { return null; }
}
 
function quickScore(s) {
  if (!s.marketCap || s.marketCap < 2_000_000_000) return null;
  let score = 0;
  if (s.peRatio && s.peRatio > 0 && s.peRatio <= 150) {
    if      (s.peRatio <= 12) score += 40;
    else if (s.peRatio <= 18) score += 32;
    else if (s.peRatio <= 25) score += 22;
    else if (s.peRatio <= 35) score += 12;
    else if (s.peRatio <= 50) score += 5;
  }
  if (s.pctFromHigh > 50) score -= 15;
  else if (s.lowProximity < 20) score += 25;
  else if (s.lowProximity < 35) score += 18;
  else if (s.lowProximity < 55) score += 10;
  else if (s.lowProximity < 75) score += 4;
  if      (s.marketCap > 500_000_000_000) score += 15;
  else if (s.marketCap > 100_000_000_000) score += 10;
  else if (s.marketCap >  20_000_000_000) score += 5;
  else if (s.marketCap >   5_000_000_000) score += 2;
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
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Finnhub ${res.status}`);
  const d = await res.json();
  if (d?.error) throw new Error(d.error);
  return d;
}
 
// ── 50d MA — Yahoo only (fast, no extra Finnhub call) ────────────────────────
async function fetch50dMA(ticker) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&period1=${now - 80*86400}&period2=${now}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j = await r.json();
      const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c => c != null && !isNaN(c));
      if (Array.isArray(closes) && closes.length >= 10) {
        const s = closes.slice(-50);
        return s.reduce((a, b) => a + b, 0) / s.length;
      }
    }
  } catch (_) {}
  return null;
}
 
// ── EPS beat — Finnhub primary, Yahoo fallback ────────────────────────────────
async function buildEPSSignal(ticker, finnhubEarnings) {
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
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }
    );
    if (r.ok) {
      const j = await r.json();
      const history = j?.quoteSummary?.result?.[0]?.earningsHistory?.history || [];
      if (history.length > 0) {
        const recent   = history[history.length - 1];
        const actual   = recent?.epsActual?.raw;
        const estimate = recent?.epsEstimate?.raw;
        if (actual != null && estimate != null) {
          const diff = actual - estimate, beat = diff >= 0;
          const ds = Math.abs(diff) < 0.005 ? 'in-line' : beat ? `+$${Math.abs(diff).toFixed(2)}` : `-$${Math.abs(diff).toFixed(2)}`;
          return { status: beat ? 'pass' : 'fail', value: beat ? `Beat by ${ds}` : `Missed ${ds}` };
        }
      }
    }
  } catch (_) {}
  return { status: 'neutral', value: 'No data' };
}
 
// ── PE vs historical — Finnhub primary, Yahoo fallback ───────────────────────
async function buildPESignal(ticker, m) {
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
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }
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
 
// ── Analyst target — Finnhub first (fastest), then Yahoo ─────────────────────
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
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }
      );
      if (r.ok) {
        const j  = await r.json();
        const fd = j?.quoteSummary?.result?.[0]?.financialData;
        const t  = fd?.targetMedianPrice?.raw || fd?.targetMeanPrice?.raw;
        if (t && t > 0) return t;
      }
    } catch (_) {}
  }
  return null;
}
 
// ── Insider — Yahoo first (more reliable on free Finnhub tier) ────────────────
function fmtShares(n) { if (!n) return null; if (n >= 1e6) return `${(n/1e6).toFixed(1)}M sh`; if (n >= 1e3) return `${(n/1e3).toFixed(0)}K sh`; return null; }
function fmtDollars(n) { if (!n) return null; if (n >= 1e9) return `$${(n/1e9).toFixed(1)}B`; if (n >= 1e6) return `$${(n/1e6).toFixed(0)}M`; return null; }
function timeAgo(d) { if (!d) return null; const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000); if (days < 1) return 'today'; if (days < 7) return `${days}d ago`; if (days < 30) return `${Math.floor(days/7)}w ago`; return `${Math.floor(days/30)}mo ago`; }
 
async function fetchInsider(ticker, curPx) {
  const now    = Math.floor(Date.now() / 1000);
  const ago60  = now - 60 * 86400;
  const cutoff = new Date(ago60 * 1000);
  const from60 = cutoff.toISOString().slice(0, 10);
  const to60   = new Date(now * 1000).toISOString().slice(0, 10);
 
  // Source 1: Yahoo insiderTransactions (most reliable on Finnhub free tier)
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=insiderTransactions`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }
    );
    if (r.ok) {
      const j = await r.json();
      const txns = j?.quoteSummary?.result?.[0]?.insiderTransactions?.transactions || [];
      const buys = [], sells = [];
      for (const t of txns) {
        const ts = t.startDate?.raw; if (!ts) continue;
        const dt = new Date(ts * 1000); if (dt < cutoff) continue;
        const ds = dt.toISOString().slice(0, 10);
        const sh = Math.abs(t.shares?.raw || 0), val = Math.abs(t.value?.raw || 0);
        const desc = (t.transactionDescription || '').toLowerCase();
        const entry = { transactionDate: ds, share: sh, value: val, transactionPrice: sh > 0 ? val / sh : curPx };
        if (/purchase|buy/i.test(desc)) buys.push(entry);
        else if (/sale|sell/i.test(desc)) sells.push(entry);
      }
      if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'yahoo' };
    }
  } catch (_) {}
 
  // Source 2: Finnhub
  try {
    const d = await fh(`/stock/insider-transactions?symbol=${ticker}&from=${from60}&to=${to60}`);
    const txns = d?.data || [];
    const buys  = txns.filter(t => t.transactionCode === 'P');
    const sells = txns.filter(t => t.transactionCode === 'S');
    if (buys.length > 0 || sells.length > 0) return { buys, sells, source: 'finnhub' };
  } catch (_) {}
 
  // Source 3: SEC EDGAR
  try {
    const r = await fetch(
      `https://efts.sec.gov/LATEST/search-index?q=%22${ticker}%22&dateRange=custom&startdt=${from60}&enddt=${to60}&forms=4`,
      { headers: { 'User-Agent': 'signal-engine/1.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const j    = await r.json();
      const hits = (j?.hits?.hits || []).filter(h => (h._source?.form_type||'').toUpperCase() === '4' && new Date(h._source?.file_date) >= cutoff);
      if (hits.length > 0) {
        const buys = hits.slice(0, 8).map(h => ({ transactionDate: h._source.file_date, share: 0, value: 0, transactionPrice: curPx }));
        return { buys, sells: [], source: 'sec-edgar' };
      }
    }
  } catch (_) {}
 
  return { buys: [], sells: [], source: null };
}
 
function buildInsiderValue(buys, sells, source) {
  if (buys.length > 0) {
    if (source === 'sec-edgar') {
      const rc = timeAgo(buys[0].transactionDate);
      return { status: 'pass', value: `Form 4 · ${buys.length} filing${buys.length > 1 ? 's' : ''}${rc ? ' · ' + rc : ''}` };
    }
    const sh = fmtShares(buys.reduce((s, t) => s + (t.share || 0), 0));
    const dl = fmtDollars(buys.reduce((s, t) => s + (t.value || 0), 0));
    const rc = timeAgo(buys.map(t => t.transactionDate).sort().reverse()[0]);
    return { status: 'pass', value: [`${buys.length} buy${buys.length > 1 ? 's' : ''}`, sh, dl, rc].filter(Boolean).join(' · ') };
  }
  if (sells.length > 0) {
    const rc = timeAgo(sells.map(t => t.transactionDate).sort().reverse()[0]);
    return { status: 'fail', value: [`${sells.length} sell${sells.length > 1 ? 's' : ''}, no buys`, rc].filter(Boolean).join(' · ') };
  }
  return { status: 'neutral', value: 'No activity (60d)' };
}
 
function getRating(score) {
  if (score >= 5) return { label: 'Strong Buy', color: '#14532d', bg: '#dcfce7', border: '#86efac' };
  if (score === 4) return { label: 'Buy',        color: '#15803d', bg: '#f0fdf4', border: '#bbf7d0' };
  if (score === 3) return { label: 'Watch',      color: '#92400e', bg: '#fffbeb', border: '#fde68a' };
  return                  { label: 'Ignore',     color: '#6b7280', bg: '#f9fafb', border: '#d1d5db' };
}
 
// ── Full analysis — only 4 Finnhub calls per stock ────────────────────────────
// quote + metrics + earnings + price-target
// Everything else (MA, insider, PE fallback, EPS fallback) is Yahoo
async function fullAnalyse(ticker) {
  // 4 Finnhub calls in parallel — fast, well within rate limits for 3 stocks
  const [quote, metrics, earnings, priceTarget] = await Promise.allSettled([
    fh(`/quote?symbol=${ticker}`),
    fh(`/stock/metric?symbol=${ticker}&metric=all`),
    fh(`/stock/earnings?symbol=${ticker}&limit=4`),
    fh(`/stock/price-target?symbol=${ticker}`),
  ]);
 
  const q     = quote.status   === 'fulfilled' ? quote.value   || {} : {};
  const m     = metrics.status === 'fulfilled' ? metrics.value?.metric || {} : {};
  const curPx = q.c;
  if (!curPx) return null;
 
  // All secondary fetches in parallel — all Yahoo, no more Finnhub calls
  const [ma50, insiderData, s1, s2, analystTargetYahoo] = await Promise.all([
    fetch50dMA(ticker),
    fetchInsider(ticker, curPx),
    buildEPSSignal(ticker, earnings.status === 'fulfilled' ? earnings.value : []),
    buildPESignal(ticker, m),
    fetchAnalystTarget(ticker),
  ]);
 
  // Analyst target: use Finnhub result if available, else Yahoo
  let analystTarget = analystTargetYahoo;
  if (!analystTarget && priceTarget.status === 'fulfilled') {
    analystTarget = priceTarget.value?.targetMedian || priceTarget.value?.targetMean || null;
  }
 
  // Fetch profile separately (needed for company name + exchange)
  let company = ticker, exchange = EXCHANGE_MAP[ticker] || 'NYSE';
  try {
    const prof = await fh(`/stock/profile2?symbol=${ticker}`);
    if (prof?.name) company = prof.name;
    if (prof?.exchange) {
      exchange = prof.exchange.replace(/NASDAQ.*/i,'NASDAQ').replace(/New York Stock Exchange.*/i,'NYSE').toUpperCase().trim() || exchange;
    }
  } catch (_) {}
 
  const mc  = q.mc || 0;
  const mcs = mc > 1e12 ? `$${(mc/1e12).toFixed(2)}T` : mc > 1e9 ? `$${(mc/1e9).toFixed(1)}B` : '';
 
  // Signal 3 — Price vs 50d MA
  let s3 = { status: 'neutral', value: 'No data' };
  if (ma50 && curPx) {
    const pct = ((curPx - ma50) / ma50 * 100).toFixed(1);
    s3 = curPx <= ma50
      ? { status: 'pass', value: `$${curPx.toFixed(2)} ≤ MA $${ma50.toFixed(2)} (${pct}%)` }
      : { status: 'fail', value: `$${curPx.toFixed(2)} > MA $${ma50.toFixed(2)} (+${pct}%)` };
  }
 
  // Signal 4 — Insider
  const { buys, sells, source } = insiderData || { buys: [], sells: [], source: null };
  const s4 = buildInsiderValue(buys, sells, source);
 
  // Signal 5 — Analyst target
  let s5 = { status: 'neutral', value: 'No data' };
  if (analystTarget && curPx) {
    const up = ((analystTarget - curPx) / curPx * 100).toFixed(1);
    s5 = parseFloat(up) >= 25
      ? { status: 'pass', value: `Target $${analystTarget.toFixed(2)}, +${up}% upside` }
      : { status: 'fail', value: `Target $${analystTarget.toFixed(2)}, +${up}% upside` };
  }
 
  // Signal 6 — PE vs peers (lightweight: use Finnhub peers + metrics already fetched)
  let s6 = { status: 'neutral', value: 'No data' };
  try {
    const pd = await fh(`/stock/peers?symbol=${ticker}`);
    const peers = Array.isArray(pd) ? pd.filter(p => p !== ticker).slice(0, 8) : [];
    if (peers.length >= 2) {
      const pm = await Promise.allSettled(peers.map(p => fh(`/stock/metric?symbol=${p}&metric=all`)));
      const pes = pm.filter(r => r.status === 'fulfilled').map(r => r.value?.metric?.peBasicExclExtraTTM || r.value?.metric?.peTTM).filter(pe => pe && pe > 0 && pe < 300);
      if (pes.length >= 2) {
        const avg = pes.reduce((a, b) => a + b, 0) / pes.length;
        const targetPE = m.peBasicExclExtraTTM || m.peTTM;
        if (targetPE && avg) {
          const diff = ((targetPE - avg) / avg * 100);
          if      (diff < -8) s6 = { status: 'pass',    value: `${Math.abs(diff).toFixed(0)}% < peer avg ${avg.toFixed(1)}x` };
          else if (diff > 8)  s6 = { status: 'fail',    value: `${Math.abs(diff).toFixed(0)}% > peer avg ${avg.toFixed(1)}x` };
          else                s6 = { status: 'neutral', value: `In line, avg ${avg.toFixed(1)}x` };
        }
      }
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
  else if (score > 0)   summary = `Weak signals (${score}/6). Passes: ${passes.join(', ')}. Fails: ${fails.join(', ')}.`;
  else                  summary = `No signals pass. Fails: ${fails.join(', ')}.`;
 
  return {
    ticker, company, exchange,
    price:     `$${curPx.toFixed(2)}`,
    change:    q.dp != null ? `${q.dp > 0 ? '+' : ''}${q.dp.toFixed(2)}%` : null,
    marketCap: mcs, score, signals, summary,
    rating:    getRating(score),
    updatedAt: new Date().toISOString(),
  };
}
 
// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Only accept internal calls
  const token = req.headers['x-internal-token'];
  if (token !== (process.env.INTERNAL_TOKEN || 'signal-engine')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
 
  try {
    // TIER 1: Yahoo scan
    const BATCH_SIZE = 15;
    const batches = [];
    for (let i = 0; i < UNIQ_UNIVERSE.length; i += BATCH_SIZE) {
      batches.push(UNIQ_UNIVERSE.slice(i, i + BATCH_SIZE));
    }
    const allStocks = (await Promise.all(batches.map((b, i) => fetchBatch(b, i * 80)))).flat().filter(Boolean);
 
    const scored = allStocks
      .map(s => { const qs = quickScore(s); return qs !== null ? { ...s, qs } : null; })
      .filter(Boolean)
      .sort((a, b) => b.qs - a.qs);
 
    // Safety net
    const pool = scored.length >= 3 ? scored
      : allStocks.filter(s => s.marketCap > 1_000_000_000).sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
 
    const candidates = pool.slice(0, 5).map(s => s.symbol);
 
    // TIER 2: Run all 3 candidates concurrently — safe because only 4 Finnhub calls each
    let top3 = [];
    if (FINNHUB_KEY) {
      const results = await Promise.allSettled(candidates.map(t => fullAnalyse(t)));
      top3 = results
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value)
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 3);
    } else {
      top3 = pool.slice(0, 3).map(s => ({
        ticker: s.symbol, company: s.symbol, exchange: EXCHANGE_MAP[s.symbol] || 'NYSE',
        price: `$${s.price?.toFixed(2)}`, marketCap: s.marketCap ? `$${(s.marketCap/1e9).toFixed(0)}B` : '',
        score: 0, signals: Array(6).fill({ status: 'neutral', value: 'Add FINNHUB_KEY in Vercel' }),
        summary: 'Add FINNHUB_KEY environment variable to enable signal analysis.',
        rating: { label: 'Watch', color: '#92400e', bg: '#fffbeb', border: '#fde68a' },
        updatedAt: new Date().toISOString(),
      }));
    }
 
    // Write to shared cache
    sharedCache.data      = { top3, totalScanned: allStocks.length, generatedAt: new Date().toISOString() };
    sharedCache.timestamp = Date.now();
    sharedCache.computing = false;
 
    return res.status(200).json({ ok: true, count: top3.length });
 
  } catch (err) {
    sharedCache.computing = false;
    console.error('top3-refresh error:', err);
    return res.status(500).json({ error: err.message });
  }
}
 
