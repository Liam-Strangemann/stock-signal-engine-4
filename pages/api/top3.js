// pages/api/top3.js
//
// Uses Yahoo Finance bulk quote endpoint - no API key needed.
// 234 tickers fetched in 3 parallel requests (~1-2s total).
// Then full detail on top 3 candidates only (~2-3s).
// Total: under 5 seconds.
 
const TICKERS = [
  'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','AVGO','ORCL','ADBE',
  'CRM','AMD','QCOM','TXN','INTC','MU','AMAT','KLAC','LRCX','MCHP',
  'ADI','NXPI','CDNS','SNPS','FTNT','PANW','CRWD','NOW','SNOW','PLTR',
  'JPM','BAC','WFC','GS','MS','BLK','C','AXP','SCHW','USB',
  'PNC','TFC','COF','MET','PRU','AFL','ALL','TRV','AIG','MCO',
  'SPGI','ICE','CME','MSCI','CBOE',
  'LLY','JNJ','UNH','ABBV','MRK','PFE','TMO','ABT','AMGN','CVS',
  'MDT','ISRG','GILD','REGN','VRTX','BSX','SYK','EW','DXCM','IDXX',
  'IQV','MCK','ELV','CI','HUM','HCA',
  'HD','MCD','NKE','SBUX','LOW','TGT','COST','BKNG','MAR','HLT',
  'YUM','CMG','DPZ','ROST','TJX','GM','F','UBER',
  'WMT','KO','PEP','PG','PM','MO','MDLZ','CL','KMB','GIS','STZ',
  'XOM','CVX','COP','EOG','SLB','OXY','DVN','HAL','MPC','PSX','VLO','BKR',
  'GE','HON','CAT','DE','BA','LMT','RTX','NOC','GD','UPS',
  'FDX','MMM','EMR','ETN','PH','ITW','ROK','NSC','UNP','CSX',
  'LIN','APD','SHW','ECL','NEM','FCX','NUE','VMC','MLM','DOW',
  'NEE','DUK','SO','D','AEP','EXC','SRE','CEG',
  'PLD','AMT','EQIX','CCI','PSA','O','WELL','AVB','DLR',
  'NFLX','DIS','CMCSA','T','VZ','TMUS','CHTR',
  'V','MA','PYPL','ACN','IBM','FICO','ROP','VRSK',
  'DHR','SPGI','ZTS','IDXX','MTD','BIO','A','ILMN',
  'NKE','LULU','PVH','HBI','RL','TPR','VFC',
  'ABNB','EXPE','LYFT','UAL','DAL','AAL','LUV','CCL','RCL','NCLH',
];
 
const UNIQ_TICKERS = Array.from(new Set(TICKERS)).filter(function(t){ return t && t.length <= 5; });
 
async function yahooQuoteBatch(tickers) {
  var fields = 'symbol,shortName,regularMarketPrice,regularMarketChangePercent,marketCap,trailingPE,fiftyDayAverage,fiftyTwoWeekHigh,fiftyTwoWeekLow,epsTrailingTwelveMonths,averageAnalystRating';
  var url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + tickers.join('%2C') + '&fields=' + fields + '&formatted=false&lang=en-US';
  var res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://finance.yahoo.com',
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error('Yahoo ' + res.status);
  var json = await res.json();
  var quotes = json && json.quoteResponse && json.quoteResponse.result;
  if (!Array.isArray(quotes)) throw new Error('Bad Yahoo response');
  return quotes;
}
 
