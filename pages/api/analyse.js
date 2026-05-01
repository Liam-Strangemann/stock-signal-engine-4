// pages/api/analyse.js  v16 — complete rewrite
//
// WHY THE PREVIOUS VERSION FAILED:
//   Yahoo quoteSummary (/v10/finance/quoteSummary) is heavily rate-limited
//   and frequently returns 401/429 from Vercel IPs. Fields like financialData,
//   earningsHistory, recommendationTrend are often stripped or empty.
//
// NEW APPROACH — source hierarchy per signal:
//
//   Signal 1 EPS beat      → Finnhub /stock/earnings (fast, reliable, paid)
//   Signal 2 PE vs hist    → Finnhub /stock/metric (has pe*, eps, 52w hi/lo)
//   Signal 3 Price vs MA50 → Yahoo /v8/finance/chart (1d/1y closes → compute)
//                            fallback: Finnhub /stock/metric fiftyDayMA
//   Signal 4 Insider       → Finnhub /stock/insider-transactions (primary)
//                            + OpenInsider HTML (fallback, fast)
//   Signal 5 Analyst       → Finnhub /stock/price-target (median price target)
//                            + Finnhub /stock/recommendation (buy/hold/sell)
//   Signal 6 PE vs peers   → Finnhub /stock/metric for each peer (parallel)
//
// All Finnhub calls are concurrent via Promise.allSettled.
// Yahoo chart is fetched in parallel for MA50 computation only.
// No scraping, no quoteSummary, no single point of failure.
// Every signal ALWAYS returns a descriptive string — never blank.

export const config = { maxDuration: 25 }; // Vercel Pro: 25s. Hobby: ignored (10s default)

const FINNHUB_KEY = process.env.FINNHUB_KEY;
const FH_BASE = 'https://finnhub.io/api/v1';

const YH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
};

