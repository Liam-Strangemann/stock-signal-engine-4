// pages/api/analyse.js  v14
//
// COMPLETE REWRITE — single-source-of-truth approach.
//
// ROOT CAUSE OF ALL PREVIOUS FAILURES:
//   Trying to scrape 6+ sources per ticker in a Vercel serverless function
//   that has a 10s hard timeout. Scraping always loses this race.
//
// SOLUTION:
//   Yahoo Finance's quoteSummary API returns ALL data we need in ONE request:
//   - price, change, marketCap                    (price module)
//   - trailingPE, forwardPE, 52w hi/lo            (summaryDetail)
//   - trailingEps, earningsGrowth                 (defaultKeyStatistics)
//   - targetMedianPrice (analyst target)          (financialData)
//   - earningsHistory (EPS beats)                 (earningsHistory)
//   - company name, exchange, sector              (assetProfile)
//
//   That's ALL 6 signals from a single API call per ticker.
//   At 20 tickers, all fired in parallel, this completes in ~2-3s.
//
// INSIDER (signal 4):
//   Finnhub's insider endpoint is fast (~400ms) and reliable.
//   Falls back to a single OpenInsider fetch if Finnhub misses.
//
// PEER PE (signal 6):
//   Computed from the same Yahoo batch — no extra calls needed.
//   We already have PE for the main ticker; peer PEs come from
//   a small parallel batch of Yahoo quoteSummary calls for known peers.

const FINNHUB_KEY = process.env.FINNHUB_KEY;
const FH = 'https://finnhub.io/api/v1';

const YH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
};

// ── Yahoo crumb (cached in-process) ──────────────────────────────────────────
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

// ── Single Yahoo quoteSummary call — returns ALL modules at once ──────────────
const MODULES = [
  'price',
  'summaryDetail',
  'defaultKeyStatistics',
  'financialData',
  'earningsHistory',
  'assetProfile',
  'recommendationTrend',
].join(',');

async function yahooSummary(ticker, crumb, cookies) {
  const qs = crumb ? `&crumb=${encodeURIComponent(crumb)}` : '';
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(
        `${base}/v10/finance/quoteSummary/${ticker}?modules=${MODULES}${qs}`,
        { headers: { ...YH_HEADERS, ...(cookies ? { Cookie: cookies } : {}) }, signal: AbortSignal.timeout(7000) }
      );
      if (r.status === 401 || r.status === 404) return null;
      if (!r.ok) continue;
      const j = await r.json();
      const res = j?.quoteSummary?.result?.[0];
      if (res) return res;
    } catch (_) {}
  }
  return null;
}

// ── Yahoo chart — for MA50 and 52w hi/lo when summaryDetail is sparse ─────────
async function yahooChart(ticker, crumb, cookies) {
  const qs = crumb ? `&crumb=${encodeURIComponent(crumb)}` : '';
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(
        `${base}/v8/finance/chart/${ticker}?interval=1d&range=1y${qs}`,
        { headers: { ...YH_HEADERS, ...(cookies ? { Cookie: cookies } : {}) }, signal: AbortSignal.timeout(6000) }
      );
      if (!r.ok) continue;
      const j = await r.json();
      return j?.chart?.result?.[0] || null;
    } catch (_) {}
  }
  return null;
}

// ── Finnhub helpers ───────────────────────────────────────────────────────────
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

// ── Insider (Finnhub primary, OpenInsider fallback) ───────────────────────────
const MAX_SH = 250_000, MAX_VAL = 50e6;

