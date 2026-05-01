// pages/api/top3.js  v6
//
// PROGRESSIVE BATCH SCANNING — instant results, no timeout
//
// The universe is split into named batches ordered by priority:
//   Batch 1 — ~150 megacaps (returned immediately to frontend)
//   Batch 2-N — remaining sectors in groups of ~150
//
// The API accepts ?batch=0,1,2... to fetch specific batches.
// The frontend calls batch=0 first (megacaps), renders top picks,
// then fires batch=1,2,3... in the background, promoting better stocks
// as they come in.
//
// Each batch scans quickly in parallel (150 tickers × Yahoo = ~3-4s).
// No Vercel timeout issues — each batch is its own fast request.

const YH = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
};

// ── Universe split into priority batches ─────────────────────────────────────
// Batch 0: Megacap / high-liquidity — scanned first, results shown instantly
// Batch 1+: Remaining sectors scanned in background
const BATCHES = [
  // Batch 0 — Megacap + large-cap across key sectors (~160 tickers)
  [
    // Mega tech
    'AAPL','MSFT','NVDA','AMZN','GOOGL','GOOG','META','TSLA','AVGO','ORCL',
    // Large semis
    'AMD','INTC','QCOM','TXN','AMAT','MU','KLAC','LRCX','ADI','MRVL',
    // Large software
    'CRM','ADBE','NOW','INTU','PANW','FTNT','CRWD','DDOG','WDAY','SNOW',
    // Large finance
    'JPM','BAC','WFC','C','GS','MS','BLK','AXP','MA','V',
    'SCHW','USB','PNC','CME','SPGI','MCO',
    // Large healthcare
    'LLY','JNJ','UNH','ABBV','MRK','PFE','TMO','ABT','AMGN','CVS',
    'MDT','ISRG','GILD','REGN','VRTX','BSX','SYK','ELV',
    // Large energy
    'XOM','CVX','COP','EOG','SLB','MPC','PSX','VLO','OXY','DVN',
    // Large consumer
    'HD','MCD','NKE','SBUX','LOW','TGT','WMT','COST','AMZN','BKNG',
    'TJX','ROST','LULU','CMG','YUM',
    // Large industrials
    'CAT','HON','GE','RTX','LMT','NOC','DE','UPS','FDX','UNP',
    // Large utilities / REIT
    'NEE','DUK','AMT','PLD','EQIX',
    // Large staples / telecom
    'KO','PEP','PM','MO','T','VZ','TMUS','CMCSA','NFLX','DIS',
    // International megacap ADRs
    'TSM','ASML','NVO','SAP','TM','SHEL','BHP','AZN','HSBC','SONY',
    'BABA','SE','NIO','VALE','PBR',
  ],

  // Batch 1 — Mid-large tech + fintech + biotech
  [
    'MCHP','ON','STX','WDC','MPWR','NXPI','SNPS','CDNS','ANSS','PTC',
    'IBM','CSCO','HPE','DELL','ACN','JNPR','NET','NTAP','PSTG',
    'PYPL','FIS','GPN','FISV','COIN','ICE','NDAQ','CBOE','BX','KKR',
    'APO','ARES','CG','IVZ','BEN','SCHW',
    'BIIB','ILMN','MRNA','BNTX','INCY','ALNY','JAZZ','REGN',
    'AMGN','VRTX','GILD','BMY','ABBV','HZNP',
    'CI','HUM','MOH','CNC','OSCR',
    'TMO','DHR','IQV','IDXX','WAT','BDX','EW','ZBH','BAX',
    'DXCM','RMD','HOLX','PODD','NTRA','ISRG','GEHC',
    'SPOT','PINS','SNAP','RDDT','LYFT','UBER','ABNB','EXPE','BKNG',
    'TTD','ROKU','NFLX','WBD','PARA','DIS',
  ],

  // Batch 2 — Energy midstream + materials + more industrials
  [
    'HAL','BKR','HES','TPL','MRO','APA','CTRA','SM','MTDR',
    'LNG','OKE','WMB','KMI','EPD','ET','TRGP',
    'NEM','FCX','LIN','APD','ECL','PPG','SHW','ALB','NUE','STLD',
    'CLF','CMC','BALL','PKG','IP','OLN','EMN',
    'EMR','ROK','ITW','ETN','PH','DOV','XYL','IR','AME',
    'GFF','HUBB','FAST','GWW','MSC','CTAS','VRSK',
    'HOG','PII','LCII','POOL','FOXF',
    'UNP','CSX','NSC','ODFL','SAIA','XPO','JBHT','CHRW',
    'DAL','UAL','LUV','AAL','ALK',
    'RSG','WM','CWST','URI','R',
    'LMT','NOC','GD','BA','HII','TDG','HEI','KTOS','AXON',
  ],

  // Batch 3 — Consumer + REITs + small/mid value
  [
    'ORLY','AZO','TSCO','ULTA','RH','W','ETSY','EBAY','CPRT','KMX',
    'BOOT','ANF','AEO','FL','WING','JACK','TXRH','BJRI','EAT','CMG',
    'MAR','HLT','DRI','QSR','MCD',
    'F','GM','RIVN','LCID','STLA',
    'KHC','GIS','HSY','MDLZ','CL','CLX','CHD','SYY','KR','CAG',
    'TSN','HRL','ADM','MNST','CELH',
    'NEE','DUK','SO','AEP','EXC','D','PCG','XEL','WEC','PEG',
    'AMT','PLD','EQIX','CCI','SPG','O','VICI','PSA','EXR','WELL',
    'EQR','AVB','ESS','MAA','UDR',
    'T','VZ','TMUS','CMCSA','CHTR','SHEN',
    'DCOM','CVBF','FFIN','WSFS','TOWN','INDB','LKFN','PPBI',
    'NKE','UAA','DECK','LULU','SKX',
  ],

  // Batch 4 — International ADRs + small-cap growth
  [
    'BIDU','JD','PDD','TCEHY','NTES','TME','BILI','VIPS','YUMC',
    'ACH','CHU','MFC','SLF','TD','RY','BMO','BNS','CM','ENB','CNQ',
    'RIO','UL','GSK','BTI','TEF','VIV','ORAN','NOK','ERIC',
    'PHIA','ING','BNP','DB','UBS','BARC','LLOY','VOD',
    'ABB','STM','AIXA','LONN',
    'ENPH','SEDG','FSLR','CSIQ','ARRY','RUN','NOVA',
    'PLUG','FCEL','BE','CLNE',
    'WPM','AEM','NEM','FCX','GOLD','CCJ','KGC','KL',
    'ACMR','BAND','BMBL','CALX','CELH','CHCO','CCOI',
    'MKTX','LPLA','RJF','IBKR','VIRT','PIPR',
    'AFRM','UPST','SOFI','LC','HOOD','SQ',
  ],
];

