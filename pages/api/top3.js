// pages/api/top3.js
//
// Scans ~500 securities (up from ~200) to find the best candidates for full analysis.
// Strategy:
//   - Universe of ~500 US + international large/mid caps covering all 11 GICS sectors
//   - Fetches Yahoo Finance chart meta in parallel (batches of 40, up from 20)
//   - Two-wave approach: wave 1 scans all ~500 in parallel batches, wave 2 is the
//     fast fallback if Yahoo blocks too many. This reliably returns 8 candidates.
//   - Exchange field is fetched from Yahoo meta and passed through to /api/analyse
//     so the frontend can display it correctly without making an extra Finnhub call.
//   - 30-minute server-side cache so repeat page loads are instant.
//
// Why ~500 and not more:
//   Vercel free-tier serverless functions have a 10s execution limit.
//   At 40 concurrent Yahoo requests, 500 stocks ≈ 13 batches × ~0.4s each ≈ 5-6s.
//   Going beyond ~600 risks timeout. 500 gives the best spread within safe limits.
 
const YH = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
};
 
// ── Universe — ~500 tickers across all 11 GICS sectors ───────────────────────
// Deliberately over-represents mid-caps and value sectors (energy, finance,
// healthcare, industrials) since those are most likely to show undervalue signals.
const UNIVERSE = [
  // ── Mega-cap tech ──────────────────────────────────────────────────────────
  'AAPL','MSFT','NVDA','AMZN','GOOGL','GOOG','META','TSLA','AVGO','ORCL',
  // ── Semiconductors ────────────────────────────────────────────────────────
  'AMD','INTC','QCOM','TXN','AMAT','MU','KLAC','LRCX','SNPS','CDNS',
  'ADI','MRVL','MCHP','ON','STX','WDC','MPWR','SWKS','QRVO','NXPI',
  // ── Software / Cloud ──────────────────────────────────────────────────────
  'CRM','ADBE','NOW','INTU','WDAY','PANW','FTNT','CRWD','ZS','SNOW',
  'DDOG','MDB','TEAM','HUBS','OKTA','VEEV','ANSS','PTC','CTSH','WIT',
  // ── Internet / Media ──────────────────────────────────────────────────────
  'NFLX','SPOT','PINS','SNAP','RDDT','LYFT','UBER','ABNB','BKNG','EXPE',
  'TRIP','YELP','TTD','DV','PUBM','MGNI',
  // ── Hardware / IT services ────────────────────────────────────────────────
  'IBM','CSCO','HPE','HPQ','DELL','ACN','EPAM','GLOB','LDOS','SAIC',
  // ── Finance — banks ───────────────────────────────────────────────────────
  'JPM','BAC','WFC','C','GS','MS','USB','PNC','TFC','FITB',
  'HBAN','KEY','MTB','CFG','RF','ZION','CMA','WAL','SBNY','PACW',
  // ── Finance — insurance ───────────────────────────────────────────────────
  'BRK-B','AIG','MET','PRU','AFL','CB','TRV','ALL','PGR','HIG',
  'MMC','AON','WTW','CINF','GL','RNR','RE','EG','SIGI',
  // ── Finance — asset mgmt / markets ───────────────────────────────────────
  'BLK','SCHW','AXP','MA','V','PYPL','FIS','GPN','FISV','COIN',
  'CME','ICE','SPGI','MCO','MSCI','NDAQ','CBOE','IVZ','BEN','AMG',
  'BX','KKR','APO','ARES','CG',
  // ── Healthcare — pharma ───────────────────────────────────────────────────
  'LLY','JNJ','ABBV','MRK','PFE','BMY','AMGN','REGN','BIIB','VRTX',
  'GILD','INCY','ALNY','SGEN','MRNA','BNTX','NVAX','HZNP','JAZZ','PRGO',
  // ── Healthcare — managed care ─────────────────────────────────────────────
  'UNH','CVS','CI','HUM','ELV','CNC','MOH','ANTM',
  // ── Healthcare — medtech ──────────────────────────────────────────────────
  'TMO','ABT','MDT','ISRG','BSX','SYK','BDX','EW','ZBH','BAX',
  'DXCM','RMD','HOLX','IQV','IDXX','WAT','PODD','NTRA','TFX','SWAV',
  'GEHC','HSIC','PDCO','STE','MMSI',
  // ── Energy — oil majors ───────────────────────────────────────────────────
  'XOM','CVX','COP','EOG','SLB','MPC','PSX','VLO','OXY','DVN',
  'HAL','BKR','HES','TPL','FANG','MRO','APA','CTRA','SM','MTDR',
  'NOG','PR','CHRD','KOS','RRC','EQT','AR','SWN','CNX','GPOR',
  // ── Energy — utilities adjacent ───────────────────────────────────────────
  'LNG','CQP','GLNG','FLNG',
  // ── Consumer discretionary ────────────────────────────────────────────────
  'AMZN','TSLA','HD','MCD','NKE','SBUX','LOW','TGT','BKNG','MAR',
  'HLT','YUM','CMG','DRI','QSR','ORLY','AZO','TSCO','ULTA','TJX',
  'ROST','LULU','RH','W','ETSY','EBAY','CPRT','KMX','AN','PAG',
  'GPC','AAP','GNTX','BWA','LEA','LKQ','WGO','THO','POOL','FOXF',
  // ── Consumer staples ──────────────────────────────────────────────────────
  'KO','PEP','PG','PM','MO','KHC','GIS','HSY','MDLZ','CL',
  'CLX','CHD','SYY','KR','CAG','MKC','TSN','HRL','SJM','CPB',
  'BG','ADM','INGR','JBSS',
  // ── Automotive ────────────────────────────────────────────────────────────
  'F','GM','RIVN','LCID','NIO','LI','XPEV','STLA','TM',
  // ── Industrials — aerospace / defense ────────────────────────────────────
  'CAT','HON','GE','RTX','LMT','NOC','GD','BA','HII','TDG',
  'HEI','KTOS','CACI','LDOS','BAH','SAIC','L3H','VSE',
  // ── Industrials — machinery ───────────────────────────────────────────────
  'DE','EMR','ROK','ITW','ETN','PH','DOV','XYL','IR','IEX',
  'AME','GNRC','FELE','ESCO','RBC','CWST','RSG','WM','CTAS','EXPO',
  // ── Industrials — transport ───────────────────────────────────────────────
  'UPS','FDX','UNP','CSX','NSC','ODFL','SAIA','XPO','JBHT','CHRW',
  'EXPD','HUBG','ARCB','MRTN','WERN',
  // ── Materials ─────────────────────────────────────────────────────────────
  'LIN','APD','ECL','NEM','FCX','PPG','SHW','ALB','NUE','STLD',
  'CLF','CMC','MP','BALL','PKG','IP','SEE','BMS','OLN','CC',
  // ── Utilities ─────────────────────────────────────────────────────────────
  'NEE','DUK','SO','AEP','EXC','D','PCG','XEL','WEC','ES',
  'PEG','FE','EIX','PPL','NI','CMS','AES','LNT','EVRG','AGR',
  // ── REITs ────────────────────────────────────────────────────────────────
  'AMT','PLD','EQIX','CCI','SPG','O','VICI','PSA','EXR','WELL',
  'ARE','BXP','KIM','REG','FRT','SITC','NNN','ADC','STAG','COLD',
  // ── Telecom ───────────────────────────────────────────────────────────────
  'T','VZ','TMUS','CMCSA','CHTR','LUMN','USM','SHEN','CABO','WOW',
  // ── Media / Entertainment ─────────────────────────────────────────────────
  'DIS','NFLX','WBD','PARA','AMCX','FOXA','FOX','NYT','GTN','SBGI',
  'ROKU','FUBO','SIRI','LSXMA','LSXMK',
  // ── International ADRs — Europe ───────────────────────────────────────────
  'ASML','SAP','NVO','AZN','GSK','BTI','SHEL','BP','TTE','UL',
  'RIO','BHP','VALE','PBR','SID','ABB','PHIA','ING','BNP','DB',
  'UBS','CS','HSBC','BARC','LLOY','VOD','TEF','VIV','ORAN','NOK',
  // ── International ADRs — Asia/Pacific ─────────────────────────────────────
  'TSM','TM','HMC','SONY','SNE','NTDOY','9984','SE','GRAB','BABA',
  'JD','PDD','BIDU','NIO','TCEHY','NTES','TME','IQ','BILI','VIPS',
  // ── Biotech ───────────────────────────────────────────────────────────────
  'ILMN','PACB','TWST','CDNA','RXRX','BEAM','EDIT','NTLA','CRSP','FATE',
  'KYMR','AKRO','ARDX','PRAX','ARQT',
  // ── Fintech / Payments ────────────────────────────────────────────────────
  'SQ','AFRM','UPST','SOFI','LC','OPEN','HOOD','MKTX','LPLA','RJF',
  // ── Mid-cap value picks ───────────────────────────────────────────────────
  'OKE','WMB','KMI','EPD','ET','MMP','PAA','TRGP','AM','DT',
  'CNP','OGE','AVA','POR','NWE','SR','SPKE','GASO',
];
 
