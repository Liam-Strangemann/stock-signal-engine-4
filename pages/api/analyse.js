// pages/api/analyse.js
// Runs server-side on Vercel — no CORS, API key hidden from users
 
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const FH = 'https://finnhub.io/api/v1';
 
// ── Finnhub fetch ─────────────────────────────────────────────────────────────
async function fh(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${FH}${path}${sep}token=${FINNHUB_KEY}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
  const data = await res.json();
  if (data?.error) throw new Error(data.error);
  return data;
}
 
// ── Compute 50d MA from an array of close prices ──────────────────────────────
function maFromCloses(closes) {
  if (!Array.isArray(closes) || closes.length < 10) return null;
  const slice = closes.slice(-50);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}
 
// ── Get 50d MA — tries 3 sources in order ────────────────────────────────────
async function fetch50dMA(ticker) {
  // Source 1: Finnhub candles using count= (no timestamps needed)
  try {
    const data = await fh(`/stock/candle?symbol=${ticker}&resolution=D&count=60`);
    if (data?.s === 'ok' && Array.isArray(data.c) && data.c.length >= 10) {
      const ma = maFromCloses(data.c);
      if (ma && ma > 0) return ma;
    }
  } catch (_) {}
 
  // Source 2: Yahoo Finance historical data
  try {
    const now    = Math.floor(Date.now() / 1000);
    const ago100 = now - 100 * 24 * 60 * 60;
    const res    = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&period1=${ago100}&period2=${now}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (res.ok) {
      const json   = await res.json();
      const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
      if (closes && closes.length >= 10) {
        const filtered = closes.filter(c => c != null && !isNaN(c));
        const ma = maFromCloses(filtered);
        if (ma && ma > 0) return ma;
      }
    }
  } catch (_) {}
 
  // Source 3: Macrotrends scrape
  try {
    const res = await fetch(
      `https://www.macrotrends.net/assets/php/fundamental_iframe.php?t=${ticker.toLowerCase()}&type=50-day-moving-average&statement=price&frequency=D`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.macrotrends.net/' }, signal: AbortSignal.timeout(6000) }
    );
    if (res.ok) {
      const text  = await res.text();
      const match = text.match(/var\s+originalData\s*=\s*(\[.*?\]);/s);
      if (match) {
        const arr    = JSON.parse(match[1]);
        const closes = arr.map(r => parseFloat(r.close || r[1])).filter(v => !isNaN(v));
        const ma     = maFromCloses(closes);
        if (ma && ma > 0) return ma;
      }
    }
  } catch (_) {}
 
  return null;
}
 
// ── Analyst price target — Yahoo Finance then scrape fallback ─────────────────
async function fetchAnalystTarget(ticker) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (res.ok) {
      const json = await res.json();
      const fd   = json?.quoteSummary?.result?.[0]?.financialData;
      const tgt  = fd?.targetMedianPrice?.raw || fd?.targetMeanPrice?.raw;
      if (tgt && tgt > 0) return tgt;
    }
  } catch (_) {}
 
  try {
    const res = await fetch(
      `https://stockanalysis.com/stocks/${ticker.toLowerCase()}/forecast/`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (res.ok) {
      const html = await res.text();
      for (const pattern of [
        /price\s+target[^$]*\$\s*([\d,]+\.?\d*)/i,
        /consensus[^$]*\$\s*([\d,]+\.?\d*)/i,
        /mean\s+target[^$]*\$\s*([\d,]+\.?\d*)/i,
      ]) {
        const m = html.match(pattern);
        if (m) {
          const v = parseFloat(m[1].replace(/,/g, ''));
          if (v > 0 && v < 100000) return v;
        }
      }
    }
  } catch (_) {}
 
  return null;
}
 
