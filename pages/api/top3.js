// pages/api/top3.js  v7 — 1,500+ tickers, 10 batches, NASDAQ-first
// Each batch is ~150 tickers. Batch 0 = NASDAQ megacaps (returned in ~3s).
// Batches 1-9 run sequentially in background. Frontend promotes winners live.

const YH = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
};

// ── 10 batches, ~150 tickers each ─────────────────────────────────────────────
const BATCHES = [

  // BATCH 0 — NASDAQ megacap tech + large-cap (first to load)
  ['AAPL','MSFT','NVDA','AMZN','GOOGL','GOOG','META','TSLA','AVGO','ORCL',
   'AMD','INTC','QCOM','TXN','AMAT','MU','KLAC','LRCX','ADI','MRVL',
   'MCHP','ON','NXPI','MPWR','SWKS','QRVO','SLAB','POWI','IOSP','RMBS',
   'CRM','ADBE','NOW','INTU','PANW','FTNT','CRWD','ZS','DDOG','SNOW',
   'WDAY','OKTA','VEEV','TEAM','HUBS','MDB','ESTC','GTLB','BILL','BRZE',
   'UBER','ABNB','BKNG','EXPE','LYFT','DASH','SNAP','PINS','RDDT','TTD',
   'NFLX','SPOT','ROKU','WBD','PARA','AMCX','FUBO','SIRI',
   'PYPL','SQ','AFRM','UPST','SOFI','HOOD','COIN','MKTX','IBKR',
   'CSCO','JNPR','NET','FFIV','NTAP','PSTG','EXTR','CIEN',
   'SHOP','ETSY','EBAY','W','CHWY','CPNG','SE','GRAB',
   'TSCO','ULTA','LULU','NKE','DECK','UAA','SKX',
   'SBUX','CMG','YUM','QSR','DRI','WING','JACK','TXRH'],

  // BATCH 1 — NYSE megacap finance + healthcare + consumer
  ['JPM','BAC','WFC','C','GS','MS','BLK','AXP','MA','V',
   'SCHW','USB','PNC','TFC','FITB','HBAN','KEY','MTB','CFG','RF',
   'CME','ICE','SPGI','MCO','MSCI','NDAQ','CBOE',
   'BX','KKR','APO','ARES','CG','TPG','IVZ','BEN','AMG',
   'LLY','JNJ','UNH','ABBV','MRK','PFE','TMO','ABT','AMGN','CVS',
   'MDT','ISRG','BSX','SYK','BDX','EW','ZBH','BAX','DXCM','RMD',
   'HOLX','IQV','IDXX','WAT','PODD','NTRA','GEHC','STE','MMSI',
   'REGN','BIIB','VRTX','GILD','BMY','ALNY','INCY','JAZZ','MRNA','BNTX',
   'HD','MCD','LOW','TGT','WMT','COST','AMZN','BKNG','MAR','HLT',
   'TJX','ROST','RH','ORLY','AZO','KMX','AN','PAG','GPC','AAP',
   'KO','PEP','PM','MO','KHC','GIS','HSY','MDLZ','CL','CLX',
   'SYY','KR','CAG','MKC','TSN','HRL','ADM'],

  // BATCH 2 — Energy + industrials + materials
  ['XOM','CVX','COP','EOG','SLB','MPC','PSX','VLO','OXY','DVN',
   'HAL','BKR','HES','MRO','APA','CTRA','FANG','TPL',
   'LNG','OKE','WMB','KMI','EPD','ET','TRGP','MPLX','WES',
   'NEM','FCX','LIN','APD','ECL','PPG','SHW','ALB','NUE','STLD',
   'CLF','CMC','MP','BALL','PKG','IP','SEE','OLN','EMN','AVT',
   'CAT','HON','GE','RTX','LMT','NOC','GD','BA','HII','TDG',
   'DE','EMR','ROK','ITW','ETN','PH','DOV','XYL','IR','AME',
   'HEI','KTOS','AXON','LDOS','BAH','SAIC','DRS','BWXT',
   'UPS','FDX','UNP','CSX','NSC','ODFL','SAIA','XPO','JBHT','CHRW',
   'EXPD','HUBG','DAL','UAL','LUV','AAL','ALK',
   'RSG','WM','CWST','URI','R','FAST','GWW','MSC','CTAS','VRSK',
   'GNRC','FELE','AME','IEX','ROPER','ANSS'],

  // BATCH 3 — REITs + utilities + telecom
  ['NEE','DUK','SO','AEP','EXC','D','PCG','XEL','WEC','ES',
   'PEG','FE','EIX','PPL','NI','CMS','AES','LNT','EVRG','AGR',
   'AMT','PLD','EQIX','CCI','SPG','O','VICI','PSA','EXR','WELL',
   'ARE','BXP','KIM','REG','FRT','SITC','NNN','ADC','STAG','COLD',
   'EQR','AVB','ESS','MAA','UDR','CPT','SBAC','DLR','QTS',
   'T','VZ','TMUS','CMCSA','CHTR','LUMN','USM','DISH','IRDM',
   'DIS','NFLX','WBD','PARA','AMCX','FOXA','FOX','NYT','LYV','TKO',
   'EA','TTWO','RBLX','HUYA','MSGE','MANU',
   'MNST','CELH','FIZZ','COTT','HAIN','UNFI','SPTN',
   'BG','ADM','INGR','CALM','TSN','HRL','SJM','CPB','CAG'],

  // BATCH 4 — Mid-large tech + software + SaaS
  ['IBM','CSCO','HPE','HPQ','DELL','ACN','EPAM','GLOB','LDOS','SAIC',
   'PAYC','PCOR','SMAR','TENB','QLYS','CYBR','SAIL','CWAN','RAMP','ALTR',
   'APP','BILL','FRSH','MNDY','DOCN','WEX','RBLX','HOOD',
   'LC','OPEN','PFSI','COOP','LPLA','RJF','VIRT','PIPR','SF',
   'U','RBLX','BMBL','ETSY','EBAY','W','CHWY',
   'ZG','RDFN','CARS','CDK','ANGI','IAC','YELP','TRIP',
   'DKNG','EVERI','IGT','PENN','LVS','MGM','WYNN','CZR',
   'PLTR','AI','BBAI','SOUN','AMBA','CEVA','XPEL',
   'ANET','SMTC','PI','ALGM','DIOD','SITM','AXTI','ACLS','ONTO','COHU',
   'MRVL','AVGO','QCOM','TXN','ADI','MCHP','ON','NXPI',
   'SNPS','CDNS','ANSS','PTC','CTSH','WIT'],

  // BATCH 5 — Biotech + pharma small/mid
  ['ILMN','PACB','TWST','CDNA','RXRX','BEAM','EDIT','NTLA','CRSP',
   'KYMR','AKRO','ARDX','PRAX','ARQT','RCUS','IMVT','TARS','CLDX','MRUS',
   'SRRK','MIRM','XENE','PTCT','FOLD','RARE','ACLX','IOVA','ACAD',
   'AUPH','AXGN','BBIO','BCAB','BDSI','AGIO','PTGX',
   'HZNP','JAZZ','PRGO','ENDP','CTLT','PCRX','PAHC','ADMA','MNKD','IRWD','SUPN',
   'CI','HUM','ELV','CNC','MOH','OSCR','CLOV',
   'TMO','DHR','A','WAT','BIO','IDXX','PODD','NTRA','TFX','SWAV',
   'IRTC','BLFS','ATRC','HAYW','LMAT','AXNX','MVST','GKOS','PRCT','MASI',
   'NUVA','OMCL','NVCR','TNDM','INSP','NARI','SILK','RXST'],

  // BATCH 6 — Financial small/mid + insurance + asset mgmt
  ['BRK-B','AIG','MET','PRU','AFL','CB','TRV','ALL','PGR','HIG',
   'MMC','AON','WTW','CINF','GL','RNR','RE','EG','SIGI','ERIE',
   'AIZ','UNM','LNC','BHF','ORI','KMPR',
   'WAL','EWBC','CVBF','BOKF','CATY','FFIN','IBOC',
   'NBTB','WSFS','TOWN','CTBI','MBWM','FBIZ','HAFC','NWBI',
   'AMAL','BFST','CADE','COLB','FBMS','FBNC','GNTY','HWC',
   'INDB','IBTX','LKFN','MOFG','NBHC','NRIM','OCFC','PFIS','PPBI','SASR',
   'SBCF','TCBK','TRMK','UVSP','VBTX','WAFD','WSBC','CZNC',
   'FIS','GPN','FISV','WEX','FLYW','PAX','PAYO','DLO','EEFT',
   'PYPL','SQ','AFRM','UPST','SOFI','HOOD'],

  // BATCH 7 — International ADRs (NASDAQ + NYSE listed)
  ['TSM','ASML','NVO','SAP','TM','HMC','SHEL','BP','TTE','UL',
   'RIO','BHP','VALE','PBR','SID','ABB','PHIA','ING','BNP','DB',
   'UBS','HSBC','BARC','LLOY','VOD','TEF','VIV','ORAN','NOK','ERIC',
   'BABA','JD','PDD','BIDU','TCEHY','NTES','TME','IQ','BILI','VIPS',
   'YUMC','WB','MOMO','ACH','CHU','CHT',
   'MFC','SLF','POW','BCE','TD','RY','BMO','BNS','CM','NA',
   'EMA','FTS','TRP','ENB','CNQ','SU','CVE',
   'SONY','NTDOY','SE','NIO','LI','XPEV',
   'AZN','GSK','BTI','SNY','NVS','ROG','NOVN','ALKS',
   'STLA','VWAGY','BMWYY','DDAIF'],

  // BATCH 8 — Clean energy + commodity + small-cap growth
  ['ENPH','SEDG','FSLR','CSIQ','JKS','ARRY','MAXN','RUN','NOVA','SPWR',
   'PLUG','FCEL','BLDP','BE','CLNE','GPRE',
   'NEP','CWEN','AY','BEP','AMPS','HASI',
   'WPM','AEM','NEM','FCX','GOLD','CCJ','KGC','KL','MAG','PAAS',
   'SSRM','BTG','MUX','SVM','GFI','SBSW','HMY',
   'AA','ACH','AG','AGI','AUY','BVN','CDE','EXK','HL','IAG',
   'ACMR','ADEA','AEYE','AGYS','ALRM','AMSC','AOSL',
   'ARKO','ARLO','ASIX','ATEX','AUPH','AVNW',
   'BAND','BMBL','CALX','CARG','CASH','CBSH','CCOI',
   'CDRE','CELH','CHCO','CHPT','EVGO','BLNK',
   'WKHS','GOEV','NKLA','RIVN','LCID',
   'DRVN','KAR','CPRT','KMX','AN'],

  // BATCH 9 — Mid-cap value + cyclicals + remaining sectors
  ['AIT','APOG','ASTE','CLB','CSWI','DXC','ENR','GMS',
   'HNI','HUBB','IPAR','KFY','KELYA','LMB','LQDT','MGRC',
   'MRC','MWA','NPK','NWL','PKOH','REVG','RGP','SXI','TILE',
   'TNC','USLM','VICR','VSEC','WKC','WTS','AQUA','AVPT',
   'BOOT','CATO','DBI','PLCE','VSCO','ANF','AEO','FL','SCVL','HIBB',
   'CASY','RUTH','BLMN','PBPB','BJRI','SHAK','FAT','RAVE','DINE','EAT',
   'HOG','PII','LCII','PATK','SHYF','REX','WGO','THO','POOL','FOXF',
   'GNTX','BWA','LEA','LKQ','DORM','MTOR',
   'DE','AGCO','CNH','KUBOTA','CNHI',
   'DOOR','AZEK','TREX','LGIH','GTES','XPEL',
   'CF','MOS','NTR','ICL','YARA',
   'CLF','CMC','STLD','NUE','RS','MSTLD',
   'PKG','IP','SEE','BMS','SLVM','BERY',
   'PBF','DKL','CAPL','SMLP','CMLP','GLP','NRGP'],
];

