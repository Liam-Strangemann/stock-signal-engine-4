// pages/api/top3.js  v6 — progressive batch scanning
// Batch 0 (megacaps) returned instantly, batches 1-4 fill in background.

const YH = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
};

const BATCHES = [
  // Batch 0 — Megacap + large-cap (~160 tickers) — loaded first
  [
    'AAPL','MSFT','NVDA','AMZN','GOOGL','GOOG','META','TSLA','AVGO','ORCL',
    'AMD','INTC','QCOM','TXN','AMAT','MU','KLAC','LRCX','ADI','MRVL',
    'CRM','ADBE','NOW','INTU','PANW','FTNT','CRWD','DDOG','WDAY','SNOW',
    'JPM','BAC','WFC','C','GS','MS','BLK','AXP','MA','V',
    'SCHW','USB','PNC','CME','SPGI','MCO',
    'LLY','JNJ','UNH','ABBV','MRK','PFE','TMO','ABT','AMGN','CVS',
    'MDT','ISRG','GILD','REGN','VRTX','BSX','SYK','ELV',
    'XOM','CVX','COP','EOG','SLB','MPC','PSX','VLO','OXY','DVN',
    'HD','MCD','NKE','SBUX','LOW','TGT','WMT','COST','BKNG',
    'TJX','ROST','LULU','CMG','YUM',
    'CAT','HON','GE','RTX','LMT','NOC','DE','UPS','FDX','UNP',
    'NEE','DUK','AMT','PLD','EQIX',
    'KO','PEP','PM','MO','T','VZ','TMUS','CMCSA','NFLX','DIS',
    'TSM','ASML','NVO','SAP','TM','SHEL','BHP','AZN','HSBC','SONY',
    'BABA','SE','NIO','VALE','PBR',
  ],
  // Batch 1 — Mid-large tech + fintech + biotech
  [
    'MCHP','ON','STX','WDC','MPWR','NXPI','SNPS','CDNS','ANSS','PTC',
    'IBM','CSCO','HPE','DELL','ACN','JNPR','NET','NTAP','PSTG',
    'PYPL','FIS','GPN','FISV','COIN','ICE','NDAQ','CBOE','BX','KKR',
    'APO','ARES','CG','IVZ','BEN',
    'BIIB','ILMN','MRNA','BNTX','INCY','ALNY','JAZZ',
    'CI','HUM','MOH','CNC',
    'TMO','DHR','IQV','IDXX','WAT','BDX','EW','ZBH','BAX',
    'DXCM','RMD','HOLX','PODD','GEHC',
    'SPOT','PINS','SNAP','RDDT','LYFT','UBER','ABNB','EXPE',
    'TTD','ROKU','WBD','PARA',
  ],
  // Batch 2 — Energy + materials + industrials
  [
    'HAL','BKR','HES','TPL','MRO','APA','CTRA',
    'LNG','OKE','WMB','KMI','EPD','ET','TRGP',
    'NEM','FCX','LIN','APD','ECL','PPG','SHW','ALB','NUE','STLD',
    'CLF','CMC','BALL','PKG','IP','OLN','EMN',
    'EMR','ROK','ITW','ETN','PH','DOV','XYL','IR','AME',
    'FAST','GWW','CTAS','VRSK',
    'UNP','CSX','NSC','ODFL','SAIA','XPO','JBHT',
    'DAL','UAL','LUV','AAL',
    'RSG','WM','URI',
    'LMT','NOC','GD','BA','HII','TDG','HEI','KTOS','AXON',
  ],
  // Batch 3 — Consumer + REITs + small/mid
  [
    'ORLY','AZO','TSCO','ULTA','RH','ETSY','EBAY','CPRT','KMX',
    'BOOT','ANF','AEO','FL','WING','TXRH','EAT',
    'MAR','HLT','DRI','QSR',
    'F','GM','RIVN','LCID',
    'KHC','GIS','HSY','MDLZ','CL','CLX','SYY','KR','CAG',
    'TSN','HRL','ADM','MNST','CELH',
    'SO','AEP','EXC','D','PCG','XEL','WEC','PEG',
    'SPG','O','VICI','PSA','EXR','WELL',
    'EQR','AVB','ESS','MAA',
    'CHTR','SHEN',
  ],
  // Batch 4 — International + small-cap + clean energy
  [
    'BIDU','JD','PDD','TCEHY','NTES','TME','BILI','YUMC',
    'TD','RY','BMO','BNS','CM','ENB','CNQ',
    'RIO','UL','GSK','BTI','TEF','NOK','ERIC',
    'PHIA','ING','DB','UBS','BARC','VOD',
    'ABB','STM',
    'ENPH','SEDG','FSLR','CSIQ','RUN',
    'PLUG','BE','CLNE',
    'WPM','AEM','NEM','FCX','GOLD','CCJ',
    'AFRM','UPST','SOFI','HOOD','SQ',
    'MKTX','LPLA','RJF','IBKR',
  ],
];

const TOTAL_UNIVERSE = BATCHES.flat().length;
const FALLBACK = ['MSFT','AAPL','NVDA','GOOGL','AMZN','META','JPM','XOM','LLY','UNH','V','MA','AVGO','HD','MRK','ABBV','PEP','KO','TMO','CAT'];

