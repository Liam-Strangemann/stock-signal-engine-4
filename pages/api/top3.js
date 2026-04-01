// pages/api/top3.js  v5
//
// Back to simple JSON GET — SSE was unreliable with Next.js.
// Progressive updates are handled entirely on the client side.
//
// This endpoint does one thing: quickly score the full universe via Yahoo
// and return the top-20 candidates for deep analysis, plus the total count.
// 30-min server cache so repeat page loads are instant.
//
// Universe: ~720 tickers. All batched in parallel (40 at a time) so the
// full scan completes in ~3-5s regardless of universe size.
 
const YH = {
  'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':'application/json, text/plain, */*','Accept-Language':'en-US,en;q=0.9',
  'Origin':'https://finance.yahoo.com','Referer':'https://finance.yahoo.com/',
};
 
const UNIVERSE = [
  // Mega-cap tech
  'AAPL','MSFT','NVDA','AMZN','GOOGL','GOOG','META','TSLA','AVGO','ORCL',
  // Semiconductors
  'AMD','INTC','QCOM','TXN','AMAT','MU','KLAC','LRCX','SNPS','CDNS',
  'ADI','MRVL','MCHP','ON','STX','WDC','MPWR','SWKS','QRVO','NXPI',
  'WOLF','COHR','AMBA','POWI','DIOD','MTSI','FORM','AOSL',
  // Software / Cloud
  'CRM','ADBE','NOW','INTU','WDAY','PANW','FTNT','CRWD','ZS','SNOW',
  'DDOG','MDB','TEAM','HUBS','OKTA','VEEV','ANSS','PTC','CTSH','WIT',
  'SPLK','GTLB','U','RBLX','COIN','APP','PLTR','DOCN','PCTY','PAYC',
  // Internet / Media
  'NFLX','SPOT','PINS','SNAP','RDDT','LYFT','UBER','ABNB','BKNG','EXPE',
  'TRIP','YELP','TTD','DV','PUBM','MGNI','IAC','ZG','MTCH','BMBL',
  // Hardware / IT services
  'IBM','CSCO','HPE','HPQ','DELL','ACN','EPAM','GLOB','LDOS','SAIC',
  'NTAP','PSTG','SMCI','FLEX','JNPR','VIAV','CIEN','COHU',
  // Finance — banks
  'JPM','BAC','WFC','C','GS','MS','USB','PNC','TFC','FITB',
  'HBAN','KEY','MTB','CFG','RF','ZION','CMA','WAL','EWBC','BOKF',
  'GBCI','UMBF','WTFC','FFIN','BANR','CADE',
  // Finance — insurance
  'BRK-B','AIG','MET','PRU','AFL','CB','TRV','ALL','PGR','HIG',
  'MMC','AON','WTW','CINF','GL','RNR','RE','EG','KMPR',
  // Finance — asset mgmt / markets / fintech
  'BLK','SCHW','AXP','MA','V','PYPL','FIS','GPN','FISV','SQ',
  'CME','ICE','SPGI','MCO','MSCI','NDAQ','CBOE','IVZ','BEN','AMG',
  'BX','KKR','APO','ARES','CG','AFRM','UPST','SOFI','HOOD','MKTX',
  'LPLA','RJF',
  // Healthcare — pharma / biotech
  'LLY','JNJ','ABBV','MRK','PFE','BMY','AMGN','REGN','BIIB','VRTX',
  'GILD','INCY','ALNY','MRNA','BNTX','JAZZ','PRGO',
  'RXRX','BEAM','EDIT','NTLA','CRSP','KYMR','AKRO','ARDX',
  'ARQT','BLUE','SAGE','ARWR','IONS','SRPT','BMRN',
  // Healthcare — managed care
  'UNH','CVS','CI','HUM','ELV','CNC','MOH',
  // Healthcare — medtech / services
  'TMO','ABT','MDT','ISRG','BSX','SYK','BDX','EW','ZBH','BAX',
  'DXCM','RMD','HOLX','IQV','IDXX','WAT','PODD','NTRA','TFX',
  'GEHC','HSIC','STE','MMSI','ALGN',
  // Energy — oil / gas
  'XOM','CVX','COP','EOG','SLB','MPC','PSX','VLO','OXY','DVN',
  'HAL','BKR','HES','TPL','FANG','MRO','APA','CTRA','SM','MTDR',
  'NOG','PR','CHRD','RRC','EQT','AR','SWN','CNX',
  'DINO','PBF',
  // Energy — midstream
  'LNG','CQP','OKE','WMB','KMI','EPD','ET','TRGP','AM','MPLX',
  // Consumer discretionary
  'HD','MCD','NKE','SBUX','LOW','TGT','BKNG','MAR','HLT','YUM',
  'CMG','DRI','QSR','ORLY','AZO','TSCO','ULTA','TJX','ROST','LULU',
  'RH','ETSY','EBAY','CPRT','KMX','AN','GPC','AAP',
  'GNTX','BWA','LKQ','POOL',
  'DPZ','WEN','TXRH','CBRL',
  // Consumer staples
  'KO','PEP','PG','PM','MO','KHC','GIS','HSY','MDLZ','CL',
  'CLX','CHD','SYY','KR','CAG','MKC','TSN','HRL','SJM','CPB',
  'BG','ADM','INGR','LANC','THS','FRPT',
  // Automotive
  'F','GM','RIVN','LCID','NIO','LI','XPEV','STLA','TM','HMC',
  'APTV','MGA','GT','ALSN',
  // Industrials — aerospace / defense
  'CAT','HON','GE','RTX','LMT','NOC','GD','BA','HII','TDG',
  'HEI','KTOS','CACI','BAH','SAIC','LDOS',
  // Industrials — machinery
  'DE','EMR','ROK','ITW','ETN','PH','DOV','XYL','IR','IEX',
  'AME','GNRC','FELE','ESCO','RSG','WM','CTAS','EXPO',
  'TTC','LBRT','HP','PTEN',
  // Industrials — transport
  'UPS','FDX','UNP','CSX','NSC','ODFL','SAIA','XPO','JBHT','CHRW',
  'EXPD','HUBG','ARCB','WERN',
  // Materials
  'LIN','APD','ECL','NEM','FCX','PPG','SHW','ALB','NUE','STLD',
  'CLF','CMC','MP','BALL','PKG','IP','SEE','BMS','OLN','CC',
  'ATI','TREX','AZEK','DOOR',
  // Utilities
  'NEE','DUK','SO','AEP','EXC','D','PCG','XEL','WEC','ES',
  'PEG','FE','EIX','PPL','NI','CMS','AES','LNT','EVRG',
  'NRG','BEP','CWEN',
  // REITs
  'AMT','PLD','EQIX','CCI','SPG','O','VICI','PSA','EXR','WELL',
  'ARE','BXP','KIM','REG','FRT','NNN','ADC','STAG','COLD',
  'IIPR','GLPI','SBAC','AMH','INVH','REXR','FR',
  // Telecom
  'T','VZ','TMUS','CMCSA','CHTR','LUMN','USM','CABO',
  // Media / Entertainment
  'DIS','NFLX','WBD','PARA','FOXA','FOX','NYT',
  'ROKU','SIRI','IMAX','CNK',
  // International ADRs — Europe
  'ASML','SAP','NVO','AZN','GSK','BTI','SHEL','BP','TTE','UL',
  'RIO','BHP','VALE','PBR','ABB','ING','DB',
  'UBS','HSBC','VOD','TEF','ORAN','NOK','ERIC',
  'SHOP','CP','CNI','SU','ENB','TRP','BCE','TD','BNS','RY',
  // International ADRs — Asia
  'TSM','TM','HMC','SONY','NTDOY','SE','GRAB','BABA',
  'JD','PDD','BIDU','TCEHY','NTES','TME','BILI',
];
 