const TOTAL_UNIVERSE = BATCHES.flat().length;

const FALLBACK = [
  'MSFT','AAPL','NVDA','GOOGL','AMZN','META','JPM','XOM','LLY','UNH',
  'V','MA','AVGO','HD','MRK','ABBV','PEP','KO','TMO','CAT',
];

function cleanExchangeLabel(raw) {
  if (!raw) return null;
  const u = raw.toUpperCase();
  if (u.includes('NASDAQ') || u==='NGS'||u==='NMS'||u==='NGM') return 'NASDAQ';
  if (u.includes('NYSE') || u==='NYQ') return 'NYSE';
  if (u.includes('LSE') || u.includes('LONDON')) return 'LSE';
  if (u.includes('TSX') || u.includes('TORONTO')) return 'TSX';
  if (u.includes('OTC') || u.includes('PINK')) return 'OTC';
  return raw.split(/[\s,]/)[0].toUpperCase() || null;
}

// 30-minute cache per batch
const batchCache = {};
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

      const price    = meta.regularMarketPrice;
      const hi       = meta.fiftyTwoWeekHigh  || price * 1.2;
      const lo       = meta.fiftyTwoWeekLow   || price * 0.8;
      const pe       = meta.trailingPE || null;
      const mc       = meta.marketCap  || 0;
      const volume   = meta.regularMarketVolume || 0;
      const exchange = cleanExchangeLabel(meta.exchangeName || meta.fullExchangeName) || cleanExchangeLabel(meta.exchange);
      const fromHi   = hi > 0 ? ((hi - price) / hi * 100) : 0;
      const range    = hi - lo;
      const loPct    = range > 0 ? ((price - lo) / range * 100) : 50;

      return { symbol, price, hi, lo, pe, mc, volume, fromHi, loPct, exchange, valid: true };
    } catch (_) {}
  }
  return null;
}

