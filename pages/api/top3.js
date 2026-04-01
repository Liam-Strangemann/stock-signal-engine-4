// pages/api/top3.js  v4
//
// Progressive scanning via Server-Sent Events (SSE).
//
// Strategy:
//   1. Client connects to GET /api/top3 and receives an SSE stream.
//   2. Server fetches quick Yahoo data in parallel batches of 50.
//   3. After each batch completes, the scored candidates are re-ranked and
//      the current top-20 are sent as a "candidates" event — the UI can
//      start deep-analysing immediately while more batches are still running.
//   4. A final "done" event is sent with the full scanned count.
//
// This means the UI shows results from ~200 stocks within seconds, then
// keeps updating as the remaining ~500 come in, without any extra API cost.
//
// Universe: ~720 tickers across all 11 GICS sectors + major ADRs.
// Quick-fetch uses only Yahoo Finance (free, no key needed).
// quickScore unchanged from v3 — rewards quality/liquidity, not distress.
 
const YH = {
  'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':'application/json, text/plain, */*','Accept-Language':'en-US,en;q=0.9',
  'Origin':'https://finance.yahoo.com','Referer':'https://finance.yahoo.com/',
};
 
// ── Universe ~~720 tickers ────────────────────────────────────────────────────
const UNIVERSE = [
  // Mega-cap tech
  'AAPL','MSFT','NVDA','AMZN','GOOGL','GOOG','META','TSLA','AVGO','ORCL',
  // Semiconductors
  'AMD','INTC','QCOM','TXN','AMAT','MU','KLAC','LRCX','SNPS','CDNS',
  'ADI','MRVL','MCHP','ON','STX','WDC','MPWR','SWKS','QRVO','NXPI',
  'WOLF','CREE','COHR','AMBA','POWI','DIOD','SMTC','MTSI','FORM','AOSL',
  // Software / Cloud
  'CRM','ADBE','NOW','INTU','WDAY','PANW','FTNT','CRWD','ZS','SNOW',
  'DDOG','MDB','TEAM','HUBS','OKTA','VEEV','ANSS','PTC','CTSH','WIT',
  'SPLK','ESTC','GTLB','U','RBLX','COIN','APP','PLTR','AI','BBAI',
  'DOCN','CFLT','SMAR','APPF','BRZE','PCTY','PAYC','COUP','NCNO','YEXT',
  // Internet / Media
  'NFLX','SPOT','PINS','SNAP','RDDT','LYFT','UBER','ABNB','BKNG','EXPE',
  'TRIP','YELP','TTD','DV','PUBM','MGNI','IAC','ZG','MTCH','BMBL',
  // Hardware / IT services
  'IBM','CSCO','HPE','HPQ','DELL','ACN','EPAM','GLOB','LDOS','SAIC',
  'NTAP','PSTG','SMCI','FLEX','JNPR','VIAV','CIEN','LITE','IIVI','COHU',
  // Finance — banks
  'JPM','BAC','WFC','C','GS','MS','USB','PNC','TFC','FITB',
  'HBAN','KEY','MTB','CFG','RF','ZION','CMA','WAL','EWBC','BOKF',
  'GBCI','SFNC','UMBF','WTFC','IBOC','FFIN','HTLF','BANR','PACW','CADE',
  // Finance — insurance
  'BRK-B','AIG','MET','PRU','AFL','CB','TRV','ALL','PGR','HIG',
  'MMC','AON','WTW','CINF','GL','RNR','RE','EG','SIGI','KMPR',
  // Finance — asset mgmt / markets / fintech
  'BLK','SCHW','AXP','MA','V','PYPL','FIS','GPN','FISV','SQ',
  'CME','ICE','SPGI','MCO','MSCI','NDAQ','CBOE','IVZ','BEN','AMG',
  'BX','KKR','APO','ARES','CG','AFRM','UPST','SOFI','LC','HOOD',
  'MKTX','LPLA','RJF','SF','GCMG','STEP','HLNE','VCTR','APAM','ROME',
  // Healthcare — pharma / biotech
  'LLY','JNJ','ABBV','MRK','PFE','BMY','AMGN','REGN','BIIB','VRTX',
  'GILD','INCY','ALNY','MRNA','BNTX','NVAX','HZNP','JAZZ','PRGO','ENDP',
  'RXRX','BEAM','EDIT','NTLA','CRSP','FATE','KYMR','AKRO','ARDX','PRAX',
  'ARQT','TVTX','BLUE','SAGE','PTGX','IMVT','ARWR','IONS','SRPT','BMRN',
  // Healthcare — managed care
  'UNH','CVS','CI','HUM','ELV','CNC','MOH','OSCR','HCAI',
  // Healthcare — medtech / services
  'TMO','ABT','MDT','ISRG','BSX','SYK','BDX','EW','ZBH','BAX',
  'DXCM','RMD','HOLX','IQV','IDXX','WAT','PODD','NTRA','TFX','SWAV',
  'GEHC','HSIC','PDCO','STE','MMSI','ALGN','AXNX','NVCR','INVA','SRDX',
  // Energy — oil / gas
  'XOM','CVX','COP','EOG','SLB','MPC','PSX','VLO','OXY','DVN',
  'HAL','BKR','HES','TPL','FANG','MRO','APA','CTRA','SM','MTDR',
  'NOG','PR','CHRD','KOS','RRC','EQT','AR','SWN','CNX','GPOR',
  'DINO','PBF','PARR','DKL','CAPL','SUNCOKE','USAC','BSM','PHX','VNOM',
  // Energy — LNG / midstream
  'LNG','CQP','GLNG','FLNG','OKE','WMB','KMI','EPD','ET','MMP',
  'PAA','TRGP','AM','DT','MPLX','HESM','CQPF','NFG','UGI','SPH',
  // Consumer discretionary
  'HD','MCD','NKE','SBUX','LOW','TGT','BKNG','MAR','HLT','YUM',
  'CMG','DRI','QSR','ORLY','AZO','TSCO','ULTA','TJX','ROST','LULU',
  'RH','W','ETSY','EBAY','CPRT','KMX','AN','PAG','GPC','AAP',
  'GNTX','BWA','LEA','LKQ','WGO','THO','POOL','FOXF','MODG','GOLF',
  'DPZ','WEN','JACK','CAKE','TXRH','BLMN','DENN','FAT','RAVE','CBRL',
  // Consumer staples
  'KO','PEP','PG','PM','MO','KHC','GIS','HSY','MDLZ','CL',
  'CLX','CHD','SYY','KR','CAG','MKC','TSN','HRL','SJM','CPB',
  'BG','ADM','INGR','JBSS','LANC','THS','SMPL','UTZ','FRPT','NAPA',
  // Automotive
  'F','GM','RIVN','LCID','NIO','LI','XPEV','STLA','TM','HMC',
  'MPAA','ADNT','APTV','LEA','MGA','GT','CTB','SMP','DORM','ALSN',
  // Industrials — aerospace / defense
  'CAT','HON','GE','RTX','LMT','NOC','GD','BA','HII','TDG',
  'HEI','KTOS','CACI','BAH','SAIC','LDOS','VSE','ACHR','JOBY','LILM',
  // Industrials — machinery / equipment
  'DE','EMR','ROK','ITW','ETN','PH','DOV','XYL','IR','IEX',
  'AME','GNRC','FELE','ESCO','RBC','CWST','RSG','WM','CTAS','EXPO',
  'TTC','LBRT','NE','HP','WHD','PTEN','RES','OII','FTI','XPRO',
  // Industrials — transport / logistics
  'UPS','FDX','UNP','CSX','NSC','ODFL','SAIA','XPO','JBHT','CHRW',
  'EXPD','HUBG','ARCB','MRTN','WERN','ECHO','LSTR','PTSI','HTLD','CVLG',
  // Materials
  'LIN','APD','ECL','NEM','FCX','PPG','SHW','ALB','NUE','STLD',
  'CLF','CMC','MP','BALL','PKG','IP','SEE','BMS','OLN','CC',
  'ATI','CRS','KALU','CENX','CSTM','SLCA','USLM','TREX','AZEK','DOOR',
  // Utilities
  'NEE','DUK','SO','AEP','EXC','D','PCG','XEL','WEC','ES',
  'PEG','FE','EIX','PPL','NI','CMS','AES','LNT','EVRG','AGR',
  'NRG','CLNE','BEP','CWEN','ORA','GPJA','MGEE','YORW','AWR','SJW',
  // REITs
  'AMT','PLD','EQIX','CCI','SPG','O','VICI','PSA','EXR','WELL',
  'ARE','BXP','KIM','REG','FRT','SITC','NNN','ADC','STAG','COLD',
  'IIPR','GLPI','MPW','SBAC','AMH','INVH','TRNO','EGP','REXR','FR',
  // Telecom
  'T','VZ','TMUS','CMCSA','CHTR','LUMN','USM','SHEN','CABO','WOW',
  // Media / Entertainment
  'DIS','NFLX','WBD','PARA','AMCX','FOXA','FOX','NYT','GTN','SBGI',
  'ROKU','FUBO','SIRI','LGF-A','IMAX','CNK','AMC','NCMI',
  // International ADRs — Europe
  'ASML','SAP','NVO','AZN','GSK','BTI','SHEL','BP','TTE','UL',
  'RIO','BHP','VALE','PBR','SID','ABB','PHIA','ING','BNP','DB',
  'UBS','HSBC','BARC','LLOY','VOD','TEF','VIV','ORAN','NOK','ERIC',
  'SHOP','CP','CNI','SU','ENB','TRP','BCE','TD','BNS','RY',
  // International ADRs — Asia/Pacific
  'TSM','TM','HMC','SONY','NTDOY','SE','GRAB','BABA',
  'JD','PDD','BIDU','TCEHY','NTES','TME','IQ','BILI','VIPS','TIGR',
  // Additional mid/small cap value candidates
  'OGN','VRX','PRGO','ENDP','ATRC','ATRI','CCRN','AGIO','ACAD','PTCT',
  'AMRX','AKBA','HALO','ITCI','VNDA','CHRS','VKTX','KRYS','DAWN','XERS',
];
 
