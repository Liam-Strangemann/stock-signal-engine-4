// pages/api/analyse.js
// This runs SERVER-SIDE on Vercel — no CORS issues, Finnhub key is hidden

const FINNHUB_KEY = process.env.FINNHUB_KEY;
const BASE = 'https://finnhub.io/api/v1';

async function fh(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${sep}token=${FINNHUB_KEY}`;
  const res = await fetch(url, { next: { revalidate: 300 } }); // cache 5 min
  if (!res.ok) throw new Error(`Finnhub ${res.status} on ${path}`);
  const data = await res.json();
  if (data?.error) throw new Error(data.error);
  return data;
}

async function fetchStockData(ticker) {
  const now    = new Date();
  const mo30   = new Date(now - 30 * 24 * 3600 * 1000);
  const toStr  = now.toISOString().slice(0, 10);
  const fromStr = mo30.toISOString().slice(0, 10);

  const [quote, profile, metrics, earnings, insider, target] = await Promise.allSettled([
    fh(`/quote?symbol=${ticker}`),
    fh(`/stock/profile2?symbol=${ticker}`),
    fh(`/stock/metric?symbol=${ticker}&metric=all`),
    fh(`/stock/earnings?symbol=${ticker}&limit=4`),
    fh(`/stock/insider-transactions?symbol=${ticker}&from=${fromStr}&to=${toStr}`),
    fh(`/stock/price-target?symbol=${ticker}`)
  ]);

  return {
    quote:    quote.status    === 'fulfilled' ? quote.value    : null,
    profile:  profile.status  === 'fulfilled' ? profile.value  : null,
    metrics:  metrics.status  === 'fulfilled' ? metrics.value  : null,
    earnings: earnings.status === 'fulfilled' ? earnings.value : null,
    insider:  insider.status  === 'fulfilled' ? insider.value  : null,
    target:   target.status   === 'fulfilled' ? target.value   : null,
  };
}

function evaluate(ticker, d) {
  const q   = d.quote || {};
  const p   = d.profile || {};
  const m   = d.metrics?.metric || {};
  const curPx = q.c;
  if (!curPx) return null;

  const company = p.name || ticker;
  const mc = p.marketCapitalization ? p.marketCapitalization * 1e6 : 0;
  const mcs = mc > 1e12 ? `$${(mc/1e12).toFixed(2)}T`
            : mc > 1e9  ? `$${(mc/1e9).toFixed(1)}B`
            : mc > 1e6  ? `$${(mc/1e6).toFixed(0)}M` : '';

  // Signal 1 — EPS beat
  let s1 = { status: 'neutral', value: 'No data' };
  try {
    const earns = Array.isArray(d.earnings) ? d.earnings : [];
    if (earns.length > 0) {
      const e = earns[0];
      const diff = e.actual - e.estimate;
      const beat = diff >= 0;
      const ds = Math.abs(diff) < 0.005 ? 'in-line'
               : beat ? `+$${Math.abs(diff).toFixed(2)}` : `-$${Math.abs(diff).toFixed(2)}`;
      s1 = { status: beat ? 'pass' : 'fail', value: beat ? `Beat by ${ds}` : `Missed ${ds}` };
    }
  } catch(_) {}

  // Signal 2 — PE vs historical average (52wk midpoint / EPS as proxy)
  let s2 = { status: 'neutral', value: 'No data' };
  try {
    const curPE = m.peBasicExclExtraTTM || m.peTTM;
    const eps   = m.epsBasicExclExtraAnnual || m.epsTTM;
    const hi    = m['52WeekHigh'];
    const lo    = m['52WeekLow'];
    if (curPE && eps > 0 && hi && lo) {
      const histPE = ((hi + lo) / 2) / eps;
      const diff = ((curPE - histPE) / histPE * 100).toFixed(0);
      if (curPE < histPE * 0.92)
        s2 = { status: 'pass',    value: `PE ${curPE.toFixed(1)}x < hist ~${histPE.toFixed(0)}x` };
      else if (curPE > histPE * 1.08)
        s2 = { status: 'fail',    value: `PE ${curPE.toFixed(1)}x > hist ~${histPE.toFixed(0)}x` };
      else
        s2 = { status: 'neutral', value: `PE ${curPE.toFixed(1)}x ≈ hist ~${histPE.toFixed(0)}x` };
    } else if (curPE) {
      s2 = { status: 'neutral', value: `PE ${curPE.toFixed(1)}x` };
    }
  } catch(_) {}

  // Signal 3 — Price vs 50d MA
  let s3 = { status: 'neutral', value: 'No data' };
  try {
    const ma = m['50DayMA'] || m['50DayMovingAvg'];
    if (ma && curPx) {
      const pct = ((curPx - ma) / ma * 100).toFixed(1);
      s3 = curPx <= ma
        ? { status: 'pass', value: `$${curPx.toFixed(2)} ≤ MA $${ma.toFixed(2)} (${pct}%)` }
        : { status: 'fail', value: `$${curPx.toFixed(2)} > MA $${ma.toFixed(2)} (+${pct}%)` };
    }
  } catch(_) {}

  // Signal 4 — Insider buying last 30 days
  let s4 = { status: 'neutral', value: 'No data' };
  try {
    const txns = d.insider?.data || [];
    const buys  = txns.filter(t => t.transactionCode === 'P');
    const sells = txns.filter(t => t.transactionCode === 'S');
    const bv = buys.reduce((s, t) => s + Math.abs((t.share||0) * (t.transactionPrice||curPx||0)), 0);
    if (buys.length > 0) {
      const fv = bv > 1e6 ? `$${(bv/1e6).toFixed(1)}M` : bv > 1e3 ? `$${(bv/1e3).toFixed(0)}K` : `$${bv.toFixed(0)}`;
      s4 = { status: 'pass', value: `${buys.length} buy${buys.length>1?'s':''} ≈ ${fv}` };
    } else if (sells.length > 0) {
      s4 = { status: 'fail', value: `${sells.length} sell${sells.length>1?'s':''}, no buys` };
    } else {
      s4 = { status: 'neutral', value: 'No insider txns (30d)' };
    }
  } catch(_) {}

  // Signal 5 — Analyst price target ≥ +25% above current price
  let s5 = { status: 'neutral', value: 'No data' };
  try {
    const tgt = d.target?.targetMedian || d.target?.targetMean;
    if (tgt && curPx) {
      const upside = ((tgt - curPx) / curPx * 100).toFixed(1);
      s5 = parseFloat(upside) >= 25
        ? { status: 'pass', value: `Target $${tgt.toFixed(2)}, +${upside}% upside` }
        : { status: 'fail', value: `Target $${tgt.toFixed(2)}, +${upside}% upside` };
    }
  } catch(_) {}

  const signals = [s1, s2, s3, s4, s5];
  const score   = signals.filter(s => s.status === 'pass').length;
  const passes  = signals.map((s,i) => s.status==='pass'
    ? ['EPS beat','Low PE','Below 50d MA','Insider buying','Analyst upside'][i] : null).filter(Boolean);
  const fails   = signals.map((s,i) => s.status==='fail'
    ? ['EPS beat','Low PE','Below 50d MA','Insider buying','Analyst upside'][i] : null).filter(Boolean);

  let summary;
  if (score >= 4)      summary = `Strong value candidate — ${score}/5 signals pass. Strengths: ${passes.join(', ')}.`;
  else if (score === 3) summary = `Moderate signals (3/5). Passes: ${passes.join(', ')}.`;
  else if (score > 0)   summary = `Weak signals (${score}/5). Fails: ${fails.join(', ')}.`;
  else                  summary = `No signals pass currently. Fails: ${fails.join(', ')}.`;

  return {
    ticker, company,
    price: `$${curPx.toFixed(2)}`,
    change: q.dp != null ? `${q.dp > 0 ? '+' : ''}${q.dp.toFixed(2)}%` : null,
    marketCap: mcs,
    score, signals, summary,
    updatedAt: new Date().toISOString()
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!FINNHUB_KEY) return res.status(500).json({ error: 'FINNHUB_KEY environment variable not set' });

  const { tickers } = req.body;
  if (!Array.isArray(tickers) || tickers.length === 0)
    return res.status(400).json({ error: 'tickers array required' });

  const results = {};
  const cleaned = tickers.slice(0, 20).map(t => t.toUpperCase().trim());

  await Promise.allSettled(
    cleaned.map(async ticker => {
      try {
        const raw = await fetchStockData(ticker);
        const ev  = evaluate(ticker, raw);
        results[ticker] = ev || { ticker, error: 'No quote data — check ticker symbol' };
      } catch(e) {
        results[ticker] = { ticker, error: e.message };
      }
    })
  );

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
  return res.status(200).json({ results, fetchedAt: new Date().toISOString() });
}