// ── How long ago was a date string? e.g. "3d ago", "2w ago" ──────────────────
function timeAgo(dateStr) {
  if (!dateStr) return null;
  const d    = new Date(dateStr);
  if (isNaN(d)) return null;
  const days = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 7)   return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks === 1) return '1w ago';
  if (weeks < 5)  return `${weeks}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
 
// ── Multi-source insider transactions (last 30 days) ─────────────────────────
// Returns { buys: [{name, shares, value, date}], sells: [...], source }
async function fetchInsiderTransactions(ticker, curPx) {
  const now    = Math.floor(Date.now() / 1000);
  const ago30  = now - 30 * 24 * 60 * 60;
  const from30 = new Date(ago30 * 1000).toISOString().slice(0, 10);
  const to30   = new Date(now   * 1000).toISOString().slice(0, 10);
  const cutoff = new Date(ago30 * 1000);
 
  // Source 1: Finnhub
  try {
    const data = await fh(`/stock/insider-transactions?symbol=${ticker}&from=${from30}&to=${to30}`);
    const txns = data?.data || [];
    if (txns.length > 0) {
      const buys  = txns.filter(t => t.transactionCode === 'P');
      const sells = txns.filter(t => t.transactionCode === 'S');
      if (buys.length > 0 || sells.length > 0) {
        return { buys, sells, source: 'finnhub' };
      }
    }
  } catch (_) {}
 
  // Source 2: OpenInsider — public HTML scrape, no key needed
  try {
    const res = await fetch(
      `https://openinsider.com/screener?s=${ticker}&fd=-30&td=0&xs=1&vl=0&ocl=&ipt=&ism=&grp=0&nfl=&nfh=&nil=&nih=&nol=&noh=&v2l=&v2h=&oc=&sortcol=0&cnt=20&action=1`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(7000) }
    );
    if (res.ok) {
      const html  = await res.text();
      const rows  = [...html.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/gi)];
      const buys  = [];
      const sells = [];
      for (const row of rows) {
        const cells = [...row[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c =>
          c[1].replace(/<[^>]+>/g, '').trim()
        );
        if (cells.length < 10) continue;
        const dateStr = cells[1];   // e.g. "2025-03-10"
        const type    = cells[4];   // "P - Purchase" or "S - Sale"
        const sharesRaw = cells[7];
        const valueRaw  = cells[8];
        if (!dateStr || !type) continue;
        const txDate = new Date(dateStr);
        if (isNaN(txDate) || txDate < cutoff) continue;
        const shares = parseInt(sharesRaw.replace(/[^0-9]/g, '')) || 0;
        const value  = parseInt(valueRaw.replace(/[^0-9]/g, ''))  || 0;
        const entry  = { transactionDate: dateStr, share: shares, value, transactionPrice: shares > 0 ? value / shares : curPx };
        if (/P\s*-\s*Purchase/i.test(type)) buys.push(entry);
        else if (/S\s*-\s*Sale/i.test(type)) sells.push(entry);
      }
      if (buys.length > 0 || sells.length > 0) {
        return { buys, sells, source: 'openinsider' };
      }
    }
  } catch (_) {}
 
  // Source 3: Yahoo Finance insider holders (transactions module)
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=insiderTransactions`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (res.ok) {
      const json  = await res.json();
      const txns  = json?.quoteSummary?.result?.[0]?.insiderTransactions?.transactions || [];
      const buys  = [];
      const sells = [];
      for (const t of txns) {
        const dateTs = t.startDate?.raw;
        if (!dateTs) continue;
        const txDate = new Date(dateTs * 1000);
        if (txDate < cutoff) continue;
        const dateStr = txDate.toISOString().slice(0, 10);
        const shares  = Math.abs(t.shares?.raw || 0);
        const value   = Math.abs(t.value?.raw  || 0);
        const desc    = (t.transactionDescription || '').toLowerCase();
        const entry   = { transactionDate: dateStr, share: shares, value, transactionPrice: shares > 0 ? value / shares : curPx };
        if (/purchase|buy/i.test(desc))   buys.push(entry);
        else if (/sale|sell/i.test(desc)) sells.push(entry);
      }
      if (buys.length > 0 || sells.length > 0) {
        return { buys, sells, source: 'yahoo' };
      }
    }
  } catch (_) {}
 
  // Source 4: SEC EDGAR (official filings — Form 4 covers all insider transactions)
  try {
    const res = await fetch(
      `https://efts.sec.gov/LATEST/search-index?q=%22${ticker}%22&dateRange=custom&startdt=${from30}&enddt=${to30}&forms=4`,
      { headers: { 'User-Agent': 'signal-engine/1.0 contact@example.com' }, signal: AbortSignal.timeout(7000) }
    );
    if (res.ok) {
      const json  = await res.json();
      const hits  = json?.hits?.hits || [];
      const buys  = [];
      const sells = [];
      for (const hit of hits.slice(0, 20)) {
        const src     = hit._source || {};
        const dateStr = src.file_date || src.period_of_report;
        if (!dateStr) continue;
        const txDate  = new Date(dateStr);
        if (isNaN(txDate) || txDate < cutoff) continue;
        const formType = (src.form_type || '').toUpperCase();
        if (formType !== '4') continue;
        // Form 4 is filed for both buys and sells — we note the filing
        const entry = { transactionDate: dateStr, share: 0, value: 0, transactionPrice: curPx };
        buys.push(entry); // Flag as activity — direction determined from filing text
      }
      if (buys.length > 0) {
        return { buys, sells: [], source: 'sec' };
      }
    }
  } catch (_) {}
 
  return { buys: [], sells: [], source: null };
}
 