const UNIQ = [...new Set(UNIVERSE)];
 
const FALLBACK = [
  'MSFT','AAPL','NVDA','GOOGL','AMZN','META','JPM','XOM','LLY','UNH',
  'V','MA','AVGO','HD','MRK','ABBV','PEP','KO','TMO','CAT',
];
 
function cleanExchangeLabel(raw){
  if(!raw)return null;const u=raw.toUpperCase();
  if(u.includes('NASDAQ')||u==='NGS'||u==='NMS'||u==='NGM')return'NASDAQ';
  if(u.includes('NYSE')||u==='NYQ')return'NYSE';
  if(u.includes('LSE')||u.includes('LONDON'))return'LSE';
  if(u.includes('TSX')||u.includes('TORONTO'))return'TSX';
  if(u.includes('HKEX')||u.includes('HONG KONG'))return'HKEX';
  if(u.includes('ASX')||u.includes('SYDNEY'))return'ASX';
  if(u.includes('TYO')||u.includes('TOKYO'))return'TYO';
  if(u.includes('OTC')||u.includes('PINK'))return'OTC';
  return raw.split(/[\s,]/)[0].toUpperCase()||null;
}
 
async function fetchQuick(symbol){
  for(const base of['https://query1.finance.yahoo.com','https://query2.finance.yahoo.com']){
    try{
      const r=await fetch(`${base}/v8/finance/chart/${symbol}?interval=1d&range=1y`,{headers:YH,signal:AbortSignal.timeout(5000)});
      if(!r.ok)continue;
      const j=await r.json();const res=j?.chart?.result?.[0];const meta=res?.meta;
      if(!meta?.regularMarketPrice)continue;
      const price=meta.regularMarketPrice;
      const hi=meta.fiftyTwoWeekHigh||price*1.2;
      const lo=meta.fiftyTwoWeekLow||price*0.8;
      const pe=meta.trailingPE||null;
      const mc=meta.marketCap||0;
      const volume=meta.regularMarketVolume||0;
      const exchange=cleanExchangeLabel(meta.exchangeName||meta.fullExchangeName)||cleanExchangeLabel(meta.exchange);
      const fromHi=hi>0?((hi-price)/hi*100):0;
      const range=hi-lo;const loPct=range>0?((price-lo)/range*100):50;
      return{symbol,price,hi,lo,pe,mc,volume,fromHi,loPct,exchange,valid:true};
    }catch(_){}
  }
  return null;
}
 