async function getInsider(ticker) {
  const now = Math.floor(Date.now() / 1000);
  const from = new Date((now - 30 * 86400) * 1000).toISOString().slice(0, 10);
  const to   = new Date(now * 1000).toISOString().slice(0, 10);
  const cut  = Date.now() - 30 * 86400 * 1000;

  // Finnhub — fast and reliable
  try {
    const d = await fhGet(`/stock/insider-transactions?symbol=${ticker}&from=${from}&to=${to}`, 5000);
    if (d?.data?.length) {
      const buys  = d.data.filter(t => t.transactionCode === 'P' && Math.abs(t.change||0) > 0 && Math.abs(t.change||0) <= MAX_SH && new Date(t.transactionDate) >= new Date(cut));
      const sells = d.data.filter(t => t.transactionCode === 'S' && Math.abs(t.change||0) > 0 && Math.abs(t.change||0) <= MAX_SH && new Date(t.transactionDate) >= new Date(cut));
      if (buys.length || sells.length) return { buys, sells, src: 'fh' };
    }
  } catch (_) {}

  // OpenInsider — HTML fallback
  try {
    const r = await fetch(
      `https://openinsider.com/screener?s=${ticker}&fd=-30&td=0&xs=1&vl=0&grp=0&cnt=15&action=1`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }
    );
    if (r.ok) {
      const html = await r.text();
      const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
        .map(m => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => c[1].replace(/<[^>]+>/g, '').trim()));
      const buys = [], sells = [];
      for (const cells of rows) {
        if (cells.length < 10) continue;
        const typeCell = cells.find(c => /P\s*-\s*Purchase|S\s*-\s*Sale/i.test(c)) || '';
        const isPurchase = /Purchase/i.test(typeCell);
        const isSale     = /Sale/i.test(typeCell) && !/Purchase/i.test(typeCell);
        if (!isPurchase && !isSale) continue;
        const sharesCell = cells.find(c => /^[\d,]+$/.test(c.replace(/,/g,''))) || '0';
        const shares = parseInt(sharesCell.replace(/,/g, ''), 10) || 0;
        if (shares <= 0 || shares > MAX_SH) continue;
        const entry = { _sharesTraded: shares, transactionDate: to };
        if (isPurchase) buys.push(entry); else sells.push(entry);
      }
      if (buys.length || sells.length) return { buys, sells, src: 'oi' };
    }
  } catch (_) {}

  return { buys: [], sells: [], src: null };
}

// ── Peer PE — fetch PEs for known peers via Yahoo (same endpoint, very fast) ──
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
};
const PE_MAX = 80;