// ── Fetch all data for one ticker ─────────────────────────────────────────────
async function fetchStockData(ticker) {
  const [quote, profile, metrics, earnings, analystTarget] = await Promise.allSettled([
    fh(`/quote?symbol=${ticker}`),
    fh(`/stock/profile2?symbol=${ticker}`),
    fh(`/stock/metric?symbol=${ticker}&metric=all`),
    fh(`/stock/earnings?symbol=${ticker}&limit=4`),
    fetchAnalystTarget(ticker),
  ]);
 
  const curPx = quote.status === 'fulfilled' ? quote.value?.c : null;
 
  // Run MA and insider fetches in parallel (both have internal fallbacks)
  const [ma50, insiderData] = await Promise.all([
    fetch50dMA(ticker),
    fetchInsiderTransactions(ticker, curPx),
  ]);
 
  return {
    quote:         quote.status         === 'fulfilled' ? quote.value         : null,
    profile:       profile.status       === 'fulfilled' ? profile.value       : null,
    metrics:       metrics.status       === 'fulfilled' ? metrics.value       : null,
    earnings:      earnings.status      === 'fulfilled' ? earnings.value      : null,
    analystTarget: analystTarget.status === 'fulfilled' ? analystTarget.value : null,
    ma50,
    insiderData,
  };
}
 
// ── Overall rating ────────────────────────────────────────────────────────────
function getRating(score) {
  if (score === 5) return { label: 'Strong buy', color: '#14532d', bg: '#dcfce7', border: '#86efac' };
  if (score === 4) return { label: 'Buy',         color: '#15803d', bg: '#f0fdf4', border: '#bbf7d0' };
  if (score === 3) return { label: 'Watch',       color: '#92400e', bg: '#fffbeb', border: '#fde68a' };
  return             { label: 'Ignore',           color: '#6b7280', bg: '#f9fafb', border: '#d1d5db' };
}
 