const TOTAL_UNIVERSE = [...new Set(BATCHES.flat())].length;

const FALLBACK = [
  'MSFT','AAPL','NVDA','GOOGL','AMZN','META','JPM','XOM','LLY','UNH',
  'V','MA','AVGO','HD','MRK','ABBV','PEP','KO','TMO','CAT',
];

function cleanExch(raw) {
  if (!raw) return null;
  const u = raw.toUpperCase();
  if (u.includes('NASDAQ')||u==='NGS'||u==='NMS'||u==='NGM') return 'NASDAQ';
  if (u.includes('NYSE')||u==='NYQ') return 'NYSE';
  if (u.includes('OTC')||u.includes('PINK')) return 'OTC';
  return raw.split(/[\s,]/)[0].toUpperCase() || null;
}

// 30-minute cache per batch
const batchCache = {};
const TTL = 30 * 60 * 1000;

async function fetchQuick(symbol) {
  for (const base of ['https://query1.finance.yahoo.com','https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`${base}/v8/finance/chart/${symbol}?interval=1d&range=1y`,
        { headers: YH, signal: AbortSignal.timeout(5000) });
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
      const exch   = cleanExch(meta.exchangeName||meta.fullExchangeName) || cleanExch(meta.exchange);
      const fromHi = hi > 0 ? ((hi - price) / hi * 100) : 0;
      const range  = hi - lo;
      const loPct  = range > 0 ? ((price - lo) / range * 100) : 50;
      return { symbol, price, hi, lo, pe, mc, volume, fromHi, loPct, exchange: exch, valid: true };
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
  if      (s.volume > 10e6) n += 8;
  else if (s.volume > 1e6)  n += 4;
  else if (s.volume > 100e3)n += 1;
  if (s.loPct > 25 && s.loPct < 80) n += 4;
  return Math.round(n);
}

async function scanBatch(batchIndex) {
  const cached = batchCache[batchIndex];
  if (cached && Date.now() - cached.ts < TTL) return cached.data;

  const tickers = BATCHES[batchIndex] || [];
  if (!tickers.length) return { scored:[], stockMeta:{}, scanned:0, total:0 };

  // Fetch all in parallel — ~150 tickers, ~3-4s
  const results = await Promise.allSettled(tickers.map(fetchQuick));
  const valid   = results.filter(r => r.status==='fulfilled' && r.value).map(r => r.value);
  const scored  = valid.map(s => ({ ...s, qs: quickScore(s) })).sort((a, b) => b.qs - a.qs);
  const stockMeta = {};
  for (const s of valid) if (s.exchange) stockMeta[s.symbol] = { exchange: s.exchange };

  const data = { scored, stockMeta, scanned: valid.length, total: tickers.length };
  batchCache[batchIndex] = { data, ts: Date.now() };
  return data;
}

export default async function handler(req, res) {
  const batchParam   = req.query?.batch ?? '0';
  const batchIndices = String(batchParam).split(',').map(Number)
    .filter(n => !isNaN(n) && n >= 0 && n < BATCHES.length);
  if (!batchIndices.length) batchIndices.push(0);

  if (req.query?.refresh === '1') batchIndices.forEach(i => delete batchCache[i]);

  const batchResults = await Promise.allSettled(batchIndices.map(i => scanBatch(i)));

  let allScored = [], stockMeta = {}, totalScanned = 0;
  for (const r of batchResults) {
    if (r.status === 'fulfilled') {
      allScored    = allScored.concat(r.value.scored);
      Object.assign(stockMeta, r.value.stockMeta);
      totalScanned += r.value.scanned;
    }
  }
  allScored.sort((a, b) => b.qs - a.qs);

  let candidates = allScored.slice(0, 20).map(s => s.symbol);
  if (candidates.length < 4) candidates = FALLBACK.slice(0, 20);
  candidates = [...new Set(candidates)].slice(0, 20);

  // Top 50 scored — for incremental pool promotion on frontend
  const top50 = allScored.slice(0, 50).map(s => ({
    symbol: s.symbol, qs: s.qs, price: s.price, pe: s.pe, mc: s.mc, exchange: s.exchange,
  }));

  // universePECache: every ticker with a valid PE from this batch — free peer data
  const universePECache = {};
  for (const s of allScored) {
    if (s.pe > 0 && s.pe < 300) universePECache[s.symbol] = s.pe;
  }

  res.setHeader('Cache-Control', 's-maxage=1800,stale-while-revalidate=60');
  return res.status(200).json({
    candidates, stockMeta, allScored: top50,
    totalScanned, totalBatches: BATCHES.length,
    totalUniverse: TOTAL_UNIVERSE,
    batchIndex: batchIndices[0],
    universePECache,
    generatedAt: new Date().toISOString(),
  });
}
