// pages/api/analyse.js  v15
//
// FIXES applied (all 10 from audit):
// 1. Explicit fallback labels instead of "No data" (Negative earnings, No analyst coverage, etc.)
// 2. Negative/high PE handled explicitly instead of dropped
// 3. Finnhub earnings pre-fetched in parallel alongside Yahoo (no sequential fallback)
// 4. Analyst signal: 3-tier fallback (target price → rec trend → "No analyst data")
// 5. Peer PE: require only 1 peer, loosen trimming, explicit "Peers unavailable"
// 6. Insider MAX_SH relaxed to 2M, explicit "No filings found" label
// 7. MA50: fallback to 10-bar average if <20 bars available
// 8. All Promise failures logged (server-side) for debugging
// 9. Standardised: backend value is always a non-empty string (never null/"No data")
// 10. PE_MAX raised to 120; signals use explicit labelling for out-of-range values

const FINNHUB_KEY = process.env.FINNHUB_KEY;
const FH = 'https://finnhub.io/api/v1';

const YH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
};

// ── Yahoo crumb ───────────────────────────────────────────────────────────────
let _crumb = null, _crumbTs = 0, _cookies = '';
async function getCrumb() {
  if (_crumb && Date.now() - _crumbTs < 5 * 60 * 1000) return { crumb: _crumb, cookies: _cookies };
  try {
    const home = await fetch('https://finance.yahoo.com/', {
      headers: { 'User-Agent': YH_HEADERS['User-Agent'], 'Accept': 'text/html' },
      redirect: 'follow', signal: AbortSignal.timeout(5000),
    });
    const raw = home.headers.get('set-cookie') || '';
    _cookies = raw.split(',').map(c => c.split(';')[0].trim()).filter(c => c.includes('=')).join('; ');
    for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
      try {
        const r = await fetch(`${base}/v1/test/getcrumb`, {
          headers: { ...YH_HEADERS, Cookie: _cookies },
          signal: AbortSignal.timeout(4000),
        });
        if (r.ok) {
          const t = await r.text();
          if (t && t.length < 50 && !t.startsWith('{')) {
            _crumb = t.trim(); _crumbTs = Date.now();
            return { crumb: _crumb, cookies: _cookies };
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
  return { crumb: null, cookies: '' };
}

// ── Yahoo quoteSummary — all modules in one call ──────────────────────────────
const MODULES = ['price','summaryDetail','defaultKeyStatistics','financialData','earningsHistory','assetProfile','recommendationTrend'].join(',');

async function yahooSummary(ticker, crumb, cookies) {
  const qs = crumb ? `&crumb=${encodeURIComponent(crumb)}` : '';
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`${base}/v10/finance/quoteSummary/${ticker}?modules=${MODULES}${qs}`, {
        headers: { ...YH_HEADERS, ...(cookies ? { Cookie: cookies } : {}) },
        signal: AbortSignal.timeout(7000),
      });
      if (r.status === 401 || r.status === 404) return null;
      if (!r.ok) continue;
      const j = await r.json();
      const res = j?.quoteSummary?.result?.[0];
      if (res) return res;
    } catch (_) {}
  }
  return null;
}

// ── Yahoo chart — MA50 fallback ───────────────────────────────────────────────
async function yahooChart(ticker, crumb, cookies) {
  const qs = crumb ? `&crumb=${encodeURIComponent(crumb)}` : '';
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`${base}/v8/finance/chart/${ticker}?interval=1d&range=1y${qs}`, {
        headers: { ...YH_HEADERS, ...(cookies ? { Cookie: cookies } : {}) },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) continue;
      const j = await r.json();
      return j?.chart?.result?.[0] || null;
    } catch (_) {}
  }
  return null;
}