function quickScore(s) {
  let n = 0;
  if      (s.mc > 500e9)  n += 20;
  else if (s.mc > 100e9)  n += 15;
  else if (s.mc > 20e9)   n += 8;
  else if (s.mc > 5e9)    n += 3;

  if (s.pe && s.pe > 0 && s.pe < 80) {
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

async function scanBatch(batchIndex) {
  // Serve from cache if fresh
  const cached = batchCache[batchIndex];
  if (cached && Date.now() - cached.ts < TTL) return cached.data;

  const tickers = BATCHES[batchIndex] || [];
  if (!tickers.length) return { scored: [], stockMeta: {} };

  // Fetch all in parallel — each batch is ~150 tickers, completes in ~3-4s
  const results = await Promise.allSettled(tickers.map(fetchQuick));
  const valid = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  const scored = valid
    .map(s => ({ ...s, qs: quickScore(s) }))
    .sort((a, b) => b.qs - a.qs);

  const stockMeta = {};
  for (const s of valid) {
    if (s.exchange) stockMeta[s.symbol] = { exchange: s.exchange };
  }

  const data = { scored, stockMeta, scanned: valid.length, total: tickers.length };
  batchCache[batchIndex] = { data, ts: Date.now() };
  return data;
}

export default async function handler(req, res) {
  // ?batch=0 (default) or ?batch=1,2,3
  const batchParam = req.query?.batch ?? '0';
  const batchIndices = String(batchParam).split(',').map(Number).filter(n => !isNaN(n) && n >= 0 && n < BATCHES.length);
  if (!batchIndices.length) batchIndices.push(0);

  // Force refresh bypasses cache
  const forceRefresh = req.query?.refresh === '1';
  if (forceRefresh) batchIndices.forEach(i => delete batchCache[i]);

  // Run requested batches (usually just one at a time)
  const batchResults = await Promise.allSettled(batchIndices.map(i => scanBatch(i)));

  let allScored = [];
  let stockMeta = {};
  let totalScanned = 0;

  for (const r of batchResults) {
    if (r.status === 'fulfilled') {
      allScored = allScored.concat(r.value.scored);
      Object.assign(stockMeta, r.value.stockMeta);
      totalScanned += r.value.scanned;
    }
  }

  // Sort combined results and pick top candidates for full analysis
  allScored.sort((a, b) => b.qs - a.qs);

  let candidates = allScored.slice(0, 20).map(s => s.symbol);
  if (candidates.length < 4) candidates = FALLBACK.slice(0, 20);
  candidates = [...new Set(candidates)].slice(0, 20);

  // Return top 50 scored for the frontend's incremental pool comparison
  const top50 = allScored.slice(0, 50).map(s => ({
    symbol: s.symbol, qs: s.qs, price: s.price, pe: s.pe, mc: s.mc, exchange: s.exchange,
  }));

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=60');
  return res.status(200).json({
    candidates,
    stockMeta,
    allScored: top50,
    totalScanned,
    totalBatches: BATCHES.length,
    totalUniverse: TOTAL_UNIVERSE,
    batchIndex: batchIndices[0],
    generatedAt: new Date().toISOString(),
  });
}