const UNIQ = [...new Set(UNIVERSE)];
 
const FALLBACK = [
  'MSFT','AAPL','NVDA','GOOGL','AMZN','META','JPM','XOM','LLY','UNH',
  'V','MA','AVGO','HD','MRK','ABBV','PEP','KO','TMO','CAT',
];
 
function cleanExchangeLabel(raw) {
  if (!raw) return null;
  const u = raw.toUpperCase();
  if (u.includes('NASDAQ') || u === 'NGS' || u === 'NMS' || u === 'NGM') return 'NASDAQ';
  if (u.includes('NYSE') || u === 'NYQ') return 'NYSE';
  if (u.includes('LSE') || u.includes('LONDON')) return 'LSE';
  if (u.includes('TSX') || u.includes('TORONTO')) return 'TSX';
  if (u.includes('HKEX') || u.includes('HONG KONG')) return 'HKEX';
  if (u.includes('OTC') || u.includes('PINK')) return 'OTC';
  return raw.split(/[\s,]/)[0].toUpperCase() || null;
}
 
// Simple 30-min server-side cache
let cache = { data: null, ts: 0 };
const TTL = 30 * 60 * 1000;
 
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
      const exchange = cleanExchangeLabel(meta.exchangeName || meta.fullExchangeName)
                    || cleanExchangeLabel(meta.exchange);
      const fromHi = hi > 0 ? ((hi - price) / hi * 100) : 0;
      const range  = hi - lo;
      const loPct  = range > 0 ? ((price - lo) / range * 100) : 50;
      return { symbol, price, hi, lo, pe, mc, volume, fromHi, loPct, exchange, valid: true };
    } catch (_) {}
  }
  return null;
}
 
function quickScore(s) {
  let n = 0;
  if      (s.mc > 500e9) n += 20;
  else if (s.mc > 100e9) n += 15;
  else if (s.mc > 20e9)  n += 8;
  else if (s.mc > 5e9)   n += 3;
 
  if (s.pe && s.pe > 0 && s.pe < 200) {
    n += 8;
    if      (s.pe < 12) n += 20;
    else if (s.pe < 18) n += 15;
    else if (s.pe < 25) n += 10;
    else if (s.pe < 35) n += 5;
  }
 
  if      (s.fromHi > 3  && s.fromHi < 15) n += 10;
  else if (s.fromHi >= 15 && s.fromHi < 30) n += 5;
  else if (s.fromHi >= 30 && s.fromHi < 50) n += 2;
 
  if      (s.volume > 10e6)  n += 8;
  else if (s.volume > 1e6)   n += 4;
  else if (s.volume > 100e3) n += 1;
 
  if (s.loPct > 25 && s.loPct < 80) n += 4;
  return Math.round(n);
}
 
export default async function handler(req, res) {
  // Serve from cache if fresh
  if (cache.data && Date.now() - cache.ts < TTL) {
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json(cache.data);
  }
 
  let candidates  = [];
  let stockMeta   = {};
  let totalScanned = 0;
 
  try {
    // Run all batches fully in parallel — each batch is 40 tickers
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
    totalUniverse: UNIQ.length,
    usedFallback: candidates.every(c => FALLBACK.includes(c)),
    generatedAt: new Date().toISOString(),
  };
 
  cache = { data: result, ts: Date.now() };
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
  return res.status(200).json(result);
}
 