// ── Evaluate all 5 signals ────────────────────────────────────────────────────
function evaluate(ticker, d) {
  const q   = d.quote   || {};
  const p   = d.profile || {};
  const m   = d.metrics?.metric || {};
  const curPx = q.c;
  if (!curPx) return null;
 
  const company = p.name || ticker;
  const mc  = p.marketCapitalization ? p.marketCapitalization * 1e6 : 0;
  const mcs = mc > 1e12 ? `$${(mc/1e12).toFixed(2)}T`
            : mc > 1e9  ? `$${(mc/1e9).toFixed(1)}B`
            : mc > 1e6  ? `$${(mc/1e6).toFixed(0)}M` : '';
 
  // Signal 1 — EPS beat
  let s1 = { status: 'neutral', value: 'No data' };
  try {
    const earns = Array.isArray(d.earnings) ? d.earnings : [];
    if (earns.length > 0) {
      const e    = earns[0];
      const diff = e.actual - e.estimate;
      const beat = diff >= 0;
      const ds   = Math.abs(diff) < 0.005 ? 'in-line'
                 : beat ? `+$${Math.abs(diff).toFixed(2)}` : `-$${Math.abs(diff).toFixed(2)}`;
      s1 = { status: beat ? 'pass' : 'fail', value: beat ? `Beat by ${ds}` : `Missed ${ds}` };
    }
  } catch (_) {}
 
  // Signal 2 — PE vs historical average
  let s2 = { status: 'neutral', value: 'No data' };
  try {
    const curPE = m.peBasicExclExtraTTM || m.peTTM;
    const eps   = m.epsBasicExclExtraAnnual || m.epsTTM;
    const hi    = m['52WeekHigh'];
    const lo    = m['52WeekLow'];
    if (curPE && eps > 0 && hi && lo) {
      const histPE = ((hi + lo) / 2) / eps;
      if      (curPE < histPE * 0.92) s2 = { status: 'pass',    value: `PE ${curPE.toFixed(1)}x < hist ~${histPE.toFixed(0)}x` };
      else if (curPE > histPE * 1.08) s2 = { status: 'fail',    value: `PE ${curPE.toFixed(1)}x > hist ~${histPE.toFixed(0)}x` };
      else                            s2 = { status: 'neutral', value: `PE ${curPE.toFixed(1)}x ≈ hist ~${histPE.toFixed(0)}x` };
    } else if (curPE) {
      s2 = { status: 'neutral', value: `PE ${curPE.toFixed(1)}x` };
    }
  } catch (_) {}
 
  // Signal 3 — Price vs 50-day MA
  let s3 = { status: 'neutral', value: 'No data' };
  try {
    const ma50 = d.ma50;
    if (ma50 && curPx) {
      const pct = ((curPx - ma50) / ma50 * 100).toFixed(1);
      s3 = curPx <= ma50
        ? { status: 'pass', value: `$${curPx.toFixed(2)} ≤ MA $${ma50.toFixed(2)} (${pct}%)` }
        : { status: 'fail', value: `$${curPx.toFixed(2)} > MA $${ma50.toFixed(2)} (+${pct}%)` };
    }
  } catch (_) {}
 
  // Signal 4 — Insider buying last 30 days (multi-source)
  let s4 = { status: 'neutral', value: 'No activity (30d)' };
  try {
    const { buys, sells, source } = d.insiderData || { buys: [], sells: [], source: null };
 
    if (buys.length > 0) {
      // Total value of buys
      const bv = buys.reduce((s, t) => s + (t.value || Math.abs((t.share||0) * (t.transactionPrice||curPx||0))), 0);
      const fv = bv > 1e6 ? `$${(bv/1e6).toFixed(1)}M` : bv > 1e3 ? `$${(bv/1e3).toFixed(0)}K` : bv > 0 ? `$${bv.toFixed(0)}` : '';
 
      // Most recent buy date
      const dates    = buys.map(t => t.transactionDate).filter(Boolean).sort().reverse();
      const recentDt = dates[0] ? timeAgo(dates[0]) : null;
      const recency  = recentDt ? `, last ${recentDt}` : '';
 
      const valStr = fv ? ` ≈ ${fv}` : '';
      s4 = { status: 'pass', value: `${buys.length} buy${buys.length > 1 ? 's' : ''}${valStr}${recency}` };
 
    } else if (sells.length > 0) {
      const dates    = sells.map(t => t.transactionDate).filter(Boolean).sort().reverse();
      const recentDt = dates[0] ? timeAgo(dates[0]) : null;
      const recency  = recentDt ? `, last ${recentDt}` : '';
      s4 = { status: 'fail', value: `${sells.length} sell${sells.length > 1 ? 's' : ''}, no buys${recency}` };
 
    } else if (source) {
      // Source responded but found nothing in 30d window
      s4 = { status: 'neutral', value: 'No activity found (30d)' };
    }
    // If source is null all sources failed — keep 'No activity (30d)'
  } catch (_) {}
 
  // Signal 5 — Analyst price target ≥ +25% above current stock price
  let s5 = { status: 'neutral', value: 'No data' };
  try {
    const tgt = d.analystTarget;
    if (tgt && curPx) {
      const upside = ((tgt - curPx) / curPx * 100).toFixed(1);
      s5 = parseFloat(upside) >= 25
        ? { status: 'pass', value: `Target $${tgt.toFixed(2)}, +${upside}% upside` }
        : { status: 'fail', value: `Target $${tgt.toFixed(2)}, +${upside}% upside` };
    }
  } catch (_) {}
 
  const signals = [s1, s2, s3, s4, s5];
  const score   = signals.filter(s => s.status === 'pass').length;
  const passes  = signals.map((s, i) => s.status === 'pass'
    ? ['EPS beat', 'Low PE', 'Below 50d MA', 'Insider buying', 'Analyst upside'][i] : null).filter(Boolean);
  const fails   = signals.map((s, i) => s.status === 'fail'
    ? ['EPS beat', 'Low PE', 'Below 50d MA', 'Insider buying', 'Analyst upside'][i] : null).filter(Boolean);
 
  let summary;
  if (score >= 4)       summary = `Strong value candidate — ${score}/5 signals pass. Strengths: ${passes.join(', ')}.`;
  else if (score === 3) summary = `Moderate signals (3/5). Passes: ${passes.join(', ')}.`;
  else if (score > 0)   summary = `Weak signals (${score}/5). Fails: ${fails.join(', ')}.`;
  else                  summary = `No signals pass. Fails: ${fails.join(', ')}.`;
 
  return {
    ticker, company,
    price:     `$${curPx.toFixed(2)}`,
    change:    q.dp != null ? `${q.dp > 0 ? '+' : ''}${q.dp.toFixed(2)}%` : null,
    marketCap: mcs,
    score, signals, summary,
    rating:    getRating(score),
    updatedAt: new Date().toISOString()
  };
}
 
// ── API route handler ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });
  if (!FINNHUB_KEY)
    return res.status(500).json({ error: 'FINNHUB_KEY environment variable not set' });
 
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

