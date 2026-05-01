// pages/api/analyse.js  v17
//
// FIXES vs v16:
// 1. EPS period: convert Finnhub fiscal-end date (2026-03-31) → "Q1 2026" quarter label
// 2. EPS fallback: if Finnhub earnings array empty, try metric epsAnnual + previous epsAnnual
//    so "No earnings history" almost never appears for US stocks
// 3. MA50: chart fetched with range=2y (guarantees 500+ bars, never falls to 52w mid)
//    52w-mid fallback completely removed — only real MA shown
// 4. Analyst upside: Finnhub price-target PLUS Yahoo quoteSummary price module
//    (different, fast endpoint, rarely blocked) — dual source ensures target always found
// 5. "No analyst coverage" fallback: also check Finnhub metric analyticsRatingCurrent
// 6. Universe: top3.js expanded to 1,500+ tickers in 10 batches

export const config = { maxDuration: 25 };

const FINNHUB_KEY = process.env.FINNHUB_KEY;
const FH_BASE = 'https://finnhub.io/api/v1';

const YH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
};

// ─── Finnhub ──────────────────────────────────────────────────────────────────
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

// ─── Yahoo chart — 2 years of daily closes guarantees 50+ bars for MA ────────
async function yhChart(ticker, ms = 7000) {
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(
        `${base}/v8/finance/chart/${ticker}?interval=1d&range=2y`,
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

// ─── Yahoo quoteSummary PRICE module only — fast, rarely blocked ──────────────
// Used exclusively to get targetMeanPrice + targetMedianPrice for analyst signal
async function yhPrice(ticker, ms = 5000) {
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(
        `${base}/v10/finance/quoteSummary/${ticker}?modules=financialData,defaultKeyStatistics`,
        { headers: YH_HEADERS, signal: AbortSignal.timeout(ms) }
      );
      if (r.status === 401 || r.status === 429 || !r.ok) continue;
      const j = await r.json();
      const res = j?.quoteSummary?.result?.[0];
      if (res) return res;
    } catch (_) {}
  }
  return null;
}

// ─── Insider ──────────────────────────────────────────────────────────────────
const MAX_SH = 5_000_000;

async function insiderFinnhub(ticker) {
  const now  = Math.floor(Date.now() / 1000);
  const from = new Date((now - 90 * 86400) * 1000).toISOString().slice(0, 10);
  const to   = new Date(now * 1000).toISOString().slice(0, 10);
  const d    = await fh(`/stock/insider-transactions?symbol=${ticker}&from=${from}&to=${to}`, 6000);
  if (!d?.data?.length) return null;
  const cut   = Date.now() - 90 * 86400 * 1000;
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
      const type      = cells[3] || '';
      const sharesStr = (cells[7] || '').replace(/[^0-9]/g, '');
      const shares    = parseInt(sharesStr, 10) || 0;
      if (shares <= 0 || shares > MAX_SH) continue;
      const entry = { _sharesTraded: shares, transactionDate: cells[1] || '' };
      if (/P\s*-\s*Purchase/i.test(type))                            buys.push(entry);
      else if (/S\s*-\s*Sale/i.test(type) && !/Sale\+OE/i.test(type)) sells.push(entry);
    }
    if (!buys.length && !sells.length) return null;
    return { buys, sells, src: 'openinsider' };
  } catch (_) { return null; }
}

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
  if (n >= 1e6) return `${(n/1e6).toFixed(1)}M shares`;
  if (n >= 1e3) return `${(n/1e3).toFixed(0)}K shares`;
  return `${Math.round(n).toLocaleString()} shares`;
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
  return raw.split(/[\s,]/)[0].toUpperCase().slice(0, 6) || '';
}
function getRating(s) {
  if (s >= 5) return { label:'Strong Buy', color:'#14532d', bg:'#dcfce7', border:'#86efac' };
  if (s === 4) return { label:'Buy',        color:'#15803d', bg:'#f0fdf4', border:'#bbf7d0' };
  if (s === 3) return { label:'Watch',      color:'#92400e', bg:'#fffbeb', border:'#fde68a' };
  return             { label:'Ignore',      color:'#6b7280', bg:'#f9fafb', border:'#d1d5db' };
}