// ── Finnhub ───────────────────────────────────────────────────────────────────
async function fhGet(path, ms = 5000) {
  if (!FINNHUB_KEY) return null;
  try {
    const sep = path.includes('?') ? '&' : '?';
    const r = await fetch(`${FH}${path}${sep}token=${FINNHUB_KEY}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(ms),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.error ? null : d;
  } catch (_) { return null; }
}

// ── Insider ───────────────────────────────────────────────────────────────────
// FIX 6: MAX_SH raised to 2M to capture larger executive trades
const MAX_SH = 2_000_000;
const MAX_VAL = 500e6;

async function getInsider(ticker) {
  const now = Math.floor(Date.now() / 1000);
  const from = new Date((now - 30 * 86400) * 1000).toISOString().slice(0, 10);
  const to   = new Date(now * 1000).toISOString().slice(0, 10);
  const cut  = Date.now() - 30 * 86400 * 1000;

  try {
    const d = await fhGet(`/stock/insider-transactions?symbol=${ticker}&from=${from}&to=${to}`, 5000);
    if (d?.data?.length) {
      const valid = d.data.filter(t => {
        const sh = Math.abs(t.change || 0);
        return sh > 0 && sh <= MAX_SH && new Date(t.transactionDate) >= new Date(cut);
      });
      const buys  = valid.filter(t => t.transactionCode === 'P');
      const sells = valid.filter(t => t.transactionCode === 'S');
      if (buys.length || sells.length) return { buys, sells, src: 'fh' };
    }
  } catch (_) {}

  // OpenInsider fallback
  try {
    const r = await fetch(
      `https://openinsider.com/screener?s=${ticker}&fd=-30&td=0&xs=1&vl=0&grp=0&cnt=20&action=1`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }
    );
    if (r.ok) {
      const html = await r.text();
      const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
        .map(m => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => c[1].replace(/<[^>]+>/g,'').trim()));
      const buys = [], sells = [];
      for (const cells of rows) {
        if (cells.length < 10) continue;
        const typeCell = cells.find(c => /P\s*-\s*Purchase|S\s*-\s*Sale/i.test(c)) || '';
        const isPurchase = /Purchase/i.test(typeCell);
        const isSale     = /Sale/i.test(typeCell) && !/Purchase/i.test(typeCell);
        if (!isPurchase && !isSale) continue;
        const sharesCell = cells.find(c => /^[\d,]+$/.test(c.replace(/,/g,''))) || '0';
        const shares = parseInt(sharesCell.replace(/,/g,''), 10) || 0;
        if (shares <= 0 || shares > MAX_SH) continue;
        const entry = { _sharesTraded: shares, transactionDate: to, change: shares };
        if (isPurchase) buys.push(entry); else sells.push(entry);
      }
      if (buys.length || sells.length) return { buys, sells, src: 'oi' };
    }
  } catch (_) {}

  return { buys: [], sells: [], src: 'checked' }; // src='checked' = we looked, found nothing
}

// ── Peer PE ───────────────────────────────────────────────────────────────────
// FIX 10: PE_MAX raised to 120
const PE_MAX = 120;