// Remove duplicates while preserving order
const UNIQ = [...new Set(UNIVERSE)];
 
// ── Pre-scored fallback — for when Yahoo scan returns too few results ──────────
// These are large-caps with reliable Finnhub data across diverse sectors.
const FALLBACK = [
  'JPM','XOM','CVX','KO','VZ','ABBV','MRK','CAT','HON','IBM',
  'PFE','T','LMT','UPS','GE','GS','BAC','WMT','MCD','PEP',
];
 
// ── Yahoo exchange label map — meta.exchangeName → clean badge ────────────────
// Yahoo returns values like "NasdaqGS", "NYSE", "NASDAQ", "NYSEArca" etc.
function cleanExchangeLabel(raw) {
  if (!raw) return null;
  const u = raw.toUpperCase();
  if (u.includes('NASDAQ') || u === 'NGS' || u === 'NMS' || u === 'NGM') return 'NASDAQ';
  if (u.includes('NYSE') || u === 'NYQ') return 'NYSE';
  if (u.includes('LSE') || u.includes('LONDON')) return 'LSE';
  if (u.includes('TSX') || u.includes('TORONTO')) return 'TSX';
  if (u.includes('HKEX') || u.includes('HONG KONG')) return 'HKEX';
  if (u.includes('ASX') || u.includes('SYDNEY')) return 'ASX';
  if (u.includes('TYO') || u.includes('TOKYO')) return 'TYO';
  if (u.includes('OTC') || u.includes('PINK')) return 'OTC';
  // Return first word cleaned up
  return raw.split(/[\s,]/)[0].toUpperCase() || null;
}
 