// FIX 1: Convert Finnhub fiscal-end date → readable quarter label
// e.g. "2026-03-31" → "Q1 2026", "2025-12-31" → "Q4 2025"
function periodToQuarter(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  const m = d.getUTCMonth() + 1; // 1-12
  const y = d.getUTCFullYear();
  const q = m <= 3 ? 'Q1' : m <= 6 ? 'Q2' : m <= 9 ? 'Q3' : 'Q4';
  return `${q} ${y}`;
}

// ─── Peer PE map ──────────────────────────────────────────────────────────────
const PEERS = {
  AAPL:['MSFT','GOOGL','META','NVDA','AMZN'],  MSFT:['AAPL','GOOGL','CRM','ORCL','NOW'],
  GOOGL:['META','MSFT','AMZN','SNAP'],           META:['GOOGL','SNAP','PINS','AMZN'],
  AMZN:['MSFT','GOOGL','WMT','COST','JD'],       NVDA:['AMD','INTC','QCOM','AVGO','TXN'],
  TSLA:['GM','F','TM','RIVN','NIO'],             AVGO:['QCOM','TXN','ADI','AMD','MRVL'],
  ORCL:['SAP','MSFT','CRM','IBM','NOW'],         AMD:['NVDA','INTC','QCOM','TXN','MU'],
  INTC:['AMD','NVDA','QCOM','TXN','AVGO'],       QCOM:['AVGO','TXN','ADI','MRVL','AMD'],
  JPM:['BAC','WFC','C','GS','MS'],               BAC:['JPM','WFC','C','USB','PNC'],
  WFC:['JPM','BAC','C','USB','TFC'],             GS:['MS','JPM','C','BLK','SCHW'],
  MS:['GS','JPM','C','BLK','SCHW'],              LLY:['NVO','PFE','MRK','ABBV','BMY'],
  JNJ:['PFE','ABBV','MRK','TMO','ABT'],          UNH:['CVS','CI','HUM','ELV','CNC'],
  ABBV:['PFE','LLY','MRK','BMY','REGN'],         MRK:['PFE','JNJ','ABBV','LLY','BMY'],
  XOM:['CVX','COP','SLB','EOG','OXY'],           CVX:['XOM','COP','SLB','EOG','DVN'],
  HD:['LOW','WMT','TGT','COST','ORLY'],          LOW:['HD','WMT','TGT','COST'],
  WMT:['TGT','COST','KR','HD','AMZN'],           TGT:['WMT','COST','HD','DG','DLTR'],
  MCD:['YUM','CMG','QSR','DRI','SBUX'],          NKE:['UAA','DECK','LULU','SKX','VFC'],
  KO:['PEP','MDLZ','MNST','KHC'],                PEP:['KO','MDLZ','MNST','KHC','GIS'],
  T:['VZ','TMUS','CMCSA','CHTR'],                VZ:['T','TMUS','CMCSA','CHTR'],
  MA:['V','PYPL','AXP','FIS','FISV'],            V:['MA','PYPL','AXP','FIS','GPN'],
  NFLX:['DIS','WBD','PARA','ROKU','SPOT'],       DIS:['NFLX','WBD','CMCSA','PARA'],
  CAT:['DE','HON','EMR','ITW','PH'],             HON:['CAT','EMR','ITW','ETN','ROK'],
  NEE:['DUK','SO','AEP','EXC','D'],              AMT:['PLD','EQIX','CCI','SPG','SBAC'],
  BLK:['SCHW','MS','GS','IVZ','AMP'],            TMO:['DHR','IQV','IDXX','WAT','A'],
  ABT:['MDT','BSX','SYK','BDX','EW'],            AMGN:['REGN','BIIB','VRTX','GILD','BMY'],
  SCHW:['MS','GS','BLK','AXP','IBKR'],           SBUX:['MCD','CMG','YUM','QSR','DRI'],
  COST:['WMT','TGT','HD','BJ','PSMT'],           CMG:['MCD','YUM','DRI','QSR','WING'],
  CRM:['NOW','ADBE','ORCL','MSFT','WDAY'],       ADBE:['CRM','NOW','INTU','MSFT'],
  NOW:['CRM','ADBE','WDAY','MSFT','SAP'],        INTU:['ADBE','CRM','ADP','MSFT'],
  PYPL:['MA','V','SQ','AFRM','GPN'],             UBER:['LYFT','ABNB','DASH','GRAB'],
  ABNB:['BKNG','EXPE','TRIP','UBER'],            SQ:['PYPL','MA','V','AFRM','GPN'],
  SHOP:['WIX','BIGC','ETSY','AMZN'],             SNAP:['META','PINS','GOOGL','TWTR'],
  PINS:['META','SNAP','GOOGL','TTD'],            SPOT:['NFLX','AAPL','AMZN','PARA'],
  WDAY:['CRM','NOW','INTU','ORCL'],              PANW:['CRWD','FTNT','ZS','OKTA'],
  CRWD:['PANW','FTNT','ZS','S','OKTA'],          ZS:['PANW','CRWD','FTNT','OKTA'],
  FTNT:['PANW','CRWD','ZS','CHKP'],              DDOG:['SNOW','MDB','ESTC','SPLK'],
  SNOW:['DDOG','MDB','PLTR','DBX'],              MDB:['DDOG','SNOW','ESTC','CRM'],
  PLTR:['BBAI','AI','SNOW','DDOG'],              RBLX:['EA','TTWO','ATVI','U'],
  EA:['TTWO','RBLX','ATVI','NTDOY'],             TTWO:['EA','RBLX','ATVI','THQ'],
  TXN:['ADI','MCHP','NXPI','ON','AVGO'],         ADI:['TXN','MCHP','NXPI','ON'],
  MU:['WDC','STX','NAND','AMD'],                 AMAT:['LRCX','KLAC','ASML','NVDA'],
  LRCX:['AMAT','KLAC','ASML','TER'],             KLAC:['AMAT','LRCX','ASML','TER'],
  ACN:['IBM','CTSH','INFY','WIT','GLOB'],        IBM:['ACN','ORCL','MSFT','HPE','CSC'],
  UNP:['CSX','NSC','CP','CNI'],                  CSX:['UNP','NSC','CP','CNI'],
  LMT:['RTX','NOC','GD','BA','HII'],             RTX:['LMT','NOC','GD','BA'],
  BA:['AIR','LMT','RTX','HII'],                  GD:['LMT','RTX','NOC','HII'],
  DE:['CAT','AGCO','CNH','KUBOTA'],              EMR:['HON','ETN','ROK','ABB'],
  ETN:['HON','EMR','ROK','IR','PH'],             PH:['HON','EMR','ETN','IR'],
  SLB:['HAL','BKR','OXY','COP'],                HAL:['SLB','BKR','OXY','DVN'],
  COP:['XOM','CVX','EOG','DVN','OXY'],           EOG:['COP','DVN','OXY','MRO','APA'],
  DVN:['EOG','COP','OXY','FANG','MRO'],          OXY:['CVX','COP','EOG','DVN'],
  UPS:['FDX','XPO','ODFL','SAIA'],               FDX:['UPS','XPO','ODFL','JBHT'],
  ODFL:['SAIA','XPO','FDX','UPS'],               BKNG:['EXPE','ABNB','TRIP','TCOM'],
  EXPE:['BKNG','ABNB','TRIP','TCOM'],            REGN:['AMGN','BIIB','VRTX','GILD'],
  BIIB:['AMGN','REGN','VRTX','MRNA'],            VRTX:['AMGN','REGN','BIIB','ALNY'],
  GILD:['AMGN','BMY','ABBV','MRK'],              PFE:['MRK','JNJ','ABBV','LLY','BMY'],
  BMY:['PFE','MRK','ABBV','LLY','AMGN'],         MDT:['ABT','BSX','SYK','BDX','ZBH'],
  BSX:['MDT','ABT','SYK','EW','ZBH'],            SYK:['MDT','ABT','BSX','ZBH','ISRG'],
  ISRG:['SYK','ABT','MDT','INTUITY'],            EW:['BSX','MDT','ABT','SYK'],
  TMO:['DHR','IQV','IDXX','WAT','A'],            DHR:['TMO','IQV','A','WAT','BIO'],
  IDXX:['VIVO','HEXX','TMO','DHR'],              ZBH:['SYK','MDT','BSX','ABT'],
  EXC:['DUK','SO','AEP','PEG','XEL'],            DUK:['SO','AEP','EXC','D','NEE'],
  SO:['DUK','AEP','EXC','D','NEE'],              AEP:['DUK','SO','EXC','D','XEL'],
  D:['DUK','SO','AEP','EXC','NEE'],              PLD:['AMT','EQIX','CCI','SBAC','PSA'],
  EQIX:['AMT','CCI','PLD','SBAC','DLR'],        CCI:['AMT','EQIX','SBAC','PLD'],
  SPG:['O','VICI','REG','KIM','MAC'],            O:['SPG','VICI','NNN','STAG'],
  VICI:['O','SPG','MGM','LVS'],                  PSA:['EXR','CUBE','LSI','NSA'],
  AXP:['MA','V','DFS','COF'],                    DFS:['AXP','COF','SYF','MA'],
  COF:['DFS','AXP','SYF','MA','V'],              USB:['PNC','TFC','FITB','KEY'],
  PNC:['USB','TFC','FITB','MTB'],                TFC:['USB','PNC','FITB','KEY'],
  CI:['UNH','HUM','ELV','CVS','MOH'],            HUM:['UNH','CI','ELV','CVS','CNC'],
  ELV:['UNH','CI','HUM','CVS','CNC'],            CNC:['UNH','CI','HUM','ELV','MOH'],
  CVS:['WBA','UNH','CI','HUM','ELV'],            WBA:['CVS','RAD','AMZN'],
  CMCSA:['DIS','NFLX','WBD','CHTR','T'],         CHTR:['CMCSA','T','VZ','TMUS'],
  TMUS:['T','VZ','CMCSA','CHTR'],                KR:['WMT','TGT','COST','SFM','VLGEA'],
  DLTR:['DG','WMT','TGT','FIVE'],                DG:['DLTR','WMT','TGT','FIVE'],
  NVO:['LLY','PFE','ABBV','SNY','AZN'],          ASML:['AMAT','LRCX','KLAC','TSM'],
  TSM:['ASML','NVDA','INTC','SSNLF'],            SAP:['ORCL','MSFT','CRM','NOW'],
  TM:['TSLA','HMC','F','GM','STLA'],             AZN:['JNJ','PFE','LLY','GSK','NVO'],
  SHEL:['XOM','CVX','BP','TTE'],                 BHP:['RIO','VALE','FCX','GLEN'],
  RIO:['BHP','VALE','FCX','AA'],                 HSBC:['JPM','BAC','C','BCS','DB'],
};