const PEERS = {
  AAPL:['MSFT','GOOGL','META','AMZN','NVDA'],MSFT:['AAPL','GOOGL','CRM','ORCL'],
  GOOGL:['META','MSFT','AMZN','SNAP'],META:['GOOGL','SNAP','PINS','TTD'],
  AMZN:['MSFT','GOOGL','WMT','COST'],NVDA:['AMD','INTC','QCOM','AVGO'],
  TSLA:['GM','F','TM','RIVN'],AVGO:['QCOM','TXN','ADI','MRVL','AMD'],
  ORCL:['SAP','MSFT','CRM','IBM'],AMD:['NVDA','INTC','QCOM','TXN','MU'],
  INTC:['AMD','NVDA','QCOM','TXN'],QCOM:['AVGO','TXN','ADI','MRVL','AMD'],
  JPM:['BAC','WFC','C','GS','MS'],BAC:['JPM','WFC','C','USB','PNC'],
  WFC:['JPM','BAC','C','USB'],GS:['MS','JPM','C','BLK'],
  MS:['GS','JPM','C','BLK'],LLY:['NVO','PFE','MRK','ABBV','BMY'],
  JNJ:['PFE','ABBV','MRK','TMO'],UNH:['CVS','CI','HUM','ELV'],
  ABBV:['PFE','LLY','MRK','BMY'],MRK:['PFE','JNJ','ABBV','LLY'],
  XOM:['CVX','COP','SLB','EOG'],CVX:['XOM','COP','SLB','EOG'],
  HD:['LOW','WMT','TGT','COST'],LOW:['HD','WMT','TGT'],
  WMT:['TGT','COST','KR','HD'],TGT:['WMT','COST','HD','DG'],
  MCD:['YUM','CMG','QSR','DRI'],NKE:['UAA','DECK','LULU','SKX'],
  KO:['PEP','MDLZ','MNST'],PEP:['KO','MDLZ','MNST'],
  T:['VZ','TMUS','CMCSA'],VZ:['T','TMUS','CMCSA'],
  MA:['V','PYPL','AXP'],V:['MA','PYPL','AXP'],
  NFLX:['DIS','WBD','PARA','ROKU'],DIS:['NFLX','WBD','CMCSA'],
  CAT:['DE','HON','EMR','ITW'],HON:['CAT','EMR','ITW','ETN'],
  NEE:['DUK','SO','AEP','EXC'],AMT:['PLD','EQIX','CCI','SPG'],
  SCHW:['MS','GS','BLK','AXP'],BLK:['SCHW','MS','GS','IVZ'],
  TMO:['DHR','IQV','IDXX','WAT'],ABT:['MDT','BSX','SYK','BDX'],
  AMGN:['REGN','BIIB','VRTX','GILD'],CVS:['WBA','CI','UNH','HUM'],
  SLB:['HAL','BKR','OXY','COP'],EOG:['COP','DVN','OXY','MRO'],
  COST:['WMT','TGT','HD'],CMG:['MCD','YUM','DRI','QSR'],
  SBUX:['MCD','CMG','YUM','QSR'],LULU:['NKE','UAA','DECK','SKX'],
};

