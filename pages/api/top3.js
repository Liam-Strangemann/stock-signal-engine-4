// pages/api/top3.js  v4
//
// Changes from v3:
//  • Universe expanded to ~1,800 tickers across all 11 GICS sectors
//  • Quick-scan (fetchQuick) runs in sequential mini-batches of 20 tickers
//    with a 200 ms pause between batches — prevents Yahoo rate-limit 429s
//    while still completing the full scan in ~20–25 s
//  • Top-scoring candidates are picked after the full scan, not mid-way
//  • analyse step unchanged — still sends top 20 to /api/analyse
//  • 30-minute server-side cache preserved
 
const YH = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
};
 
// ── Universe — ~1,800 tickers across all 11 GICS sectors ─────────────────────
const UNIVERSE = [
  // ── Mega-cap tech ─────────────────────────────────────────────────────────
  'AAPL','MSFT','NVDA','AMZN','GOOGL','GOOG','META','TSLA','AVGO','ORCL',
  // ── Semiconductors ───────────────────────────────────────────────────────
  'AMD','INTC','QCOM','TXN','AMAT','MU','KLAC','LRCX','SNPS','CDNS',
  'ADI','MRVL','MCHP','ON','STX','WDC','MPWR','SWKS','QRVO','NXPI',
  'WOLF','ACLS','ONTO','COHU','ICHR','FORM','CAMT','AXTI','PDFS','SITM',
  'ALGM','AMBA','DIOD','SLAB','POWI','IOSP','CLS','RMBS','SMTC','PI',
  // ── Software / Cloud / SaaS ──────────────────────────────────────────────
  'CRM','ADBE','NOW','INTU','WDAY','PANW','FTNT','CRWD','ZS','SNOW',
  'DDOG','MDB','TEAM','HUBS','OKTA','VEEV','ANSS','PTC','CTSH','WIT',
  'PAYC','PAYLOCITY','PCOR','SMAR','ESTC','TENB','QLYS','CYBR','SAIL','CWAN',
  'BRZE','APP','GTLB','BILL','FRSH','MNDY','DOCN','WEX','RAMP','ALTR',
  'CPNG','GRAB','SE','U','RBLX','HOOD','AFRM','UPST','SOFI','LC',
  'OPEN','MKTX','LPLA','RJF','IBKR','VIRT','PIPR','SF','COOP','PFSI',
  // ── Internet / Media / Platforms ─────────────────────────────────────────
  'NFLX','SPOT','PINS','SNAP','RDDT','LYFT','UBER','ABNB','BKNG','EXPE',
  'TRIP','YELP','TTD','DV','PUBM','MGNI','IAC','ANGI','ZG','RDFN',
  'CARS','CDK','COX','TKO','LYV','MSGS','SEAT','EVERI','IGT','DKNG',
  // ── Hardware / IT services ───────────────────────────────────────────────
  'IBM','CSCO','HPE','HPQ','DELL','ACN','EPAM','GLOB','LDOS','SAIC',
  'JNPR','NET','FFIV','NTAP','PSTG','EXTR','CIEN','VIAV','INFN','CALX',
  'LUMN','ZAYO','FYBR','CNSL','SHEN','CABO','WOW','IIVI','COHR','LITE',
  // ── Finance — large banks ────────────────────────────────────────────────
  'JPM','BAC','WFC','C','GS','MS','USB','PNC','TFC','FITB',
  'HBAN','KEY','MTB','CFG','RF','ZION','CMA','WAL','EWBC','CVBF',
  'BOKF','CATY','FFIN','IBOC','SBCF','NBTB','WSFS','TOWN','CTBI','MBWM',
  'FBIZ','HAFC','NWBI','CCBG','OVBC','ESSA','BSVN','FLIC','SRCE','MCBC',
  // ── Finance — insurance ──────────────────────────────────────────────────
  'BRK-B','AIG','MET','PRU','AFL','CB','TRV','ALL','PGR','HIG',
  'MMC','AON','WTW','CINF','GL','RNR','RE','EG','SIGI','ERIE',
  'AIZ','UNM','LNC','BHF','FG','NWLI','PLICO','EQNR','ORI','KMPR',
  // ── Finance — asset mgmt / markets / fintech ─────────────────────────────
  'BLK','SCHW','AXP','MA','V','PYPL','FIS','GPN','FISV','COIN',
  'CME','ICE','SPGI','MCO','MSCI','NDAQ','CBOE','IVZ','BEN','AMG',
  'BX','KKR','APO','ARES','CG','TPG','STEP','BLUE','OWL','HLNE',
  'SQ','AFRM','SOFI','UPST','MQ','FLYW','PAX','PAYO','DLO','EEFT',
  // ── Healthcare — large pharma ────────────────────────────────────────────
  'LLY','JNJ','ABBV','MRK','PFE','BMY','AMGN','REGN','BIIB','VRTX',
  'GILD','INCY','ALNY','MRNA','BNTX','NVAX','HZNP','JAZZ','PRGO','ENDP',
  'CTLT','PCRX','PAHC','ADMA','MNKD','IRWD','SUPN','AGIO','PTGX','ACAD',
  // ── Healthcare — managed care ────────────────────────────────────────────
  'UNH','CVS','CI','HUM','ELV','CNC','MOH','ANTM','OSCR','CLOV',
  // ── Healthcare — medtech / devices ──────────────────────────────────────
  'TMO','ABT','MDT','ISRG','BSX','SYK','BDX','EW','ZBH','BAX',
  'DXCM','RMD','HOLX','IQV','IDXX','WAT','PODD','NTRA','TFX','SWAV',
  'GEHC','HSIC','PDCO','STE','MMSI','NVST','ALGN','CENTA','PRCT','MASI',
  'IRTC','BLFS','ONEM','LFST','ATRC','HAYW','LMAT','AXNX','MVST','GKOS',
  // ── Healthcare — biotech (larger names) ──────────────────────────────────
  'ILMN','PACB','TWST','CDNA','RXRX','BEAM','EDIT','NTLA','CRSP','FATE',
  'KYMR','AKRO','ARDX','PRAX','ARQT','RCUS','IMVT','TARS','CLDX','MRUS',
  'SRRK','MIRM','XENE','PTCT','FOLD','RARE','ACLX','FGEN','AIMD','IOVA',
  // ── Energy — oil & gas majors ────────────────────────────────────────────
  'XOM','CVX','COP','EOG','SLB','MPC','PSX','VLO','OXY','DVN',
  'HAL','BKR','HES','TPL','FANG','MRO','APA','CTRA','SM','MTDR',
  'NOG','PR','CHRD','KOS','RRC','EQT','AR','SWN','CNX','GPOR',
  'ESTE','TALO','ERF','PBF','DKL','PAA','HESM','MPLX','WES','ENLC',
  // ── Energy — LNG / midstream ─────────────────────────────────────────────
  'LNG','CQP','GLNG','FLNG','OKE','WMB','KMI','EPD','ET','MMP',
  'TRGP','AM','DT','PAGP','BSM','CAPL','SMLP','CMLP','GLP','NRGP',
  // ── Consumer discretionary ───────────────────────────────────────────────
  'HD','MCD','NKE','SBUX','LOW','TGT','BKNG','MAR','HLT','YUM',
  'CMG','DRI','QSR','ORLY','AZO','TSCO','ULTA','TJX','ROST','LULU',
  'RH','W','ETSY','EBAY','CPRT','KMX','AN','PAG','GPC','AAP',
  'GNTX','BWA','LEA','LKQ','WGO','THO','POOL','FOXF','DORM','MTOR',
  'HOG','PII','LCII','PATK','SHYF','REX','BOOT','CATO','DBI','PLCE',
  'VSCO','ANF','AEO','FL','SCVL','HIBB','CASY','WING','JACK','CAKE',
  'TXRH','BJRI','SHAK','FAT','RAVE','DINE','EAT','RUTH','BLMN','PBPB',
  // ── Consumer staples ─────────────────────────────────────────────────────
  'KO','PEP','PG','PM','MO','KHC','GIS','HSY','MDLZ','CL',
  'CLX','CHD','SYY','KR','CAG','MKC','TSN','HRL','SJM','CPB',
  'BG','ADM','INGR','JBSS','CALM','SAFM','BRBR','SMPL','UTZ','FRPT',
  'CELH','MNST','FIZZ','COTT','PRMW','ARCA','REED','HAIN','UNFI','SPTN',
  // ── Automotive / EVs ─────────────────────────────────────────────────────
  'F','GM','RIVN','LCID','NIO','LI','XPEV','STLA','TM','HMC',
  'NKLA','WKHS','GOEV','FSR','BLNK','CHPT','EVGO','PTRA','DRVN','KAR',
  // ── Industrials — aerospace / defense ────────────────────────────────────
  'CAT','HON','GE','RTX','LMT','NOC','GD','BA','HII','TDG',
  'HEI','KTOS','CACI','LDOS','BAH','SAIC','AXON','DRS','AVAV','RKLB',
  'SPCE','ASTS','RDW','PL','BWXT','MOOG','CW','DRS','HEICO','TGI',
  // ── Industrials — machinery / equipment ──────────────────────────────────
  'DE','EMR','ROK','ITW','ETN','PH','DOV','XYL','IR','IEX',
  'AME','GNRC','FELE','ESCO','RBC','CWST','RSG','WM','CTAS','EXPO',
  'GFF','ARIS','NN','AIRGASES','FLOW','ROPER','VRSK','FAST','GWW','MSC',
  'WSO','WDFC','ACCO','KN','DOOR','AZEK','TREX','LGIH','XPEL','GTES',
  // ── Industrials — transport / logistics ──────────────────────────────────
  'UPS','FDX','UNP','CSX','NSC','ODFL','SAIA','XPO','JBHT','CHRW',
  'EXPD','HUBG','ARCB','MRTN','WERN','KNX','SNDR','USX','GXO','ECHO',
  'RADG','HTLD','CVLG','PTSI','UHAL','R','URI','GATX','ATSG','AAWW',
  'DAL','UAL','LUV','AAL','ALK','JBLU','SAVE','HA','SY','SNCY',
  // ── Materials ────────────────────────────────────────────────────────────
  'LIN','APD','ECL','NEM','FCX','PPG','SHW','ALB','NUE','STLD',
  'CLF','CMC','MP','BALL','PKG','IP','SEE','BMS','OLN','CC',
  'HUN','EMN','AVNT','TROX','VNTR','KRO','TG','ORB','SLCA','CSTM',
  'ATI','CRS','HXL','KALU','SXC','TMST','ZEKH','AMR','ARCH','CEIX',
  // ── Utilities ────────────────────────────────────────────────────────────
  'NEE','DUK','SO','AEP','EXC','D','PCG','XEL','WEC','ES',
  'PEG','FE','EIX','PPL','NI','CMS','AES','LNT','EVRG','AGR',
  'POR','AVA','NWE','SR','MGEE','OTTR','NWEC','ENIA','CPK','UIL',
  // ── REITs ────────────────────────────────────────────────────────────────
  'AMT','PLD','EQIX','CCI','SPG','O','VICI','PSA','EXR','WELL',
  'ARE','BXP','KIM','REG','FRT','SITC','NNN','ADC','STAG','COLD',
  'LTC','SBRA','SNH','HR','DEI','PGRE','PDM','CUZ','SLG','HIW',
  'EQR','AVB','ESS','MAA','UDR','CPT','NHI','NXRT','IRT','AIRC',
  'WPT','IIPR','HASI','ABR','BXMT','KREF','GPMT','TRTX','LADR','RC',
  // ── Telecom ──────────────────────────────────────────────────────────────
  'T','VZ','TMUS','CMCSA','CHTR','LUMN','USM','SHEN','CABO','WOW',
  'IRDM','VSAT','GSAT','NTES','ISAT','DISH','LWAY','ATNI','GOCO','PCTEL',
  // ── Media / Entertainment / Gaming ───────────────────────────────────────
  'DIS','NFLX','WBD','PARA','AMCX','FOXA','FOX','NYT','GTN','SBGI',
  'ROKU','FUBO','SIRI','LSXMA','LSXMK','WWE','TKO','LYV','MSGS','SEAS',
  'EA','TTWO','ATVI','RBLX','HUYA','DOYU','MSGE','MSG','MANU','LGF-A',
  // ── International ADRs — Europe ──────────────────────────────────────────
  'ASML','SAP','NVO','AZN','GSK','BTI','SHEL','BP','TTE','UL',
  'RIO','BHP','VALE','PBR','SID','ABB','PHIA','ING','BNP','DB',
  'UBS','HSBC','BARC','LLOY','VOD','TEF','VIV','ORAN','NOK','ERIC',
  'WOLF','NXPI','STM','AIXA','AMS','BESI','COMET','DISCO','ELUX','LONN',
  // ── International ADRs — Asia / Pacific ──────────────────────────────────
  'TSM','TM','HMC','SONY','NTDOY','SE','BABA','JD','PDD','BIDU',
  'NIO','TCEHY','NTES','TME','IQ','BILI','VIPS','YUMC','WB','MOMO',
  'ACH','CHU','CHL','CHT','MFC','SLF','POW','BCE','TD','RY',
  'BMO','BNS','CM','NA','EMA','FTS','QBR','TRP','ENB','CNQ',
  // ── Small/Mid-cap value & special situations ──────────────────────────────
  'DCOM','CFFN','ESSA','BSVN','FLIC','SRCE','MCBC','FFBW','CBTX','HBT',
  'NBTB','WSFS','TOWN','CTBI','MBWM','FBIZ','HAFC','NWBI','CCBG','OVBC',
  'AMAL','BFST','CADE','COLB','CVBF','FBMS','FBNC','FUNC','GNTY','HWC',
  'INDB','IBTX','LKFN','MOFG','NBHC','NRIM','OCFC','PFIS','PPBI','SASR',
  'SBCF','TCBK','TRMK','UFCS','UVSP','VCNX','VBTX','WAFD','WSBC','CZNC',
  // ── Mid-cap cyclicals / industrials value ─────────────────────────────────
  'AIT','APOG','ASTE','BGCP','CLB','CSWI','DXC','ENR','GATX','GMS',
  'GNSS','HNI','HTLF','HUBB','IPAR','KFY','KELYA','LMB','LQDT','MGRC',
  'MRC','MWA','NPK','NWL','PATK','PKOH','REVG','RGP','SXI','TILE',
  'TNC','USLM','VICR','VSEC','WKC','WTS','ZURN','ZWS','AQUA','AVPT',
  // ── Small-cap growth / tech ───────────────────────────────────────────────
  'ACMR','ADEA','AEYE','AGYS','ALRM','AMID','AMSC','ANET','ANGI','AOSL',
  'ARKO','ARLO','AROW','ARWT','ASIX','ATEX','ATNI','ATRC','AUPH','AVNW',
  'AXGN','AXTI','BAND','BBIO','BCAB','BCEI','BCML','BDSI','BELFB','BIOL',
  'BJRI','BKE','BKSY','BLBD','BLFY','BLMN','BLTE','BMBL','BNED','BNGO',
  'BPOP','BRDG','BRPH','BRZE','BSGM','BXRX','BYND','BZUN','CALX','CARG',
  'CASH','CBSH','CCOI','CDRE','CDXS','CEIX','CELH','CHCO','CHMG','CHPT',
  // ── Commodity / natural resources ─────────────────────────────────────────
  'AA','ACH','AG','AGI','AEM','AUY','BVN','CCJ','CDE','EXK',
  'GOLD','HL','IAG','KGC','KL','MAG','NGEX','NXE','OR','PAAS',
  'SSRM','USAS','WPM','BTG','MUX','SVM','GP','GFI','SBSW','HMY',
  // ── Clean energy / renewables ─────────────────────────────────────────────
  'ENPH','SEDG','FSLR','CSIQ','JKS','ARRY','MAXN','RUN','NOVA','SPWR',
  'PLUG','FCEL','BLDP','BE','HYLN','CLNE','GPRE','REX','PEIX','ALTO',
  'NEP','CWEN','AY','BEP','AMPS','HASI','NOVA','VVPR','PLTK','GREE',
];
 