function cleanExch(raw) {
  if (!raw) return null;
  const u = raw.toUpperCase();
  if (u.includes('NASDAQ')||u==='NGS'||u==='NMS'||u==='NGM') return 'NASDAQ';
  if (u.includes('NYSE')||u==='NYQ') return 'NYSE';
  if (u.includes('OTC')||u.includes('PINK')) return 'OTC';
  return raw.split(/[\s,]/)[0].toUpperCase()||null;
}

const batchCache = {};
const TTL = 30 * 60 * 1000;

async function fetchQuick(symbol) {
  for (const base of ['https://query1.finance.yahoo.com','https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`${base}/v8/finance/chart/${symbol}?interval=1d&range=1y`,
        { headers: YH, signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      const meta = res?.meta;
      if (!meta?.regularMarketPrice) continue;
      const price = meta.regularMarketPrice;
      const hi = meta.fiftyTwoWeekHigh || price*1.2;
      const lo = meta.fiftyTwoWeekLow  || price*0.8;
      const pe = meta.trailingPE || null;
      const mc = meta.marketCap  || 0;
      const volume = meta.regularMarketVolume || 0;
      const exchange = cleanExch(meta.exchangeName||meta.fullExchangeName)||cleanExch(meta.exchange);
      const fromHi = hi>0?((hi-price)/hi*100):0;
      const range  = hi-lo;
      const loPct  = range>0?((price-lo)/range*100):50;
      return { symbol, price, hi, lo, pe, mc, volume, fromHi, loPct, exchange, valid:true };
    } catch (_) {}
  }
  return null;
}

function quickScore(s) {
  let n = 0;
  if      (s.mc>500e9)  n+=20;
  else if (s.mc>100e9)  n+=15;
  else if (s.mc>20e9)   n+=8;
  else if (s.mc>5e9)    n+=3;
  if (s.pe&&s.pe>0&&s.pe<80) {
    n+=8;
    if      (s.pe<12) n+=20;
    else if (s.pe<18) n+=15;
    else if (s.pe<25) n+=10;
    else if (s.pe<35) n+=5;
  }
  if      (s.fromHi>3 &&s.fromHi<15) n+=10;
  else if (s.fromHi>=15&&s.fromHi<30) n+=5;
  else if (s.fromHi>=30&&s.fromHi<50) n+=2;
  if      (s.volume>10e6) n+=8;
  else if (s.volume>1e6)  n+=4;
  else if (s.volume>100e3)n+=1;
  if (s.loPct>25&&s.loPct<80) n+=4;
  return Math.round(n);
}

async function scanBatch(batchIndex) {
  const cached = batchCache[batchIndex];
  if (cached && Date.now()-cached.ts<TTL) return cached.data;
  const tickers = BATCHES[batchIndex]||[];
  if (!tickers.length) return { scored:[], stockMeta:{} };
  const results = await Promise.allSettled(tickers.map(fetchQuick));
  const valid = results.filter(r=>r.status==='fulfilled'&&r.value).map(r=>r.value);
  const scored = valid.map(s=>({...s,qs:quickScore(s)})).sort((a,b)=>b.qs-a.qs);
  const stockMeta = {};
  for (const s of valid) if (s.exchange) stockMeta[s.symbol]={exchange:s.exchange};
  const data = { scored, stockMeta, scanned:valid.length, total:tickers.length };
  batchCache[batchIndex]={data,ts:Date.now()};
  return data;
}

export default async function handler(req, res) {
  const batchParam = req.query?.batch ?? '0';
  const batchIndices = String(batchParam).split(',').map(Number).filter(n=>!isNaN(n)&&n>=0&&n<BATCHES.length);
  if (!batchIndices.length) batchIndices.push(0);
  const forceRefresh = req.query?.refresh==='1';
  if (forceRefresh) batchIndices.forEach(i=>delete batchCache[i]);

  const batchResults = await Promise.allSettled(batchIndices.map(i=>scanBatch(i)));

  let allScored=[], stockMeta={}, totalScanned=0;
  for (const r of batchResults) {
    if (r.status==='fulfilled') {
      allScored=allScored.concat(r.value.scored);
      Object.assign(stockMeta,r.value.stockMeta);
      totalScanned+=r.value.scanned;
    }
  }
  allScored.sort((a,b)=>b.qs-a.qs);
  let candidates=allScored.slice(0,20).map(s=>s.symbol);
  if (candidates.length<4) candidates=FALLBACK.slice(0,20);
  candidates=[...new Set(candidates)].slice(0,20);
  const top50=allScored.slice(0,50).map(s=>({symbol:s.symbol,qs:s.qs,price:s.price,pe:s.pe,mc:s.mc,exchange:s.exchange}));

  res.setHeader('Cache-Control','s-maxage=1800,stale-while-revalidate=60');
  return res.status(200).json({
    candidates, stockMeta, allScored:top50,
    totalScanned, totalBatches:BATCHES.length,
    totalUniverse:TOTAL_UNIVERSE,
    batchIndex:batchIndices[0],
    generatedAt:new Date().toISOString(),
  });
}