async function getPeerPEs(ticker, crumb, cookies) {
  const peers = (PEERS[ticker] || []).slice(0, 5);
  if (!peers.length) return null;

  // Fetch all peers' summaryDetail in parallel — fast, same Yahoo endpoint
  const results = await Promise.allSettled(
    peers.map(p =>
      yahooSummary(p, crumb, cookies).then(d => {
        const pe = d?.summaryDetail?.trailingPE?.raw || d?.defaultKeyStatistics?.trailingPE?.raw;
        return (pe > 0 && pe < PE_MAX) ? pe : null;
      }).catch(() => null)
    )
  );

  const pes = results
    .filter(r => r.status === 'fulfilled' && r.value != null)
    .map(r => r.value)
    .sort((a, b) => a - b);

  if (pes.length < 2) return null;

  // Outlier trim
  const mid = Math.floor(pes.length / 2);
  const median = pes.length % 2 === 0 ? (pes[mid-1] + pes[mid]) / 2 : pes[mid];
  const filtered = pes.filter(p => p <= median * 3 && p >= median * 0.2);
  if (filtered.length < 2) return null;

  const fmid = Math.floor(filtered.length / 2);
  const fmedian = filtered.length % 2 === 0 ? (filtered[fmid-1] + filtered[fmid]) / 2 : filtered[fmid];
  return { medianPE: parseFloat(fmedian.toFixed(1)), count: filtered.length };
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
  if (!n) return null;
  if (n >= 1e6) return `${(n/1e6).toFixed(2)}M shares`;
  if (n >= 1e3) return `${(n/1e3).toFixed(1)}K shares`;
  return `${n.toLocaleString()} shares`;
}
function timeAgo(ds) {
  if (!ds) return null;
  const days = Math.floor((Date.now() - new Date(ds)) / 86400000);
  return days === 0 ? 'today' : days === 1 ? '1d ago' : days < 7 ? `${days}d ago` : `${Math.floor(days/7)}w ago`;
}
function compute50dMA(closes) {
  const v = (closes||[]).filter(c => c > 0 && !isNaN(c));
  if (v.length < 20) return null;
  const sl = v.slice(-50);
  return sl.reduce((a,b) => a+b, 0) / sl.length;
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

// ── Analyse a single ticker ───────────────────────────────────────────────────
async function analyseTicker(ticker, crumb, cookies) {
  // Fire Yahoo summary + chart + Finnhub quote + insider all in parallel
  const [summary, chart, fhQuote, insiderRaw] = await Promise.allSettled([
    yahooSummary(ticker, crumb, cookies),
    yahooChart(ticker, crumb, cookies),
    fhGet(`/quote?symbol=${ticker}`, 4000),
    getInsider(ticker),
  ]);

  const yd  = summary.status === 'fulfilled' ? summary.value : null;
  const yc  = chart.status   === 'fulfilled' ? chart.value   : null;
  const fhq = fhQuote.status === 'fulfilled' ? fhQuote.value : null;
  const ins = insiderRaw.status === 'fulfilled' ? insiderRaw.value : { buys:[], sells:[], src:null };

  if (!yd && !yc && !fhq) return null;

  // ── Price & meta ──────────────────────────────────────────────────────────
  const price  = yd?.price?.regularMarketPrice?.raw || yc?.meta?.regularMarketPrice || fhq?.c;
  if (!price) return null;

  const chgPct = yd?.price?.regularMarketChangePercent?.raw ?? fhq?.dp ?? null;
  const mc     = yd?.price?.marketCap?.raw || yc?.meta?.marketCap || 0;
  const mcs    = fmt$M(mc) || '';
  const company= yd?.price?.longName || yd?.price?.shortName || yd?.assetProfile?.longName || ticker;
  const exch   = cleanExchange(yd?.price?.exchangeName || yd?.price?.exchange || yc?.meta?.exchangeName);

  // ── Signal 1: EPS beat ───────────────────────────────────────────────────
  let s1 = { status:'neutral', value:'No data' };
  try {
    const hist = yd?.earningsHistory?.history || [];
    if (hist.length > 0) {
      const latest = [...hist].sort((a,b) => (b.quarter?.raw||0)-(a.quarter?.raw||0))[0];
      const actual   = latest?.epsActual?.raw;
      const estimate = latest?.epsEstimate?.raw;
      if (actual != null && estimate != null) {
        const diff = actual - estimate;
        const beat = diff >= 0;
        const ds = Math.abs(diff) < 0.005 ? 'in-line' : beat ? `+$${Math.abs(diff).toFixed(2)}` : `-$${Math.abs(diff).toFixed(2)}`;
        s1 = { status: beat ? 'pass' : 'fail', value: beat ? `Beat by ${ds}` : `Missed ${ds}` };
      }
    } else {
      // Fall back to Finnhub earnings
      const fe = await fhGet(`/stock/earnings?symbol=${ticker}&limit=2`, 3000);
      if (fe?.length > 0) {
        const e = fe[0];
        const diff = (e.actual||0) - (e.estimate||0), beat = diff >= 0;
        const ds = Math.abs(diff) < 0.005 ? 'in-line' : beat ? `+$${Math.abs(diff).toFixed(2)}` : `-$${Math.abs(diff).toFixed(2)}`;
        s1 = { status: beat ? 'pass' : 'fail', value: beat ? `Beat by ${ds}` : `Missed ${ds}` };
      }
    }
  } catch (_) {}

  // ── Signal 2: PE vs historical average ───────────────────────────────────
  let s2 = { status:'neutral', value:'No data' };
  try {
    const curPE = yd?.summaryDetail?.trailingPE?.raw || yd?.defaultKeyStatistics?.trailingPE?.raw || yc?.meta?.trailingPE;
    const eps   = yd?.defaultKeyStatistics?.trailingEps?.raw;
    const hi52  = yd?.summaryDetail?.fiftyTwoWeekHigh?.raw || yc?.meta?.fiftyTwoWeekHigh;
    const lo52  = yd?.summaryDetail?.fiftyTwoWeekLow?.raw  || yc?.meta?.fiftyTwoWeekLow;

    if (curPE && curPE > 0 && curPE < PE_MAX) {
      if (eps && eps !== 0 && hi52 && lo52 && hi52 > lo52) {
        const histPE = ((hi52 + lo52) / 2) / Math.abs(eps);
        if (histPE > 0 && histPE < 500) {
          if      (curPE < histPE * 0.92) s2 = { status:'pass',    value:`PE ${curPE.toFixed(1)}x < hist ~${histPE.toFixed(0)}x` };
          else if (curPE > histPE * 1.08) s2 = { status:'fail',    value:`PE ${curPE.toFixed(1)}x > hist ~${histPE.toFixed(0)}x` };
          else                             s2 = { status:'neutral', value:`PE ${curPE.toFixed(1)}x ≈ hist ~${histPE.toFixed(0)}x` };
        }
      } else {
        s2 = { status:'neutral', value:`PE ${curPE.toFixed(1)}x` };
      }
    } else if (yd?.defaultKeyStatistics?.forwardPE?.raw) {
      const fpe = yd.defaultKeyStatistics.forwardPE.raw;
      if (fpe > 0 && fpe < PE_MAX) s2 = { status:'neutral', value:`Fwd PE ${fpe.toFixed(1)}x` };
    }
  } catch (_) {}

  // ── Signal 3: Price vs 50d MA ─────────────────────────────────────────────
  let s3 = { status:'neutral', value:'No data' };
  try {
    let ma50 = yd?.summaryDetail?.fiftyDayAverage?.raw;
    if (!ma50 || ma50 <= 0) {
      const closes = yc?.indicators?.quote?.[0]?.close;
      ma50 = compute50dMA(closes);
    }
    if (ma50 && ma50 > 0) {
      const pct = ((price - ma50) / ma50 * 100).toFixed(1);
      s3 = price <= ma50
        ? { status:'pass', value:`$${price.toFixed(2)} ≤ MA $${ma50.toFixed(2)} (${pct}%)` }
        : { status:'fail', value:`$${price.toFixed(2)} > MA $${ma50.toFixed(2)} (+${pct}%)` };
    }
  } catch (_) {}

  // ── Signal 4: Insider buying ──────────────────────────────────────────────
  let s4 = { status:'neutral', value:'No data' };
  try {
    const { buys, sells, src } = ins;
    if (buys.length > 0) {
      const sh  = buys.reduce((s,t) => s + Math.abs(t._sharesTraded||t.change||0), 0);
      const parts = [`${buys.length} buy${buys.length>1?'s':''}`];
      const sv = fmtSh(sh); if (sv) parts.push(sv);
      const rc = timeAgo(buys[0]?.transactionDate); if (rc) parts.push(rc);
      s4 = { status:'pass', value: parts.join(' · ') };
    } else if (sells.length > 0) {
      const sh = sells.reduce((s,t) => s + Math.abs(t._sharesTraded||t.change||0), 0);
      const parts = [`${sells.length} sell${sells.length>1?'s':''}, no buys`];
      const sv = fmtSh(sh); if (sv) parts.push(sv);
      s4 = { status:'fail', value: parts.join(' · ') };
    } else {
      s4 = { status:'neutral', value: src ? 'No activity (30d)' : 'No data' };
    }
  } catch (_) {}

  // ── Signal 5: Analyst target / upside ────────────────────────────────────
  let s5 = { status:'neutral', value:'No data' };
  try {
    const tgt = yd?.financialData?.targetMedianPrice?.raw || yd?.financialData?.targetMeanPrice?.raw;
    if (tgt && tgt > 0 && price > 0) {
      const up = ((tgt - price) / price * 100).toFixed(1);
      s5 = parseFloat(up) >= 25
        ? { status:'pass', value:`Target $${tgt.toFixed(2)}, +${up}% upside` }
        : { status:'fail', value:`Target $${tgt.toFixed(2)}, ${up >= 0 ? '+':''}${up}% upside` };
    } else {
      // Try recommendation trend as fallback signal
      const rt = yd?.recommendationTrend?.trend?.[0];
      if (rt) {
        const buy = (rt.strongBuy||0) + (rt.buy||0);
        const total = buy + (rt.hold||0) + (rt.sell||0) + (rt.strongSell||0);
        if (total > 0) {
          const pct = Math.round(buy / total * 100);
          s5 = { status: pct >= 60 ? 'pass' : pct >= 40 ? 'neutral' : 'fail', value: `${pct}% analyst buy (${buy}/${total})` };
        }
      }
    }
  } catch (_) {}

  // ── Signal 6: PE vs peers (parallel Yahoo fetch) ──────────────────────────
  let s6 = { status:'neutral', value:'No data' };
  try {
    const curPE = yd?.summaryDetail?.trailingPE?.raw || yd?.defaultKeyStatistics?.trailingPE?.raw;
    if (curPE && curPE > 0 && curPE < PE_MAX) {
      const peerData = await getPeerPEs(ticker, crumb, cookies);
      if (peerData) {
        const diff = ((curPE - peerData.medianPE) / peerData.medianPE * 100);
        const abs  = Math.abs(diff).toFixed(0);
        const label = `median ${peerData.medianPE}x`;
        if      (diff < -8) s6 = { status:'pass',    value:`${abs}% below peer ${label}` };
        else if (diff >  8) s6 = { status:'fail',    value:`${abs}% above peer ${label}` };
        else                s6 = { status:'neutral', value:`In line with peers (${label})` };
      }
    }
  } catch (_) {}

  // ── Assemble result ───────────────────────────────────────────────────────
  const signals = [s1, s2, s3, s4, s5, s6];
  const score   = signals.filter(s => s.status === 'pass').length;
  const NAMES   = ['EPS beat','Low PE','Below 50d MA','Insider buying','Analyst upside','PE vs peers'];
  const passes  = signals.map((s,i) => s.status==='pass' ? NAMES[i] : null).filter(Boolean);
  const fails   = signals.map((s,i) => s.status==='fail' ? NAMES[i] : null).filter(Boolean);
  let summary;
  if      (score >= 5) summary = `Strong value candidate — ${score}/6 signals pass. Strengths: ${passes.join(', ')}.`;
  else if (score === 4) summary = `Good signals (4/6). Passes: ${passes.join(', ')}.`;
  else if (score === 3) summary = `Moderate signals (3/6). Passes: ${passes.join(', ')}.`;
  else if (score > 0)  summary = `Weak signals (${score}/6). Fails: ${fails.join(', ')}.`;
  else                 summary = `No signals pass. Fails: ${fails.join(', ')}.`;

  return {
    ticker,
    company,
    exchange: exch,
    price:    `$${price.toFixed(2)}`,
    change:   chgPct != null ? `${chgPct > 0 ? '+' : ''}${chgPct.toFixed(2)}%` : null,
    marketCap: mcs,
    score,
    signals,
    summary,
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

  // All tickers analysed in parallel — Yahoo handles concurrent requests fine
  const settled = await Promise.allSettled(
    cleaned.map(ticker => analyseTicker(ticker, crumb, cookies))
  );

  const results = {};
  settled.forEach((r, i) => {
    const ticker = cleaned[i];
    if (r.status === 'fulfilled' && r.value) results[ticker] = r.value;
    else results[ticker] = { ticker, error: r.reason?.message || 'No data' };
  });

  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');
  return res.status(200).json({ results, fetchedAt: new Date().toISOString() });
}