function scoreQuote(q) {
  if (!q || !q.symbol) return null;
  var px   = q.regularMarketPrice;
  var pe   = q.trailingPE;
  var ma50 = q.fiftyDayAverage;
  var hi   = q.fiftyTwoWeekHigh;
  var lo   = q.fiftyTwoWeekLow;
  var eps  = q.epsTrailingTwelveMonths;
  if (!px || px <= 0) return null;
 
  var score = 0;
  if (pe && pe > 0 && pe < 200 && eps && eps > 0 && hi && lo) {
    var histPE = ((hi + lo) / 2) / eps;
    if (pe < histPE * 0.92) score++;
  }
  if (ma50 && px <= ma50) score++;
  if (pe && pe > 0 && pe < 25) score++;
  if (hi && lo) {
    var mid = (hi + lo) / 2;
    if (px < mid) score++;
  }
 
  return {
    ticker: q.symbol, company: q.shortName || q.symbol,
    score: score, px: px, pe: pe, ma50: ma50,
    chg: q.regularMarketChangePercent, mc: q.marketCap,
    hi52: hi, lo52: lo, eps: eps,
    analystRating: q.averageAnalystRating || null,
  };
}
 
async function getTargetPrice(ticker) {
  try {
    var r = await fetch(
      'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + ticker + '?modules=financialData',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.yahoo.com' }, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return null;
    var j = await r.json();
    var fd = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0] && j.quoteSummary.result[0].financialData;
    return (fd && ((fd.targetMedianPrice && fd.targetMedianPrice.raw) || (fd.targetMeanPrice && fd.targetMeanPrice.raw))) || null;
  } catch(_) { return null; }
}
 
async function getInsider(ticker) {
  try {
    var cutoff = Date.now() - 30 * 86400000;
    var r = await fetch(
      'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + ticker + '?modules=insiderTransactions',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.yahoo.com' }, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return { buys: [], sells: [] };
    var j = await r.json();
    var txns = (j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0] && j.quoteSummary.result[0].insiderTransactions && j.quoteSummary.result[0].insiderTransactions.transactions) || [];
    var buys = [], sells = [];
    for (var i = 0; i < txns.length; i++) {
      var t = txns[i];
      var ts = t.startDate && t.startDate.raw;
      if (!ts || ts * 1000 < cutoff) continue;
      var desc = (t.transactionDescription || '').toLowerCase();
      var shares = Math.abs((t.shares && t.shares.raw) || 0);
      var value  = Math.abs((t.value  && t.value.raw)  || 0);
      var entry  = { date: new Date(ts*1000).toISOString().slice(0,10), shares: shares, value: value };
      if (/purchase|buy/i.test(desc)) buys.push(entry);
      else if (/sale|sell/i.test(desc)) sells.push(entry);
    }
    return { buys: buys, sells: sells };
  } catch(_) { return { buys: [], sells: [] }; }
}
 
async function get50dMA(ticker, fallback) {
  try {
    var now = Math.floor(Date.now() / 1000);
    var r = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/' + ticker + '?interval=1d&period1=' + (now - 100*86400) + '&period2=' + now,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.yahoo.com' }, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return fallback;
    var j = await r.json();
    var closes = (j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].indicators && j.chart.result[0].indicators.quote && j.chart.result[0].indicators.quote[0] && j.chart.result[0].indicators.quote[0].close) || [];
    var clean = closes.filter(function(c){ return c != null && !isNaN(c); });
    if (clean.length < 10) return fallback;
    var sl = clean.slice(-50);
    return sl.reduce(function(a,b){return a+b;},0) / sl.length;
  } catch(_) { return fallback; }
}
 