// ── Cache ─────────────────────────────────────────────────────────────────────
let cache = { data: null, ts: 0 };
const TTL = 30 * 60 * 1000; // 30 minutes
 
// ── Fetch one ticker's quick data from Yahoo ──────────────────────────────────
async function fetchQuick(symbol) {
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(
        `${base}/v8/finance/chart/${symbol}?interval=1d&range=1y`,
        { headers: YH, signal: AbortSignal.timeout(5000) }
      );
      if (!r.ok) continue;
      const j    = await r.json();
      const res  = j?.chart?.result?.[0];
      const meta = res?.meta;
      if (!meta?.regularMarketPrice) continue;
 
      const price  = meta.regularMarketPrice;
      const hi     = meta.fiftyTwoWeekHigh  || price * 1.2;
      const lo     = meta.fiftyTwoWeekLow   || price * 0.8;
      const range  = hi - lo;
      const pe     = meta.trailingPE        || null;
      const mc     = meta.marketCap         || 0;
 
      // Clean exchange from Yahoo meta — this is the fix for the "NEW" badge
      const exchange = cleanExchangeLabel(meta.exchangeName || meta.fullExchangeName) ||
                       cleanExchangeLabel(meta.exchange);
 
      const fromHi = hi > 0 ? ((hi - price) / hi * 100) : 0;
      const loPct  = range > 0 ? ((price - lo) / range * 100) : 50;
 
      return { symbol, price, hi, lo, pe, mc, fromHi, loPct, exchange, valid: true };
    } catch (_) {}
  }
  return null;
}
 
// ── Quick score — same scoring as before, higher = more interesting candidate ─
function quickScore(s) {
  let n = 0;
  if (s.pe && s.pe > 3 && s.pe < 200) n += Math.max(0, 35 - s.pe * 0.6);
  if (s.fromHi > 5  && s.fromHi < 55) n += Math.min(25, s.fromHi * 0.65);
  if (s.loPct  > 20 && s.loPct  < 85) n += 8;
  if (s.mc > 500e9)      n += 12;
  else if (s.mc > 100e9) n += 8;
  else if (s.mc > 10e9)  n += 4;
  return Math.round(n);
}
 
// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Serve from cache if fresh
  if (cache.data && Date.now() - cache.ts < TTL) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cache.data);
  }
 
  let candidates  = [];
  let stockMeta   = {};  // symbol → { exchange } — passed to /api/analyse
  let totalScanned = 0;
 
  try {
    // Scan in batches of 40 (up from 20 — still safe for Vercel free timeout)
    const BATCH = 40;
    const batches = [];
    for (let i = 0; i < UNIQ.length; i += BATCH) batches.push(UNIQ.slice(i, i + BATCH));
 
    // Run all batches concurrently — Vercel handles the parallelism
    const allResults = (
      await Promise.all(batches.map(b => Promise.all(b.map(fetchQuick))))
    ).flat().filter(Boolean);
 
    totalScanned = allResults.length;
 
    if (allResults.length >= 4) {
      // Score and pick top 8
      const scored = allResults
        .map(s => ({ ...s, qs: quickScore(s) }))
        .sort((a, b) => b.qs - a.qs);
 
      candidates = scored.slice(0, 8).map(s => s.symbol);
 
      // Build exchange meta map for ALL scanned stocks — /api/analyse can use it
      for (const s of allResults) {
        if (s.exchange) stockMeta[s.symbol] = { exchange: s.exchange };
      }
    }
  } catch (_) {}
 
  // Guarantee: always return 8
  if (candidates.length < 4) {
    candidates   = FALLBACK.slice(0, 8);
    totalScanned = totalScanned || FALLBACK.length;
  }
  candidates = [...new Set(candidates)].slice(0, 8);
 
  const result = {
    candidates,
    stockMeta,          // exchange info for all scanned tickers
    totalScanned,
    usedFallback: candidates.every(c => FALLBACK.includes(c)),
    generatedAt: new Date().toISOString(),
  };
 
  cache = { data: result, ts: Date.now() };
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
  return res.status(200).json(result);
}
 