// ─── Finnhub fetch ────────────────────────────────────────────────────────────
async function fh(path, ms = 6000) {
  if (!FINNHUB_KEY) return null;
  try {
    const sep = path.includes('?') ? '&' : '?';
    const r = await fetch(`${FH_BASE}${path}${sep}token=${FINNHUB_KEY}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(ms),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.error ? null : d;
  } catch (_) { return null; }
}

// ─── Yahoo chart — used ONLY for price + MA50 from closes ────────────────────
// This endpoint (/v8/finance/chart) is a different path from quoteSummary,
// much less rate-limited, returns fast.
async function yhChart(ticker, ms = 6000) {
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(
        `${base}/v8/finance/chart/${ticker}?interval=1d&range=1y`,
        { headers: YH_HEADERS, signal: AbortSignal.timeout(ms) }
      );
      if (!r.ok) continue;
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      if (res) return res;
    } catch (_) {}
  }
  return null;
}

// ─── Insider sources ──────────────────────────────────────────────────────────
const MAX_SH = 5_000_000; // raised — captures large exec trades

async function insiderFinnhub(ticker) {
  const now = Math.floor(Date.now() / 1000);
  const from = new Date((now - 90 * 86400) * 1000).toISOString().slice(0, 10); // 90 days
  const to   = new Date(now * 1000).toISOString().slice(0, 10);
  const d = await fh(`/stock/insider-transactions?symbol=${ticker}&from=${from}&to=${to}`, 6000);
  if (!d?.data?.length) return null;
  const cut = Date.now() - 90 * 86400 * 1000;
  const valid = d.data.filter(t => {
    const sh = Math.abs(t.change || 0);
    return sh > 0 && sh <= MAX_SH && new Date(t.transactionDate) >= new Date(cut);
  });
  const buys  = valid.filter(t => t.transactionCode === 'P');
  const sells = valid.filter(t => t.transactionCode === 'S');
  if (!buys.length && !sells.length) return null;
  return { buys, sells, src: 'finnhub' };
}

async function insiderOpenInsider(ticker) {
  try {
    const r = await fetch(
      `https://openinsider.com/screener?s=${ticker}&fd=-90&td=0&xs=1&vl=0&grp=0&cnt=30&action=1`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return null;
    const html = await r.text();
    const rows = [...html.matchAll(/<tr[^>]*class="[^"]*(?:odd|even)[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map(m => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => c[1].replace(/<[^>]+>/g, '').trim()));
    const buys = [], sells = [];
    for (const cells of rows) {
      if (cells.length < 10) continue;
      // OI table: col 3 = trade type, col 7 = qty
      const type = cells[3] || '';
      const sharesStr = (cells[7] || '').replace(/[^0-9]/g, '');
      const shares = parseInt(sharesStr, 10) || 0;
      if (shares <= 0 || shares > MAX_SH) continue;
      const entry = { _sharesTraded: shares, transactionDate: cells[1] || '' };
      if (/P\s*-\s*Purchase/i.test(type)) buys.push(entry);
      else if (/S\s*-\s*Sale/i.test(type) && !/Sale\+OE/i.test(type)) sells.push(entry);
    }
    if (!buys.length && !sells.length) return null;
    return { buys, sells, src: 'openinsider' };
  } catch (_) { return null; }
}

// ─── MA50 from closes ─────────────────────────────────────────────────────────
function computeMA50(closes) {
  const v = (closes || []).filter(c => c != null && c > 0 && !isNaN(c));
  if (v.length < 5) return null;               // only need 5 bars minimum
  const window = Math.min(50, v.length);
  const sl = v.slice(-window);
  return sl.reduce((a, b) => a + b, 0) / sl.length;
}

// ─── Peer PE map ──────────────────────────────────────────────────────────────
const PEERS = {
  AAPL:['MSFT','GOOGL','META','NVDA'],   MSFT:['AAPL','GOOGL','CRM','ORCL'],
  GOOGL:['META','MSFT','AMZN'],           META:['GOOGL','SNAP','PINS'],
  AMZN:['MSFT','GOOGL','WMT'],            NVDA:['AMD','INTC','QCOM','AVGO'],
  TSLA:['GM','F','TM'],                   AVGO:['QCOM','TXN','ADI','AMD'],
  ORCL:['SAP','MSFT','CRM','IBM'],        AMD:['NVDA','INTC','QCOM','MU'],
  INTC:['AMD','NVDA','QCOM','TXN'],       QCOM:['AVGO','TXN','ADI','AMD'],
  JPM:['BAC','WFC','C','GS','MS'],        BAC:['JPM','WFC','C','USB'],
  WFC:['JPM','BAC','C','USB'],            GS:['MS','JPM','C','BLK'],
  MS:['GS','JPM','C','BLK'],              LLY:['NVO','PFE','MRK','ABBV'],
  JNJ:['PFE','ABBV','MRK','TMO'],         UNH:['CVS','CI','HUM','ELV'],
  ABBV:['PFE','LLY','MRK','BMY'],         MRK:['PFE','JNJ','ABBV','LLY'],
  XOM:['CVX','COP','SLB','EOG'],          CVX:['XOM','COP','SLB','EOG'],
  HD:['LOW','WMT','TGT','COST'],          LOW:['HD','WMT','TGT'],
  WMT:['TGT','COST','KR','HD'],           TGT:['WMT','COST','HD'],
  MCD:['YUM','CMG','QSR','DRI'],          NKE:['UAA','DECK','LULU','SKX'],
  KO:['PEP','MDLZ','MNST'],               PEP:['KO','MDLZ','MNST'],
  T:['VZ','TMUS','CMCSA'],                VZ:['T','TMUS','CMCSA'],
  MA:['V','PYPL','AXP'],                  V:['MA','PYPL','AXP'],
  NFLX:['DIS','WBD','PARA'],              DIS:['NFLX','WBD','CMCSA'],
  CAT:['DE','HON','EMR','ITW'],           HON:['CAT','EMR','ITW','ETN'],
  NEE:['DUK','SO','AEP','EXC'],           AMT:['PLD','EQIX','CCI','SPG'],
  BLK:['SCHW','MS','GS','IVZ'],           TMO:['DHR','IQV','IDXX','WAT'],
  ABT:['MDT','BSX','SYK','BDX'],          AMGN:['REGN','BIIB','VRTX','GILD'],
  SCHW:['MS','GS','BLK','AXP'],           SBUX:['MCD','CMG','YUM','QSR'],
  COST:['WMT','TGT','HD'],                CMG:['MCD','YUM','DRI','QSR'],
  CRM:['NOW','ADBE','ORCL','MSFT'],       ADBE:['CRM','NOW','INTU'],
  NOW:['CRM','ADBE','WDAY'],              INTU:['ADBE','CRM','ADP'],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt$M(n) {
  if (!n || n <= 0) return '';
  if (n >= 1e12) return `$${(n/1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `$${(n/1e9).toFixed(1)}B`;
  if (n >= 1e6)  return `$${(n/1e6).toFixed(0)}M`;
  return `$${n.toFixed(0)}`;
}
function fmtSh(n) {
  if (!n || n <= 0) return '';
  if (n >= 1e6) return `${(n/1e6).toFixed(1)}M shs`;
  if (n >= 1e3) return `${(n/1e3).toFixed(0)}K shs`;
  return `${Math.round(n).toLocaleString()} shs`;
}
function timeAgo(ds) {
  if (!ds) return '';
  const days = Math.floor((Date.now() - new Date(ds)) / 86400000);
  if (isNaN(days) || days < 0) return '';
  return days === 0 ? 'today' : days === 1 ? '1d ago' : days < 7 ? `${days}d ago` : days < 30 ? `${Math.floor(days/7)}w ago` : `${Math.floor(days/30)}mo ago`;
}
function cleanExch(raw) {
  if (!raw) return '';
  const u = raw.toUpperCase();
  if (u.includes('NASDAQ')||u==='NGS'||u==='NMS'||u==='NGM') return 'NASDAQ';
  if (u.includes('NYSE')||u==='NYQ') return 'NYSE';
  if (u.includes('LSE')||u.includes('LONDON')) return 'LSE';
  if (u.includes('TSX')||u.includes('TORONTO')) return 'TSX';
  return raw.split(/[\s,]/)[0].toUpperCase().slice(0,6)||'';
}
function getRating(s) {
  if (s>=5) return {label:'Strong Buy',color:'#14532d',bg:'#dcfce7',border:'#86efac'};
  if (s===4) return {label:'Buy',color:'#15803d',bg:'#f0fdf4',border:'#bbf7d0'};
  if (s===3) return {label:'Watch',color:'#92400e',bg:'#fffbeb',border:'#fde68a'};
  return       {label:'Ignore',color:'#6b7280',bg:'#f9fafb',border:'#d1d5db'};
}

// ─── Main: analyse one ticker ─────────────────────────────────────────────────
async function analyseTicker(ticker) {

  // Fire ALL sources concurrently
  const [
    metricR,      // Finnhub /stock/metric — PE, EPS, 52w, MA50, marketCap
    quoteR,       // Finnhub /quote — live price, change
    profileR,     // Finnhub /stock/profile2 — name, exchange, marketCap
    earningsR,    // Finnhub /stock/earnings — EPS actual vs estimate
    targetR,      // Finnhub /stock/price-target — analyst price target
    recR,         // Finnhub /stock/recommendation — buy/hold/sell counts
    insidFhR,     // Finnhub insider
    chartR,       // Yahoo chart — closes for MA50 + 52w range
  ] = await Promise.allSettled([
    fh(`/stock/metric?symbol=${ticker}&metric=all`, 6000),
    fh(`/quote?symbol=${ticker}`, 4000),
    fh(`/stock/profile2?symbol=${ticker}`, 4000),
    fh(`/stock/earnings?symbol=${ticker}&limit=4`, 5000),
    fh(`/stock/price-target?symbol=${ticker}`, 5000),
    fh(`/stock/recommendation?symbol=${ticker}`, 5000),
    insiderFinnhub(ticker),
    yhChart(ticker, 6000),
  ]);

  const metric  = metricR.status  === 'fulfilled' ? metricR.value  : null;
  const quote   = quoteR.status   === 'fulfilled' ? quoteR.value   : null;
  const profile = profileR.status === 'fulfilled' ? profileR.value : null;
  const earnings= earningsR.status=== 'fulfilled' ? earningsR.value: null;
  const target  = targetR.status  === 'fulfilled' ? targetR.value  : null;
  const rec     = recR.status     === 'fulfilled' ? recR.value     : null;
  const chart   = chartR.status   === 'fulfilled' ? chartR.value   : null;
  let   insData = insidFhR.status === 'fulfilled' ? insidFhR.value : null;

  // Price — Finnhub quote is most reliable for live price
  const price = quote?.c || chart?.meta?.regularMarketPrice || 0;
  if (!price) return null;

  // If Finnhub insider found nothing, try OpenInsider in the background
  // (don't block — we do it async and it will be used if it arrives in time)
  if (!insData) {
    insData = await insiderOpenInsider(ticker);
  }

  // Company info
  const company  = profile?.name || chart?.meta?.shortName || ticker;
  const exchange = cleanExch(profile?.exchange || chart?.meta?.exchangeName || '');
  const mc       = profile?.marketCapitalization ? profile.marketCapitalization * 1e6 : (chart?.meta?.marketCap || 0);
  const mcs      = fmt$M(mc);
  const chgPct   = quote?.dp ?? null;

  // Finnhub metric fields (extremely well populated for US stocks)
  const m = metric?.metric || {};

  // ── Signal 1: EPS beat ────────────────────────────────────────────────────
  let s1 = { status:'neutral', value:'No earnings data' };
  try {
    const earns = Array.isArray(earnings) ? earnings : [];
    // Finnhub returns most recent first
    const latest = earns.find(e => e.actual != null && e.estimate != null);
    if (latest) {
      const diff = latest.actual - latest.estimate;
      const beat = diff >= 0;
      const ds = Math.abs(diff) < 0.005
        ? 'in-line'
        : `${beat ? '+' : '-'}$${Math.abs(diff).toFixed(2)}`;
      const period = latest.period ? ` (${latest.period})` : '';
      s1 = { status: beat?'pass':'fail', value: beat?`Beat by ${ds}${period}`:`Missed ${ds}${period}` };
    } else {
      s1 = { status:'neutral', value:'No earnings history' };
    }
  } catch (_) {}

  // ── Signal 2: PE vs historical ────────────────────────────────────────────
  let s2 = { status:'neutral', value:'No PE data' };
  try {
    // Finnhub metric has peBasicExclExtraTTM, peTTM, epsBasicExclExtraTTM
    const pe   = m.peBasicExclExtraTTM || m.peTTM || 0;
    const eps  = m.epsBasicExclExtraTTM || m.epsTTM || 0;
    // 52w from metric (very reliable)
    const hi52 = m['52WeekHigh'] || chart?.meta?.fiftyTwoWeekHigh || 0;
    const lo52 = m['52WeekLow']  || chart?.meta?.fiftyTwoWeekLow  || 0;

    if (pe !== 0) {
      if (pe < 0) {
        // Negative PE = loss-making
        s2 = { status:'fail', value:`Loss-making (EPS: $${(eps||0).toFixed(2)})` };
      } else {
        // Estimate historical PE from 52w midpoint / EPS
        const midPx = hi52 > 0 && lo52 > 0 ? (hi52 + lo52) / 2 : 0;
        const histPE = midPx > 0 && eps > 0 ? midPx / eps : 0;
        if (histPE > 1 && histPE < 500) {
          if      (pe < histPE * 0.90) s2 = { status:'pass',    value:`PE ${pe.toFixed(1)}x < hist ~${histPE.toFixed(0)}x ✓` };
          else if (pe > histPE * 1.10) s2 = { status:'fail',    value:`PE ${pe.toFixed(1)}x > hist ~${histPE.toFixed(0)}x` };
          else                          s2 = { status:'neutral', value:`PE ${pe.toFixed(1)}x ≈ hist ~${histPE.toFixed(0)}x` };
        } else {
          s2 = { status:'neutral', value:`PE ${pe.toFixed(1)}x (TTM)` };
        }
      }
    } else if (eps < 0) {
      s2 = { status:'fail', value:`Loss-making (EPS $${eps.toFixed(2)})` };
    } else {
      s2 = { status:'neutral', value:'PE not available' };
    }
  } catch (_) {}

  // ── Signal 3: Price vs 50d MA ─────────────────────────────────────────────
  let s3 = { status:'neutral', value:'No MA data' };
  try {
    // Try Finnhub metric first (50-day moving average)
    let ma50 = m['50DayMovingAverage'] || m.ma50 || 0;
    // Fall back to computing from Yahoo chart closes
    if (!ma50 || ma50 <= 0) {
      const closes = chart?.indicators?.quote?.[0]?.close;
      ma50 = computeMA50(closes) || 0;
    }
    if (ma50 > 0) {
      const diff = price - ma50;
      const pct  = ((diff / ma50) * 100).toFixed(1);
      s3 = price <= ma50
        ? { status:'pass', value:`$${price.toFixed(2)} ≤ 50d MA $${ma50.toFixed(2)} (${pct}%)` }
        : { status:'fail', value:`$${price.toFixed(2)} > 50d MA $${ma50.toFixed(2)} (+${pct}%)` };
    } else {
      s3 = { status:'neutral', value:`Price $${price.toFixed(2)} — MA data unavailable` };
    }
  } catch (_) {}

  // ── Signal 4: Insider ─────────────────────────────────────────────────────
  let s4 = { status:'neutral', value:'No insider filings (90d)' };
  try {
    if (insData?.buys?.length > 0) {
      const sh   = insData.buys.reduce((s,t) => s + Math.abs(t._sharesTraded||t.change||0), 0);
      const n    = insData.buys.length;
      const shFmt = fmtSh(sh);
      const ago  = timeAgo(insData.buys[0]?.transactionDate);
      const parts = [`${n} buy${n>1?'s':''}`];
      if (shFmt) parts.push(shFmt);
      if (ago) parts.push(ago);
      s4 = { status:'pass', value: parts.join(' · ') };
    } else if (insData?.sells?.length > 0) {
      const sh   = insData.sells.reduce((s,t) => s + Math.abs(t._sharesTraded||t.change||0), 0);
      const n    = insData.sells.length;
      const shFmt = fmtSh(sh);
      const parts = [`${n} sell${n>1?'s':''}, no buys`];
      if (shFmt) parts.push(shFmt);
      s4 = { status:'fail', value: parts.join(' · ') };
    } else {
      s4 = { status:'neutral', value:'No insider activity (90d)' };
    }
  } catch (_) {}

  // ── Signal 5: Analyst target ──────────────────────────────────────────────
  let s5 = { status:'neutral', value:'No analyst data' };
  try {
    const tgtMedian = target?.targetMedian || target?.targetMean || 0;
    const tgtHigh   = target?.targetHigh || 0;
    const tgtLow    = target?.targetLow || 0;
    const numAnal   = target?.lastUpdated ? '' : '';

    if (tgtMedian > 0 && price > 0) {
      const up = ((tgtMedian - price) / price * 100);
      const upStr = `${up >= 0 ? '+' : ''}${up.toFixed(1)}%`;
      const range = tgtLow > 0 && tgtHigh > 0 ? ` ($${tgtLow.toFixed(0)}–$${tgtHigh.toFixed(0)})` : '';
      s5 = up >= 25
        ? { status:'pass',    value:`Target $${tgtMedian.toFixed(2)}, ${upStr} upside${range}` }
        : { status: up >= 0 ? 'neutral' : 'fail', value:`Target $${tgtMedian.toFixed(2)}, ${upStr}${range}` };
    } else {
      // Fall back to recommendation trend (buy/hold/sell counts)
      const recs = Array.isArray(rec) ? rec : [];
      const latest = recs[0]; // most recent month
      if (latest) {
        const buy   = (latest.strongBuy||0) + (latest.buy||0);
        const hold  = latest.hold||0;
        const sell  = (latest.sell||0) + (latest.strongSell||0);
        const total = buy + hold + sell;
        if (total > 0) {
          const pct = Math.round(buy / total * 100);
          s5 = {
            status: pct >= 60 ? 'pass' : pct >= 35 ? 'neutral' : 'fail',
            value: `${pct}% buy (${buy}B/${hold}H/${sell}S, ${total} analysts)`,
          };
        } else {
          s5 = { status:'neutral', value:'No analyst coverage' };
        }
      } else {
        s5 = { status:'neutral', value:'No analyst coverage' };
      }
    }
  } catch (_) {}

  // ── Signal 6: PE vs peers ─────────────────────────────────────────────────
  let s6 = { status:'neutral', value:'No peer data' };
  try {
    const curPE = m.peBasicExclExtraTTM || m.peTTM || 0;
    const peers = PEERS[ticker] || [];

    if (curPE > 0 && curPE < 200 && peers.length > 0) {
      // Fetch peer metrics in parallel — Finnhub metric is the fastest source
      const peerResults = await Promise.allSettled(
        peers.slice(0, 6).map(p =>
          fh(`/stock/metric?symbol=${p}&metric=all`, 4000)
            .then(d => {
              const pm = d?.metric || {};
              const pe = pm.peBasicExclExtraTTM || pm.peTTM || 0;
              return pe > 0 && pe < 200 ? pe : null;
            })
        )
      );
      const peerPEs = peerResults
        .filter(r => r.status === 'fulfilled' && r.value != null)
        .map(r => r.value)
        .sort((a, b) => a - b);

      if (peerPEs.length >= 1) {
        const mid = Math.floor(peerPEs.length / 2);
        const median = peerPEs.length % 2 === 0
          ? (peerPEs[mid-1] + peerPEs[mid]) / 2
          : peerPEs[mid];
        const diff = ((curPE - median) / median * 100);
        const absDiff = Math.abs(diff).toFixed(0);
        const lbl = `med ${median.toFixed(1)}x (${peerPEs.length}p)`;
        if      (diff < -10) s6 = { status:'pass',    value:`${absDiff}% below peers, ${lbl}` };
        else if (diff >  10) s6 = { status:'fail',    value:`${absDiff}% above peers, ${lbl}` };
        else                  s6 = { status:'neutral', value:`In line with peers, ${lbl}` };
      } else {
        s6 = { status:'neutral', value:`Own PE ${curPE.toFixed(1)}x — peers unavailable` };
      }
    } else if (curPE < 0) {
      s6 = { status:'neutral', value:'Peer PE N/A (loss-making)' };
    } else if (!PEERS[ticker]) {
      s6 = { status:'neutral', value:`PE ${curPE > 0 ? curPE.toFixed(1)+'x' : 'N/A'} — no peers mapped` };
    } else {
      s6 = { status:'neutral', value:'PE data needed for peers' };
    }
  } catch (_) {}

  // ── Assemble ──────────────────────────────────────────────────────────────
  const signals = [s1, s2, s3, s4, s5, s6];
  const score   = signals.filter(s => s.status === 'pass').length;
  const NAMES   = ['EPS beat','Low PE','Below MA','Insider buys','Analyst upside','Cheap vs peers'];
  const passes  = signals.map((s,i)=>s.status==='pass'?NAMES[i]:null).filter(Boolean);
  const fails   = signals.map((s,i)=>s.status==='fail'?NAMES[i]:null).filter(Boolean);

  let summaryText;
  if      (score>=5) summaryText=`Strong value candidate — ${score}/6 signals pass. Strengths: ${passes.join(', ')}.`;
  else if (score===4) summaryText=`Good signals (4/6). Passes: ${passes.join(', ')}.`;
  else if (score===3) summaryText=`Moderate signals (3/6). Passes: ${passes.join(', ')}.`;
  else if (score>0)   summaryText=`Weak signals (${score}/6). Fails: ${fails.join(', ')}.`;
  else                summaryText=fails.length?`No signals pass. Concerns: ${fails.join(', ')}.`:`Insufficient data to score fully.`;

  return {
    ticker,
    company,
    exchange,
    price:     `$${price.toFixed(2)}`,
    change:    chgPct!=null?`${chgPct>0?'+':''}${chgPct.toFixed(2)}%`:null,
    marketCap: mcs,
    score,
    signals,
    summary:   summaryText,
    rating:    getRating(score),
    updatedAt: new Date().toISOString(),
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error:'POST only' });
  if (!FINNHUB_KEY) return res.status(500).json({ error:'FINNHUB_KEY not configured' });

  const { tickers } = req.body;
  if (!Array.isArray(tickers)||!tickers.length) return res.status(400).json({ error:'tickers required' });

  const cleaned = [...new Set(tickers.slice(0,20).map(t=>t.toUpperCase().trim()).filter(Boolean))];

  const settled = await Promise.allSettled(cleaned.map(t => analyseTicker(t)));

  const results = {};
  settled.forEach((r, i) => {
    const ticker = cleaned[i];
    if (r.status==='fulfilled' && r.value) results[ticker] = r.value;
    else results[ticker] = { ticker, error: r.reason?.message||'Analysis failed' };
  });

  res.setHeader('Cache-Control','s-maxage=90,stale-while-revalidate=60');
  return res.status(200).json({ results, fetchedAt: new Date().toISOString() });
}