async function buildFullResult(q) {
  var ticker = q.ticker;
  var px     = q.px;
 
  var settled = await Promise.allSettled([
    getTargetPrice(ticker),
    getInsider(ticker),
    get50dMA(ticker, q.ma50),
  ]);
 
  var tgt    = (settled[0].status === 'fulfilled') ? settled[0].value : null;
  var ins    = (settled[1].status === 'fulfilled') ? settled[1].value : { buys: [], sells: [] };
  var ma50   = (settled[2].status === 'fulfilled') ? settled[2].value : q.ma50;
 
  var mc = q.mc || 0;
  var mcs = mc > 1e12 ? '$'+(mc/1e12).toFixed(2)+'T' : mc > 1e9 ? '$'+(mc/1e9).toFixed(1)+'B' : mc > 1e6 ? '$'+(mc/1e6).toFixed(0)+'M' : '';
 
  // s1 analyst rating
  var s1 = { status: 'neutral', value: 'No data' };
  if (q.analystRating) {
    try {
      var parts = q.analystRating.split(':');
      var sc = parseFloat(parts[0]);
      var lbl = (parts[1] || '').trim();
      s1 = sc <= 2.0 ? { status:'pass', value:'Rating: '+lbl+' ('+sc.toFixed(1)+')' }
         : sc >= 3.5 ? { status:'fail', value:'Rating: '+lbl+' ('+sc.toFixed(1)+')' }
         :              { status:'neutral', value:'Rating: '+lbl+' ('+sc.toFixed(1)+')' };
    } catch(_) {}
  }
 
  // s2 PE vs hist
  var s2 = { status: 'neutral', value: 'No data' };
  try {
    var pe = q.pe; var eps = q.eps; var hi = q.hi52; var lo = q.lo52;
    if (pe && pe > 0 && eps && eps > 0 && hi && lo) {
      var histPE = ((hi+lo)/2)/eps;
      s2 = pe < histPE*0.92 ? { status:'pass',    value:'PE '+pe.toFixed(1)+'x < hist ~'+histPE.toFixed(0)+'x' }
         : pe > histPE*1.08 ? { status:'fail',    value:'PE '+pe.toFixed(1)+'x > hist ~'+histPE.toFixed(0)+'x' }
         :                     { status:'neutral', value:'PE '+pe.toFixed(1)+'x ~ hist '+histPE.toFixed(0)+'x' };
    } else if (pe && pe > 0) {
      s2 = { status:'neutral', value:'PE '+pe.toFixed(1)+'x' };
    }
  } catch(_) {}
 
  // s3 50d MA
  var s3 = { status: 'neutral', value: 'No data' };
  try {
    if (ma50 && px) {
      var pct = ((px-ma50)/ma50*100).toFixed(1);
      s3 = px <= ma50 ? { status:'pass', value:'$'+px.toFixed(2)+' <= MA $'+ma50.toFixed(2)+' ('+pct+'%)' }
                      : { status:'fail', value:'$'+px.toFixed(2)+' > MA $'+ma50.toFixed(2)+' (+'+pct+'%)' };
    }
  } catch(_) {}
 
  // s4 insider
  var s4 = { status: 'neutral', value: 'No data' };
  try {
    var buys = ins.buys || []; var sells = ins.sells || [];
    if (buys.length > 0) {
      var tv = buys.reduce(function(s,t){return s+t.value;},0);
      var fv = tv > 1e6 ? '$'+(tv/1e6).toFixed(1)+'M' : tv > 1e3 ? '$'+(tv/1e3).toFixed(0)+'K' : '';
      var days = buys[0] ? Math.floor((Date.now()-new Date(buys[0].date).getTime())/86400000) : null;
      var ago = days!=null?(days===0?'today':days<7?days+'d ago':Math.floor(days/7)+'w ago'):null;
      s4 = { status:'pass', value:buys.length+' buy'+(buys.length>1?'s':'')+(fv?' '+fv:'')+(ago?' - '+ago:'') };
    } else if (sells.length > 0) {
      s4 = { status:'fail', value:sells.length+' sell'+(sells.length>1?'s':'')+', no buys' };
    } else {
      s4 = { status:'neutral', value:'No activity (30d)' };
    }
  } catch(_) {}
 
  // s5 analyst target
  var s5 = { status: 'neutral', value: 'No data' };
  try {
    if (tgt && px) {
      var up = ((tgt-px)/px*100).toFixed(1);
      s5 = parseFloat(up) >= 25 ? { status:'pass', value:'Target $'+tgt.toFixed(2)+', +'+up+'% upside' }
                                 : { status:'fail', value:'Target $'+tgt.toFixed(2)+', +'+up+'% upside' };
    }
  } catch(_) {}
 
  // s6 52wk range position
  var s6 = { status: 'neutral', value: 'No data' };
  try {
    if (q.hi52 && q.lo52 && px) {
      var range = q.hi52 - q.lo52;
      if (range > 0) {
        var pos = Math.round((px - q.lo52) / range * 100);
        s6 = pos <= 35 ? { status:'pass',    value:'Bottom '+pos+'% of 52wk range' }
           : pos >= 80 ? { status:'fail',    value:'Top '+(100-pos)+'% of 52wk range' }
           :              { status:'neutral', value:pos+'% of 52wk range' };
      }
    }
  } catch(_) {}
 
  var signals = [s1,s2,s3,s4,s5,s6];
  var score   = signals.filter(function(s){return s.status==='pass';}).length;
  var NAMES   = ['Analyst rating','PE vs hist','Below 50d MA','Insider buying','Analyst target','52wk position'];
  var passes  = signals.map(function(s,i){return s.status==='pass'?NAMES[i]:null;}).filter(Boolean);
 
  var summary = score>=5 ? 'Strong candidate -- '+score+'/6 signals pass. '+passes.join(', ')+'.'
              : score>=4 ? 'Good signals ('+score+'/6). Passes: '+passes.join(', ')+'.'
              : score>=3 ? 'Moderate signals ('+score+'/6). Passes: '+passes.join(', ')+'.'
              : 'Weak signals ('+score+'/6).';
 
  var rating = score>=5?{label:'Strong Buy',color:'#4A6741',bg:'#DDE8D8',border:'#A8C0A0'}
             : score>=4?{label:'Buy',color:'#4A6741',bg:'#E8EEDF',border:'#B0C8A8'}
             : score>=3?{label:'Watch',color:'#7A6030',bg:'#F0E8D0',border:'#C8A870'}
             : {label:'Ignore',color:'#5F5E56',bg:'#E8E5DC',border:'rgba(95,94,86,0.4)'};
 
  return {
    ticker: ticker, company: q.company,
    price:  '$'+px.toFixed(2),
    change: q.chg!=null?(q.chg>0?'+':'')+q.chg.toFixed(2)+'%':null,
    marketCap: mcs, score: score, signals: signals, summary: summary, rating: rating,
    updatedAt: new Date().toISOString()
  };
}
 
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
 
  try {
    var startTime = Date.now();
 
    // Phase 1: 3 parallel bulk requests, 80 tickers each (~1-2s)
    var batchSize = 80;
    var batches = [];
    for (var i = 0; i < UNIQ_TICKERS.length; i += batchSize) {
      batches.push(UNIQ_TICKERS.slice(i, i + batchSize));
    }
 
    var batchResults = await Promise.allSettled(batches.map(yahooQuoteBatch));
 
    var allQuotes = [];
    batchResults.forEach(function(r) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        for (var i = 0; i < r.value.length; i++) allQuotes.push(r.value[i]);
      }
    });
 
    if (allQuotes.length === 0) {
      return res.status(200).json({ top3:[], scannedAt:new Date().toISOString(), totalScanned:0, error:'No data from Yahoo Finance' });
    }
 
    // Phase 2: score all quotes (pure JS, instant)
    var scored = [];
    for (var i = 0; i < allQuotes.length; i++) {
      var s = scoreQuote(allQuotes[i]);
      if (s) scored.push(s);
    }
    scored.sort(function(a,b){return b.score-a.score;});
 
    // Phase 3: full detail on top 3 in parallel (~2-3s)
    var candidates = scored.slice(0,3);
    var fullSettled = await Promise.allSettled(candidates.map(buildFullResult));
 
    var top3 = fullSettled
      .filter(function(r){return r.status==='fulfilled'&&r.value;})
      .map(function(r){return r.value;})
      .sort(function(a,b){return (b.score||0)-(a.score||0);});
 
    var elapsed = ((Date.now()-startTime)/1000).toFixed(1);
 
    res.setHeader('Cache-Control','s-maxage=1800, stale-while-revalidate');
    return res.status(200).json({ top3:top3, scannedAt:new Date().toISOString(), totalScanned:scored.length, elapsed:elapsed+'s' });
 
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
 
var UNIQ_TICKERS = Array.from(new Set(TICKERS)).filter(function(t){ return t && t.length <= 5; });
 