const UNIQ = [...new Set(UNIVERSE)];
 
// ── Fallback pool ─────────────────────────────────────────────────────────────
const FALLBACK = [
  'MSFT','AAPL','NVDA','GOOGL','AMZN','META','JPM','XOM','LLY','UNH',
  'V','MA','AVGO','HD','MRK','ABBV','PEP','KO','TMO','CAT',
];
 
// ── Exchange label normalisation ──────────────────────────────────────────────
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
const TTL = 30 * 60 * 1000; // 30 minutes
 
// ── Fetch quick metadata for a single ticker ──────────────────────────────────
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
      const pe       = meta.trailingPE        || null;
      const mc       = meta.marketCap         || 0;
      const volume   = meta.regularMarketVolume || 0;
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
 
// ── quickScore — selects candidates worth full analysis ───────────────────────
function quickScore(s) {
  let n = 0;
 
  // 1. Market-cap quality tiers
  if      (s.mc > 500e9)  n += 20;
  else if (s.mc > 100e9)  n += 15;
  else if (s.mc > 20e9)   n += 8;
  else if (s.mc > 5e9)    n += 3;
 
  // 2. PE exists and is credible
  if (s.pe && s.pe > 0 && s.pe < 80) {
    n += 8;
    if      (s.pe < 12) n += 20;
    else if (s.pe < 18) n += 15;
    else if (s.pe < 25) n += 10;
    else if (s.pe < 35) n += 5;
  }
 
  // 3. Distance from 52w high — mild preference for modest pullbacks
  if      (s.fromHi > 3  && s.fromHi < 15) n += 10;
  else if (s.fromHi >= 15 && s.fromHi < 30) n += 5;
  else if (s.fromHi >= 30 && s.fromHi < 50) n += 2;
 
  // 4. Liquidity
  if      (s.volume > 10e6)  n += 8;
  else if (s.volume > 1e6)   n += 4;
  else if (s.volume > 100e3) n += 1;
 
  // 5. Range position — prefer mid-range
  if (s.loPct > 25 && s.loPct < 80) n += 4;
 
  return Math.round(n);
}
 