// ─── analyseTicker ────────────────────────────────────────────────────────────
async function analyseTicker(ticker, preloadedMetric = null, batchPECache = {}) {

  const [
    quoteR,
    profileR,
    earningsR,
    targetR,
    recR,
    insidFhR,
    chartR,
    yhPriceR,   // Yahoo financialData — price target
  ] = await Promise.allSettled([
    fh(`/quote?symbol=${ticker}`, 4000),
    fh(`/stock/profile2?symbol=${ticker}`, 4000),
    fh(`/stock/earnings?symbol=${ticker}&limit=8`, 5000),
    fh(`/stock/price-target?symbol=${ticker}`, 5000),
    fh(`/stock/recommendation?symbol=${ticker}`, 5000),
    insiderFinnhub(ticker),
    yhChart(ticker, 7000),
    yhPrice(ticker, 5000),
  ]);

  const metric  = preloadedMetric || null;
  const quote   = quoteR.status    === 'fulfilled' ? quoteR.value    : null;
  const profile = profileR.status  === 'fulfilled' ? profileR.value  : null;
  const earnings= earningsR.status === 'fulfilled' ? earningsR.value : null;
  const target  = targetR.status   === 'fulfilled' ? targetR.value   : null;
  const rec     = recR.status      === 'fulfilled' ? recR.value      : null;
  const chart   = chartR.status    === 'fulfilled' ? chartR.value    : null;
  const yhFin   = yhPriceR.status  === 'fulfilled' ? yhPriceR.value  : null;
  let   insData = insidFhR.status  === 'fulfilled' ? insidFhR.value  : null;

  const price = quote?.c || chart?.meta?.regularMarketPrice || 0;
  if (!price) return null;

  if (!insData) insData = await insiderOpenInsider(ticker);

  const company  = profile?.name || chart?.meta?.shortName || ticker;
  const exchange = cleanExch(profile?.exchange || chart?.meta?.exchangeName || '');
  const mc       = profile?.marketCapitalization
    ? profile.marketCapitalization * 1e6
    : (chart?.meta?.marketCap || 0);
  const mcs    = fmt$M(mc);
  const chgPct = quote?.dp ?? null;
  const m      = metric?.metric || {};

  // ── Signal 1: EPS beat ────────────────────────────────────────────────────
  let s1 = { status:'neutral', value:'No earnings data' };
  try {
    const earns = Array.isArray(earnings) ? earnings : [];
    // Finnhub earnings: find most recent where both actual and estimate exist
    const latest = earns.find(e => e.actual != null && e.estimate != null);
    if (latest) {
      const diff  = latest.actual - latest.estimate;
      const beat  = diff >= 0;
      const ds    = Math.abs(diff) < 0.005
        ? 'in-line'
        : `${beat ? '+' : '-'}$${Math.abs(diff).toFixed(2)}`;
      // FIX 1: convert fiscal-end date to quarter label
      const qLabel = latest.period ? periodToQuarter(latest.period) : '';
      const suffix = qLabel ? ` (${qLabel})` : '';
      s1 = { status: beat ? 'pass' : 'fail', value: beat ? `Beat by ${ds}${suffix}` : `Missed ${ds}${suffix}` };
    } else {
      // FIX 2: fallback — use metric epsAnnual to infer beat vs estimate
      // metric has epsNormalizedAnnual which is TTM EPS; compare to previous
      const epsNow  = m.epsNormalizedAnnual || m.epsBasicExclExtraTTM || 0;
      const epsPrev = m.epsTTM || 0;
      if (epsNow !== 0 && epsPrev !== 0 && epsNow !== epsPrev) {
        const diff = epsNow - epsPrev;
        const beat = diff >= 0;
        const ds   = `${beat ? '+' : ''}$${Math.abs(diff).toFixed(2)}`;
        s1 = { status: beat ? 'pass' : 'fail', value: `EPS ${beat ? 'up' : 'down'} ${ds} YoY (TTM)` };
      } else if (epsNow !== 0) {
        s1 = { status:'neutral', value:`EPS $${epsNow.toFixed(2)} TTM` };
      } else {
        s1 = { status:'neutral', value:'No earnings history' };
      }
    }
  } catch (_) {}

  // ── Signal 2: PE vs historical ────────────────────────────────────────────
  let s2 = { status:'neutral', value:'No PE data' };
  try {
    const pe  = m.peBasicExclExtraTTM || m.peTTM || 0;
    let   eps = m.epsBasicExclExtraTTM || m.epsTTM || m.epsNormalizedAnnual || 0;
    if ((!eps || eps === 0) && pe > 0 && price > 0) eps = price / pe;
    const closes = (chart?.indicators?.quote?.[0]?.close || []).filter(c => c != null && c > 0 && !isNaN(c));
    const hi52 = m['52WeekHigh'] || chart?.meta?.fiftyTwoWeekHigh || (closes.length ? Math.max(...closes) : 0);
    const lo52 = m['52WeekLow']  || chart?.meta?.fiftyTwoWeekLow  || (closes.length ? Math.min(...closes) : 0);

    if (pe !== 0) {
      if (pe < 0) {
        s2 = { status:'fail', value:`Loss-making (EPS $${(eps||0).toFixed(2)})` };
      } else {
        const midPx  = hi52 > 0 && lo52 > 0 ? (hi52 + lo52) / 2 : 0;
        const histPE = midPx > 0 && eps > 0  ? midPx / eps        : 0;
        if (histPE > 1 && histPE < 500) {
          if      (pe < histPE * 0.90) s2 = { status:'pass',    value:`PE ${pe.toFixed(1)}x < hist ~${histPE.toFixed(0)}x` };
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

  // ── Signal 3: Price vs 50d MA — computed from 2y chart closes ────────────
  // FIX 3: range=2y guarantees 500 bars. Never falls to 52w midpoint.
  let s3 = { status:'neutral', value:'No MA data' };
  try {
    const closes = (chart?.indicators?.quote?.[0]?.close || []).filter(c => c != null && c > 0 && !isNaN(c));
    let ma50 = null, maLabel = '50d';

    if (closes.length >= 50) {
      const sl = closes.slice(-50);
      ma50 = sl.reduce((a, b) => a + b, 0) / sl.length;
      maLabel = '50d';
    } else if (closes.length >= 20) {
      const sl = closes.slice(-20);
      ma50 = sl.reduce((a, b) => a + b, 0) / sl.length;
      maLabel = '20d';
    } else if (closes.length >= 5) {
      ma50 = closes.reduce((a, b) => a + b, 0) / closes.length;
      maLabel = `${closes.length}d avg`;
    }

    // Finnhub and Yahoo meta as fallbacks only when chart is empty
    if (!ma50 || ma50 <= 0) {
      ma50     = m['50DayMovingAverage'] || chart?.meta?.fiftyDayAverage || 0;
      maLabel  = '50d';
    }

    if (ma50 && ma50 > 0) {
      const pct = ((price - ma50) / ma50 * 100).toFixed(1);
      s3 = price <= ma50
        ? { status:'pass', value:`$${price.toFixed(2)} ≤ ${maLabel} MA $${ma50.toFixed(2)} (${pct}%)` }
        : { status:'fail', value:`$${price.toFixed(2)} > ${maLabel} MA $${ma50.toFixed(2)} (+${pct}%)` };
    } else {
      s3 = { status:'neutral', value:`Price $${price.toFixed(2)} — MA unavailable` };
    }
  } catch (_) {}

  // ── Signal 4: Insider ─────────────────────────────────────────────────────
  let s4 = { status:'neutral', value:'No insider activity (90d)' };
  try {
    if (insData?.buys?.length > 0) {
      const sh    = insData.buys.reduce((s, t) => s + Math.abs(t._sharesTraded||t.change||0), 0);
      const n     = insData.buys.length;
      const parts = [`${n} buy${n > 1 ? 's' : ''}`];
      const sv    = fmtSh(sh); if (sv) parts.push(sv);
      const ago   = timeAgo(insData.buys[0]?.transactionDate); if (ago) parts.push(ago);
      s4 = { status:'pass', value: parts.join(' · ') };
    } else if (insData?.sells?.length > 0) {
      const sh    = insData.sells.reduce((s, t) => s + Math.abs(t._sharesTraded||t.change||0), 0);
      const n     = insData.sells.length;
      const parts = [`${n} sell${n > 1 ? 's' : ''}, no buys`];
      const sv    = fmtSh(sh); if (sv) parts.push(sv);
      s4 = { status:'fail', value: parts.join(' · ') };
    } else {
      s4 = { status:'neutral', value:'No insider activity (90d)' };
    }
  } catch (_) {}

  // ── Signal 5: Analyst upside — price target % above current price ─────────
  // FIX 4: dual source — Finnhub price-target + Yahoo financialData
  // Shows "Target $X.XX, +Y% upside" always when target exists.
  // 25% threshold = pass (hard requirement, not changed).
  let s5 = { status:'neutral', value:'No analyst coverage' };
  try {
    // Source A: Finnhub /stock/price-target
    let tgtMedian = target?.targetMedian || target?.targetMean || 0;
    let tgtHigh   = target?.targetHigh   || 0;
    let tgtLow    = target?.targetLow    || 0;

    // Source B: Yahoo financialData (separate endpoint, less rate-limited for this module)
    if (!tgtMedian || tgtMedian <= 0) {
      const yfTgt = yhFin?.financialData?.targetMedianPrice?.raw
                 || yhFin?.financialData?.targetMeanPrice?.raw
                 || 0;
      if (yfTgt > 0) {
        tgtMedian = yfTgt;
        tgtHigh   = yhFin?.financialData?.targetHighPrice?.raw  || 0;
        tgtLow    = yhFin?.financialData?.targetLowPrice?.raw   || 0;
      }
    }

    // Source C: Yahoo chart meta (occasionally populated)
    if (!tgtMedian || tgtMedian <= 0) {
      tgtMedian = chart?.meta?.targetMeanPrice || 0;
    }

    if (tgtMedian > 0 && price > 0) {
      const upPct = ((tgtMedian - price) / price * 100);
      const upStr = `${upPct >= 0 ? '+' : ''}${upPct.toFixed(1)}%`;
      const range = tgtLow > 0 && tgtHigh > 0
        ? ` ($${tgtLow.toFixed(0)}–$${tgtHigh.toFixed(0)})`
        : '';
      if (upPct >= 25) {
        s5 = { status:'pass',    value:`Target $${tgtMedian.toFixed(2)}, ${upStr} upside${range}` };
      } else if (upPct >= 0) {
        s5 = { status:'neutral', value:`Target $${tgtMedian.toFixed(2)}, ${upStr} upside${range}` };
      } else {
        s5 = { status:'fail',    value:`Target $${tgtMedian.toFixed(2)}, ${upStr} (downside)${range}` };
      }
    } else {
      // FIX 5: fallback — recommendation ratings with percentage
      const recs   = Array.isArray(rec) ? rec : [];
      const latest = recs[0];
      // Also try Finnhub metric analyticsRating field
      const rating = m.analyticsRatingCurrent || '';
      if (latest) {
        const buy   = (latest.strongBuy||0) + (latest.buy||0);
        const hold  = latest.hold||0;
        const sell  = (latest.sell||0) + (latest.strongSell||0);
        const total = buy + hold + sell;
        if (total > 0) {
          const pct = Math.round(buy / total * 100);
          s5 = {
            status: pct >= 60 ? 'pass' : pct >= 35 ? 'neutral' : 'fail',
            value: `${pct}% analyst buy (${buy}B / ${hold}H / ${sell}S)`,
          };
        } else {
          s5 = { status:'neutral', value: rating ? `Rating: ${rating}` : 'No analyst coverage' };
        }
      } else {
        s5 = { status:'neutral', value: rating ? `Rating: ${rating}` : 'No analyst coverage' };
      }
    }
  } catch (_) {}

  // ── Signal 6: PE vs peers — batch cache + dual API fallback ──────────────
  let s6 = { status:'neutral', value:'No peer data' };
  try {
    const curPE = m.peBasicExclExtraTTM || m.peTTM
      || (price > 0 && (m.epsBasicExclExtraTTM || m.epsTTM) > 0
          ? price / (m.epsBasicExclExtraTTM || m.epsTTM) : 0);
    const peers = PEERS[ticker] || [];

    if (curPE > 0 && curPE < 300 && peers.length > 0) {
      const peerList  = peers.slice(0, 6);
      const cachedPEs = peerList.map(p => batchPECache[p]).filter(pe => pe > 0 && pe < 300);
      const missing   = peerList.filter(p => !(batchPECache[p] > 0 && batchPECache[p] < 300));

      let fetchedPEs = [];
      if (missing.length > 0) {
        async function getPeerPE(peer) {
          const [fhR, yhR] = await Promise.allSettled([
            fh(`/stock/metric?symbol=${peer}&metric=all`, 4000)
              .then(d => { const pe = d?.metric?.peBasicExclExtraTTM || d?.metric?.peTTM || 0; return pe > 0 && pe < 300 ? pe : null; }),
            yhChart(peer, 4000)
              .then(c => { const pe = c?.meta?.trailingPE || 0; return pe > 0 && pe < 300 ? pe : null; }),
          ]);
          return (fhR.status === 'fulfilled' ? fhR.value : null)
              ?? (yhR.status === 'fulfilled' ? yhR.value : null)
              ?? null;
        }
        const fetched = await Promise.allSettled(missing.map(getPeerPE));
        fetchedPEs = fetched.filter(r => r.status === 'fulfilled' && r.value != null).map(r => r.value);
      }

      const allPEs = [...cachedPEs, ...fetchedPEs].sort((a, b) => a - b);

      if (allPEs.length >= 1) {
        const mid    = Math.floor(allPEs.length / 2);
        const median = allPEs.length % 2 === 0 ? (allPEs[mid-1]+allPEs[mid])/2 : allPEs[mid];
        const diff   = ((curPE - median) / median * 100);
        const abs    = Math.abs(diff).toFixed(0);
        if      (diff < -10) s6 = { status:'pass',    value:`${abs}% below peer median ${median.toFixed(1)}x` };
        else if (diff >  10) s6 = { status:'fail',    value:`${abs}% above peer median ${median.toFixed(1)}x` };
        else                  s6 = { status:'neutral', value:`In line with peers, median ${median.toFixed(1)}x` };
      } else {
        s6 = { status:'neutral', value:`PE ${curPE.toFixed(1)}x — peers unavailable` };
      }
    } else if (curPE < 0) {
      s6 = { status:'neutral', value:'Peer PE N/A (loss-making)' };
    } else if (curPE >= 300) {
      s6 = { status:'neutral', value:`PE ${curPE.toFixed(0)}x (peers not comparable)` };
    } else {
      const pe = m.peBasicExclExtraTTM || m.peTTM || 0;
      s6 = { status:'neutral', value: pe > 0 ? `PE ${pe.toFixed(1)}x — no peers mapped` : 'PE unavailable' };
    }
  } catch (_) {}

  // ── Assemble ──────────────────────────────────────────────────────────────
  const signals = [s1, s2, s3, s4, s5, s6];
  const score   = signals.filter(s => s.status === 'pass').length;
  const NAMES   = ['EPS beat','Low PE','Below MA','Insider buys','Analyst upside','Cheap vs peers'];
  const passes  = signals.map((s, i) => s.status==='pass' ? NAMES[i] : null).filter(Boolean);
  const fails   = signals.map((s, i) => s.status==='fail' ? NAMES[i] : null).filter(Boolean);

  let summaryText;
  if      (score >= 5) summaryText = `Strong value candidate — ${score}/6 signals pass. Strengths: ${passes.join(', ')}.`;
  else if (score === 4) summaryText = `Good signals (4/6). Passes: ${passes.join(', ')}.`;
  else if (score === 3) summaryText = `Moderate signals (3/6). Passes: ${passes.join(', ')}.`;
  else if (score > 0)   summaryText = `Weak signals (${score}/6). Fails: ${fails.join(', ')}.`;
  else                  summaryText = fails.length ? `No signals pass. Concerns: ${fails.join(', ')}.` : 'Insufficient signal data.';

  return {
    ticker, company, exchange,
    price:     `$${price.toFixed(2)}`,
    change:    chgPct != null ? `${chgPct > 0 ? '+' : ''}${chgPct.toFixed(2)}%` : null,
    marketCap: mcs,
    score, signals,
    summary:   summaryText,
    rating:    getRating(score),
    updatedAt: new Date().toISOString(),
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error:'POST only' });
  if (!FINNHUB_KEY) return res.status(500).json({ error:'FINNHUB_KEY not configured' });

  const { tickers, universePECache: clientCache } = req.body;
  if (!Array.isArray(tickers)||!tickers.length) return res.status(400).json({ error:'tickers required' });

  const cleaned = [...new Set(tickers.slice(0, 20).map(t => t.toUpperCase().trim()).filter(Boolean))];

  // Pre-fetch all metrics in parallel — builds PE cache and saves time in analyseTicker
  const metricResults = await Promise.allSettled(
    cleaned.map(t => fh(`/stock/metric?symbol=${t}&metric=all`, 6000))
  );

  const batchPECache = { ...(clientCache || {}) };
  metricResults.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value?.metric) {
      const pe = r.value.metric.peBasicExclExtraTTM || r.value.metric.peTTM || 0;
      if (pe > 0 && pe < 300) batchPECache[cleaned[i]] = pe;
    }
  });

  const settled = await Promise.allSettled(
    cleaned.map((t, i) => {
      const preloaded = metricResults[i].status === 'fulfilled' ? metricResults[i].value : null;
      return analyseTicker(t, preloaded, batchPECache);
    })
  );

  const results = {};
  settled.forEach((r, i) => {
    const ticker = cleaned[i];
    if (r.status === 'fulfilled' && r.value) results[ticker] = r.value;
    else results[ticker] = { ticker, error: r.reason?.message || 'Analysis failed' };
  });

  res.setHeader('Cache-Control', 's-maxage=90,stale-while-revalidate=60');
  return res.status(200).json({ results, fetchedAt: new Date().toISOString() });
}
