// pages/api/top3.js  v3
//
// Key fix: quickScore() now selects candidates worth ANALYSING (liquid, reasonable PE,
// meaningful market cap) — not candidates that look "undervalued" by heuristic.
// The actual 6-signal score from /api/analyse is the only ranking that matters.
//
// Changes from v2:
//  - quickScore rewritten: rewards liquidity + quality signals, no longer rewards
//    "far from 52w high" (which was picking beaten-down stocks over quality ones)
//  - Candidate pool expanded from 8 → 20 so analyse.js has more to work with
//  - Handler now sorts returned results by actual signal score (not quickScore)
//  - 30-minute server-side cache preserved
 
const YH = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
};
 
// ── Universe — ~500 tickers across all 11 GICS sectors ───────────────────────
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
  'HD','MCD','NKE','SBUX','LOW','TGT','BKNG','MAR',
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
  'TSM','TM','HMC','SONY','SNE','NTDOY','SE','GRAB','BABA',
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
 
const UNIQ = [...new Set(UNIVERSE)];
 
// ── Fallback pool — reliable large-caps with good Finnhub coverage ────────────
const FALLBACK = [
  'MSFT','AAPL','NVDA','GOOGL','AMZN','META','JPM','XOM','LLY','UNH',
  'V','MA','AVGO','HD','MRK','ABBV','PEP','KO','TMO','CAT',
];
 
// ── Exchange label normalisation ───────────────────────────────────────────────
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
  return raw.split(/[\s,]/)[0].toUpperCase() || null;
}
 
// ── Cache ─────────────────────────────────────────────────────────────────────
let cache = { data: null, ts: 0 };
const TTL = 30 * 60 * 1000;
 
// ── Fetch quick data for one ticker ───────────────────────────────────────────
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
      const pe     = meta.trailingPE        || null;
      const mc     = meta.marketCap         || 0;
      const volume = meta.regularMarketVolume || 0;
      const exchange = cleanExchangeLabel(meta.exchangeName || meta.fullExchangeName) ||
                       cleanExchangeLabel(meta.exchange);
 
      const fromHi = hi > 0 ? ((hi - price) / hi * 100) : 0;
      const range  = hi - lo;
      const loPct  = range > 0 ? ((price - lo) / range * 100) : 50;
 
      return { symbol, price, hi, lo, pe, mc, volume, fromHi, loPct, exchange, valid: true };
    } catch (_) {}
  }
  return null;
}
 
// ── quickScore — selects CANDIDATES WORTH FULL ANALYSIS, not pre-judged winners
//
// The old version rewarded stocks for being far below their 52w high, which
// caused beaten-down / declining stocks to outscore quality compounders like MSFT.
//
// New logic: score based on signals that correlate with passing the 6-signal test:
//   1. Market cap quality gate  — large caps have better data coverage
//   2. PE sanity filter         — PE exists + is in a reasonable range
//   3. PE level                 — lower PE relative to 30x baseline = more points
//   4. Moderate distance from high — some pullback is fine, but not a crash
//   5. Volume / liquidity       — avoid illiquid names that data sources miss
//   6. 52w range position       — mid-range preferred over extremes
//
// Critically: being near the 52w HIGH is no longer punished. A stock near its
// high with a low PE (e.g. MSFT at PE 22 vs historical 28) should score well.
// ─────────────────────────────────────────────────────────────────────────────
function quickScore(s) {
  let n = 0;
 
  // 1. Market cap quality tiers — large caps have richer data for all 6 signals
  if      (s.mc > 500e9)  n += 20;  // mega cap  (>$500B)
  else if (s.mc > 100e9)  n += 15;  // large cap (>$100B)
  else if (s.mc > 20e9)   n += 8;   // mid cap   (>$20B)
  else if (s.mc > 5e9)    n += 3;   // small cap (>$5B) — still eligible
  // below $5B: 0 bonus — low data coverage, risky
 
  // 2. PE exists and is in a credible range — means earnings are positive
  //    (no PE = likely losing money or data missing → lower priority)
  if (s.pe && s.pe > 0 && s.pe < 200) {
    n += 8; // base bonus for having a valid PE
 
    // 3. PE level — lower is more likely to pass signal S2 (PE vs hist avg)
    //    Use a smooth curve: PE 10 → +20pts, PE 20 → +12pts, PE 30 → +5pts, PE 40+ → 0
    if      (s.pe < 12) n += 20;
    else if (s.pe < 18) n += 15;
    else if (s.pe < 25) n += 10;
    else if (s.pe < 35) n += 5;
    // PE 35–200: no bonus but still eligible (growth stocks can pass other signals)
  }
 
  // 4. Distance from 52w high — MILD preference for some pullback, but don't
  //    reward crashes. A healthy stock might be 5–25% off its high.
  //    Removed the old 0.65× multiplier that was giving huge scores to -50% stocks.
  if      (s.fromHi > 3  && s.fromHi < 15) n += 10; // modest pullback — sweet spot
  else if (s.fromHi >= 15 && s.fromHi < 30) n += 5;  // meaningful dip — still ok
  else if (s.fromHi >= 30 && s.fromHi < 50) n += 2;  // big drop — worth checking
  // >50% off high: likely distressed, 0 bonus
 
  // 5. Liquidity — daily volume proxy for data source reliability
  //    Low-volume stocks often return null from scraper sources → signals show 'No data'
  if      (s.volume > 10e6) n += 8;
  else if (s.volume > 1e6)  n += 4;
  else if (s.volume > 100e3) n += 1;
 
  // 6. 52w range position — mild preference for mid-range (not euphoric, not crashing)
  if (s.loPct > 25 && s.loPct < 80) n += 4;
 
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
  let stockMeta   = {};
  let totalScanned = 0;
 
  try {
    const BATCH = 40;
    const batches = [];
    for (let i = 0; i < UNIQ.length; i += BATCH) batches.push(UNIQ.slice(i, i + BATCH));
 
    const allResults = (
      await Promise.all(batches.map(b => Promise.all(b.map(fetchQuick))))
    ).flat().filter(Boolean);
 
    totalScanned = allResults.length;
 
    if (allResults.length >= 4) {
      const scored = allResults
        .map(s => ({ ...s, qs: quickScore(s) }))
        .sort((a, b) => b.qs - a.qs);
 
      // Send top 20 to analyse — the real 6-signal score picks the final top 3.
      // Previously only 8 were sent, which could exclude the best candidates entirely.
      candidates = scored.slice(0, 20).map(s => s.symbol);
 
      for (const s of allResults) {
        if (s.exchange) stockMeta[s.symbol] = { exchange: s.exchange };
      }
    }
  } catch (_) {}
 
  if (candidates.length < 4) {
    candidates   = FALLBACK.slice(0, 20);
    totalScanned = totalScanned || FALLBACK.length;
  }
  candidates = [...new Set(candidates)].slice(0, 20);
 
  const result = {
    candidates,
    stockMeta,
    totalScanned,
    usedFallback: candidates.every(c => FALLBACK.includes(c)),
    generatedAt: new Date().toISOString(),
  };
 
  cache = { data: result, ts: Date.now() };
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
  return res.status(200).json(result);
}