function quickScore(s){
  let n=0;
  if(s.mc>500e9)n+=20;else if(s.mc>100e9)n+=15;else if(s.mc>20e9)n+=8;else if(s.mc>5e9)n+=3;
  if(s.pe&&s.pe>0&&s.pe<200){
    n+=8;
    if(s.pe<12)n+=20;else if(s.pe<18)n+=15;else if(s.pe<25)n+=10;else if(s.pe<35)n+=5;
  }
  if(s.fromHi>3&&s.fromHi<15)n+=10;else if(s.fromHi>=15&&s.fromHi<30)n+=5;else if(s.fromHi>=30&&s.fromHi<50)n+=2;
  if(s.volume>10e6)n+=8;else if(s.volume>1e6)n+=4;else if(s.volume>100e3)n+=1;
  if(s.loPct>25&&s.loPct<80)n+=4;
  return Math.round(n);
}
 
// ── SSE helper ────────────────────────────────────────────────────────────────
function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
 
// ── Simple 30-min result cache (serves SSE clients that reconnect quickly) ───
let _cache = { data: null, ts: 0 };
const TTL = 30 * 60 * 1000;
 
export default async function handler(req, res) {
  // Legacy GET without SSE: serve from cache if fresh, else stream
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
 
  // If cache is fresh, send it immediately and close
  if (_cache.data && Date.now() - _cache.ts < TTL) {
    sseWrite(res, 'candidates', _cache.data);
    sseWrite(res, 'done', { totalScanned: _cache.data.totalScanned, fromCache: true });
    res.end();
    return;
  }
 
  const BATCH = 50;         // parallel Yahoo requests per wave
  const TOP_N = 20;         // candidates forwarded to deep analysis
  const scored = new Map(); // symbol → scored quick result
  const stockMeta = {};
  let totalScanned = 0;
 
  // Process universe in batches; emit updated candidates after each wave
  const batches = [];
  for (let i = 0; i < UNIQ.length; i += BATCH) batches.push(UNIQ.slice(i, i + BATCH));
 
  for (const batch of batches) {
    if (res.writableEnded) break; // client disconnected
 
    const results = (await Promise.all(batch.map(fetchQuick))).filter(Boolean);
    totalScanned += results.length;
 
    for (const s of results) {
      scored.set(s.symbol, { ...s, qs: quickScore(s) });
      if (s.exchange) stockMeta[s.symbol] = { exchange: s.exchange };
    }
 
    // Re-rank and emit current top-20
    const sorted = [...scored.values()].sort((a, b) => b.qs - a.qs);
    const candidates = sorted.slice(0, TOP_N).map(s => s.symbol);
 
    const payload = {
      candidates,
      stockMeta,
      totalScanned,
      totalUniverse: UNIQ.length,
      complete: false,
    };
 
    sseWrite(res, 'candidates', payload);
  }
 
  // Final emit
  const sorted = [...scored.values()].sort((a, b) => b.qs - a.qs);
  const candidates = sorted.slice(0, TOP_N).map(s => s.symbol);
  const finalPayload = { candidates, stockMeta, totalScanned, totalUniverse: UNIQ.length, complete: true };
 
  _cache = { data: finalPayload, ts: Date.now() };
 
  sseWrite(res, 'candidates', finalPayload);
  sseWrite(res, 'done', { totalScanned, totalUniverse: UNIQ.length });
  res.end();
}
 