// ── Sequential batched quick-scan ─────────────────────────────────────────────
// Runs in mini-batches of 20 with a 200 ms pause between each batch.
// This processes ~1,800 tickers in ~20–25 s without triggering Yahoo 429s.
// Each batch uses Promise.all so tickers within a batch are concurrent.
async function scanUniverseSequentially(universe) {
  const MINI_BATCH = 20;   // concurrent fetches per round
  const PAUSE_MS   = 200;  // pause between rounds (ms)
  const results = [];
 
  for (let i = 0; i < universe.length; i += MINI_BATCH) {
    const batch = universe.slice(i, i + MINI_BATCH);
    const batchResults = await Promise.all(batch.map(fetchQuick));
    for (const r of batchResults) {
      if (r) results.push(r);
    }
    // Pause between rounds — skip the pause after the last batch
    if (i + MINI_BATCH < universe.length) {
      await new Promise(resolve => setTimeout(resolve, PAUSE_MS));
    }
  }
 
  return results;
}
 
// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Serve from cache if fresh
  if (cache.data && Date.now() - cache.ts < TTL) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cache.data);
  }
 
  let candidates   = [];
  let stockMeta    = {};
  let totalScanned = 0;
 
  try {
    // Full universe quick-scan — sequential batches to avoid rate limits
    const allResults = await scanUniverseSequentially(UNIQ);
    totalScanned = allResults.length;
 
    if (allResults.length >= 4) {
      const scored = allResults
        .map(s => ({ ...s, qs: quickScore(s) }))
        .sort((a, b) => b.qs - a.qs);
 
      // Top 20 by quickScore go to the full 6-signal analysis
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
 