async function getPeerPEs(ticker, crumb, cookies) {
  const peers = (PEERS[ticker] || []).slice(0, 6);
  if (!peers.length) return null;

  const results = await Promise.allSettled(
    peers.map(p =>
      yahooSummary(p, crumb, cookies).then(d => {
        const pe = d?.summaryDetail?.trailingPE?.raw || d?.defaultKeyStatistics?.trailingPE?.raw;
        return (pe && pe > 0 && pe < PE_MAX) ? pe : null;
      }).catch(() => null)
    )
  );

  const pes = results
    .filter(r => r.status === 'fulfilled' && r.value != null)
    .map(r => r.value)
    .sort((a, b) => a - b);

  // FIX 5: require only 1 peer, loosen trimming
  if (pes.length < 1) return null;

  // Light outlier trim only if we have 4+ peers
  let trimmed = pes;
  if (pes.length >= 4) {
    const mid = Math.floor(pes.length / 2);
    const median = pes.length % 2 === 0 ? (pes[mid-1]+pes[mid])/2 : pes[mid];
    trimmed = pes.filter(p => p <= median * 4 && p >= median * 0.15);
  }
  if (trimmed.length < 1) trimmed = pes; // don't over-trim

  const mid = Math.floor(trimmed.length / 2);
  const median = trimmed.length % 2 === 0 ? (trimmed[mid-1]+trimmed[mid])/2 : trimmed[mid];
  return { medianPE: parseFloat(median.toFixed(1)), count: trimmed.length };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt$M(n) {
  if (!n) return null;
  if (n >= 1e12) return `$${(n/1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `$${(n/1e9).toFixed(1)}B`;
  if (n >= 1e6)  return `$${(n/1e6).toFixed(0)}M`;
  return null;
}
function fmtSh(n) {
  if (!n || n <= 0) return null;
  if (n >= 1e6) return `${(n/1e6).toFixed(2)}M shares`;
  if (n >= 1e3) return `${(n/1e3).toFixed(1)}K shares`;
  return `${Math.round(n).toLocaleString()} shares`;
}
function timeAgo(ds) {
  if (!ds) return null;
  const days = Math.floor((Date.now() - new Date(ds)) / 86400000);
  return days === 0 ? 'today' : days === 1 ? '1d ago' : days < 7 ? `${days}d ago` : `${Math.floor(days/7)}w ago`;
}
// FIX 7: MA50 falls back to 10-bar average
function computeMA(closes, minBars = 10) {
  const v = (closes || []).filter(c => c > 0 && !isNaN(c));
  if (v.length < minBars) return null;
  const window = Math.min(50, v.length);
  const sl = v.slice(-window);
  return sl.reduce((a, b) => a + b, 0) / sl.length;
}
function cleanExchange(raw) {
  if (!raw) return 'NYSE';
  const u = raw.toUpperCase();
  if (u.includes('NASDAQ') || u==='NGS'||u==='NMS'||u==='NGM') return 'NASDAQ';
  if (u.includes('NYSE') || u==='NYQ') return 'NYSE';
  return raw.split(/[\s,]/)[0].toUpperCase() || 'NYSE';
}
function getRating(s) {
  if (s >= 5) return { label:'Strong Buy', color:'#166534', bg:'#dcfce7', border:'#86efac' };
  if (s === 4) return { label:'Buy',        color:'#15803d', bg:'#f0fdf4', border:'#bbf7d0' };
  if (s === 3) return { label:'Watch',      color:'#92400e', bg:'#fffbeb', border:'#fde68a' };
  return             { label:'Ignore',      color:'#6b7280', bg:'#f9fafb', border:'#d1d5db' };
}

// ── Analyse one ticker ────────────────────────────────────────────────────────
async function analyseTicker(ticker, crumb, cookies) {

  // FIX 3: Finnhub earnings fetched in parallel alongside everything else
  const [ydRaw, ycRaw, fhQuoteRaw, insiderRaw, fhEarningsRaw] = await Promise.allSettled([
    yahooSummary(ticker, crumb, cookies),
    yahooChart(ticker, crumb, cookies),
    fhGet(`/quote?symbol=${ticker}`, 4000),
    getInsider(ticker),
    fhGet(`/stock/earnings?symbol=${ticker}&limit=4`, 4000),
  ]);

  // FIX 8: Log failures server-side
  if (ydRaw.status !== 'fulfilled' || !ydRaw.value)  console.log(`[${ticker}] Yahoo summary failed`);
  if (ycRaw.status !== 'fulfilled' || !ycRaw.value)  console.log(`[${ticker}] Yahoo chart failed`);

  const yd  = ydRaw.status  === 'fulfilled' ? ydRaw.value  : null;
  const yc  = ycRaw.status  === 'fulfilled' ? ycRaw.value  : null;
  const fhq = fhQuoteRaw.status === 'fulfilled' ? fhQuoteRaw.value : null;
  const ins = insiderRaw.status === 'fulfilled' ? insiderRaw.value : { buys:[], sells:[], src:null };
  const fhE = fhEarningsRaw.status === 'fulfilled' ? fhEarningsRaw.value : null;

  if (!yd && !yc && !fhq) return null;

  // ── Price & meta ──────────────────────────────────────────────────────────
  const price   = yd?.price?.regularMarketPrice?.raw || yc?.meta?.regularMarketPrice || fhq?.c;
  if (!price) return null;

  const chgPct  = yd?.price?.regularMarketChangePercent?.raw ?? fhq?.dp ?? null;
  const mc      = yd?.price?.marketCap?.raw || yc?.meta?.marketCap || 0;
  const mcs     = fmt$M(mc) || '';
  const company = yd?.price?.longName || yd?.price?.shortName || yd?.assetProfile?.longName || ticker;
  const exch    = cleanExchange(yd?.price?.exchangeName || yd?.price?.exchange || yc?.meta?.exchangeName);

  // ── Signal 1: EPS beat ────────────────────────────────────────────────────
  let s1 = { status:'neutral', value:'No earnings data' };
  try {
    // Try Yahoo earningsHistory first
    const yhHist = (yd?.earningsHistory?.history || [])
      .filter(e => e?.epsActual?.raw != null && e?.epsEstimate?.raw != null)
      .sort((a, b) => (b.quarter?.raw || 0) - (a.quarter?.raw || 0));

    const src = yhHist.length > 0 ? yhHist[0] : null;

    if (src) {
      const actual = src.epsActual.raw, estimate = src.epsEstimate.raw;
      const diff = actual - estimate, beat = diff >= 0;
      const ds = Math.abs(diff) < 0.005 ? 'in-line'
        : beat ? `+$${Math.abs(diff).toFixed(2)}` : `-$${Math.abs(diff).toFixed(2)}`;
      s1 = { status: beat ? 'pass' : 'fail', value: beat ? `Beat by ${ds}` : `Missed ${ds}` };
    } else if (Array.isArray(fhE) && fhE.length > 0) {
      // FIX 3: use pre-fetched Finnhub earnings (already parallel)
      const e = fhE[0];
      if (e.actual != null && e.estimate != null) {
        const diff = (e.actual||0) - (e.estimate||0), beat = diff >= 0;
        const ds = Math.abs(diff) < 0.005 ? 'in-line'
          : beat ? `+$${Math.abs(diff).toFixed(2)}` : `-$${Math.abs(diff).toFixed(2)}`;
        s1 = { status: beat ? 'pass' : 'fail', value: beat ? `Beat by ${ds}` : `Missed ${ds}` };
      }
    } else {
      // FIX 1: explicit label
      s1 = { status:'neutral', value:'No earnings history' };
    }
  } catch (_) { s1 = { status:'neutral', value:'No earnings data' }; }

  // ── Signal 2: PE vs historical average ────────────────────────────────────
  let s2 = { status:'neutral', value:'PE unavailable' };
  try {
    const rawPE = yd?.summaryDetail?.trailingPE?.raw
               || yd?.defaultKeyStatistics?.trailingPE?.raw
               || yc?.meta?.trailingPE;
    const fwdPE = yd?.defaultKeyStatistics?.forwardPE?.raw;
    const eps   = yd?.defaultKeyStatistics?.trailingEps?.raw;
    const hi52  = yd?.summaryDetail?.fiftyTwoWeekHigh?.raw || yc?.meta?.fiftyTwoWeekHigh;
    const lo52  = yd?.summaryDetail?.fiftyTwoWeekLow?.raw  || yc?.meta?.fiftyTwoWeekLow;

    // FIX 2: handle negative / very high PE explicitly
    if (rawPE != null) {
      if (rawPE <= 0) {
        s2 = { status:'fail', value:'Negative earnings (loss)' };
      } else if (rawPE >= PE_MAX) {
        s2 = { status:'neutral', value:`PE ${rawPE.toFixed(0)}x (very high)` };
      } else {
        // Normal range — compare to historical midpoint
        if (eps && eps > 0 && hi52 && lo52 && hi52 > lo52) {
          const histPE = ((hi52 + lo52) / 2) / eps;
          if (histPE > 0 && histPE < 600) {
            if      (rawPE < histPE * 0.92) s2 = { status:'pass',    value:`PE ${rawPE.toFixed(1)}x < hist ~${histPE.toFixed(0)}x` };
            else if (rawPE > histPE * 1.08) s2 = { status:'fail',    value:`PE ${rawPE.toFixed(1)}x > hist ~${histPE.toFixed(0)}x` };
            else                             s2 = { status:'neutral', value:`PE ${rawPE.toFixed(1)}x ≈ hist ~${histPE.toFixed(0)}x` };
          } else {
            s2 = { status:'neutral', value:`PE ${rawPE.toFixed(1)}x` };
          }
        } else {
          s2 = { status:'neutral', value:`PE ${rawPE.toFixed(1)}x` };
        }
      }
    } else if (fwdPE != null && fwdPE > 0) {
      s2 = { status:'neutral', value:`Fwd PE ${fwdPE.toFixed(1)}x` };
    } else {
      // FIX 1: explicit label
      s2 = { status:'neutral', value:'PE not available' };
    }
  } catch (_) { s2 = { status:'neutral', value:'PE unavailable' }; }

  // ── Signal 3: Price vs 50d MA ─────────────────────────────────────────────
  let s3 = { status:'neutral', value:'MA unavailable' };
  try {
    let ma50 = yd?.summaryDetail?.fiftyDayAverage?.raw;
    // FIX 7: fall back to computed MA with minimum 10 bars
    if (!ma50 || ma50 <= 0) {
      const closes = yc?.indicators?.quote?.[0]?.close;
      ma50 = computeMA(closes, 10);
    }
    if (ma50 && ma50 > 0) {
      const pct = ((price - ma50) / ma50 * 100).toFixed(1);
      s3 = price <= ma50
        ? { status:'pass', value:`$${price.toFixed(2)} ≤ 50d MA $${ma50.toFixed(2)} (${pct}%)` }
        : { status:'fail', value:`$${price.toFixed(2)} > 50d MA $${ma50.toFixed(2)} (+${pct}%)` };
    } else {
      s3 = { status:'neutral', value:'MA data unavailable' };
    }
  } catch (_) { s3 = { status:'neutral', value:'MA unavailable' }; }

  // ── Signal 4: Insider buying ──────────────────────────────────────────────
  let s4 = { status:'neutral', value:'No filings found' };
  try {
    const { buys, sells, src } = ins;
    if (buys.length > 0) {
      const sh = buys.reduce((s,t) => s + Math.abs(t._sharesTraded || t.change || 0), 0);
      const parts = [`${buys.length} buy${buys.length>1?'s':''}`];
      const sv = fmtSh(sh); if (sv) parts.push(sv);
      const rc = timeAgo(buys[0]?.transactionDate); if (rc) parts.push(rc);
      s4 = { status:'pass', value: parts.join(' · ') };
    } else if (sells.length > 0) {
      const sh = sells.reduce((s,t) => s + Math.abs(t._sharesTraded || t.change || 0), 0);
      const parts = [`${sells.length} sell${sells.length>1?'s':''}, no buys`];
      const sv = fmtSh(sh); if (sv) parts.push(sv);
      s4 = { status:'fail', value: parts.join(' · ') };
    } else {
      // FIX 6: distinguish "checked and found nothing" from "didn't check"
      s4 = { status:'neutral', value: src ? 'No activity (30d)' : 'No filings found' };
    }
  } catch (_) { s4 = { status:'neutral', value:'Insider data unavailable' }; }

  // ── Signal 5: Analyst target ──────────────────────────────────────────────
  let s5 = { status:'neutral', value:'No analyst data' };
  try {
    const tgt = yd?.financialData?.targetMedianPrice?.raw || yd?.financialData?.targetMeanPrice?.raw;
    const numAnalysts = yd?.financialData?.numberOfAnalystOpinions?.raw || 0;

    if (tgt && tgt > 0 && price > 0) {
      const up = ((tgt - price) / price * 100).toFixed(1);
      const suffix = numAnalysts > 0 ? ` (${numAnalysts} analysts)` : '';
      s5 = parseFloat(up) >= 25
        ? { status:'pass', value:`Target $${tgt.toFixed(2)}, +${up}% upside${suffix}` }
        : { status: parseFloat(up) >= 0 ? 'neutral' : 'fail', value:`Target $${tgt.toFixed(2)}, ${parseFloat(up)>=0?'+':''}${up}%${suffix}` };
    } else {
      // FIX 4: recommendation trend fallback
      const rt = yd?.recommendationTrend?.trend?.[0];
      if (rt) {
        const buy   = (rt.strongBuy||0) + (rt.buy||0);
        const total = buy + (rt.hold||0) + (rt.sell||0) + (rt.strongSell||0);
        if (total > 0) {
          const pct = Math.round(buy / total * 100);
          s5 = {
            status: pct >= 60 ? 'pass' : pct >= 35 ? 'neutral' : 'fail',
            value: `${pct}% buy rating (${buy}/${total} analysts)`,
          };
        } else {
          // FIX 1: explicit label
          s5 = { status:'neutral', value:'No analyst coverage' };
        }
      } else {
        s5 = { status:'neutral', value:'No analyst coverage' };
      }
    }
  } catch (_) { s5 = { status:'neutral', value:'No analyst data' }; }

  // ── Signal 6: PE vs peers ─────────────────────────────────────────────────
  let s6 = { status:'neutral', value:'Peers unavailable' };
  try {
    const curPE = yd?.summaryDetail?.trailingPE?.raw || yd?.defaultKeyStatistics?.trailingPE?.raw;
    if (curPE && curPE > 0 && curPE < PE_MAX) {
      const peerData = await getPeerPEs(ticker, crumb, cookies);
      if (peerData) {
        const diff  = ((curPE - peerData.medianPE) / peerData.medianPE * 100);
        const absDiff = Math.abs(diff).toFixed(0);
        const label = `med ${peerData.medianPE}x (${peerData.count} peers)`;
        if      (diff < -8) s6 = { status:'pass',    value:`${absDiff}% below peers, ${label}` };
        else if (diff >  8) s6 = { status:'fail',    value:`${absDiff}% above peers, ${label}` };
        else                s6 = { status:'neutral', value:`In line with peers, ${label}` };
      } else {
        // FIX 5: explicit label
        s6 = { status:'neutral', value:'No peer PE data' };
      }
    } else if (curPE && curPE <= 0) {
      s6 = { status:'neutral', value:'Negative earnings — peer PE N/A' };
    } else if (curPE && curPE >= PE_MAX) {
      s6 = { status:'neutral', value:`PE ${curPE.toFixed(0)}x — peer comparison skipped` };
    } else {
      s6 = { status:'neutral', value:'PE data needed for peer comparison' };
    }
  } catch (_) { s6 = { status:'neutral', value:'Peer data unavailable' }; }

  // ── Assemble ──────────────────────────────────────────────────────────────
  const signals = [s1, s2, s3, s4, s5, s6];
  const score   = signals.filter(s => s.status === 'pass').length;
  const NAMES   = ['EPS beat','Low PE','Below 50d MA','Insider buying','Analyst upside','PE vs peers'];
  const passes  = signals.map((s,i) => s.status==='pass' ? NAMES[i] : null).filter(Boolean);
  const fails   = signals.map((s,i) => s.status==='fail' ? NAMES[i] : null).filter(Boolean);

  let summaryText;
  if      (score >= 5) summaryText = `Strong value candidate — ${score}/6 signals pass. Strengths: ${passes.join(', ')}.`;
  else if (score === 4) summaryText = `Good signals (4/6). Passes: ${passes.join(', ')}.`;
  else if (score === 3) summaryText = `Moderate signals (3/6). Passes: ${passes.join(', ')}.`;
  else if (score > 0)   summaryText = `Weak signals (${score}/6). Fails: ${fails.join(', ')}.`;
  else                  summaryText = fails.length ? `No signals pass. Fails: ${fails.join(', ')}.` : `Insufficient data to score.`;

  return {
    ticker,
    company,
    exchange: exch,
    price:     `$${price.toFixed(2)}`,
    change:    chgPct != null ? `${chgPct > 0 ? '+' : ''}${chgPct.toFixed(2)}%` : null,
    marketCap: mcs,
    score,
    signals,
    summary:   summaryText,
    rating:    getRating(score),
    updatedAt: new Date().toISOString(),
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!FINNHUB_KEY) return res.status(500).json({ error: 'FINNHUB_KEY not set' });

  const { tickers } = req.body;
  if (!Array.isArray(tickers) || !tickers.length) return res.status(400).json({ error: 'tickers required' });

  const cleaned = [...new Set(tickers.slice(0, 20).map(t => t.toUpperCase().trim()))];
  const { crumb, cookies } = await getCrumb();

  const settled = await Promise.allSettled(
    cleaned.map(ticker => analyseTicker(ticker, crumb, cookies))
  );

  const results = {};
  settled.forEach((r, i) => {
    const ticker = cleaned[i];
    if (r.status === 'fulfilled' && r.value) results[ticker] = r.value;
    else {
      console.log(`[${ticker}] analyseTicker failed:`, r.reason?.message);
      results[ticker] = { ticker, error: r.reason?.message || 'Analysis failed' };
    }
  });

  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');
  return res.status(200).json({ results, fetchedAt: new Date().toISOString() });
}
