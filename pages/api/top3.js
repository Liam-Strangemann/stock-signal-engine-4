// pages/api/top3.js
// Phase 1: quick 2-call screen on 60 curated tickers (2 batches x 30 = ~5s total)
// Phase 2: full analyse on top 3 candidates only (parallel, ~3s)
// Total target time: under 10 seconds
 
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const FH = 'https://finnhub.io/api/v1';
 
// 60 high-quality tickers chosen for excellent Finnhub free-tier data coverage
// Spread across all major S&P 500 sectors, all large/mega cap
const WATCHLIST = [
  // Mega-cap tech
  'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','AVGO','ORCL','ADBE',
  // Tech
  'AMD','QCOM','TXN','MU','CRM','INTC','NOW','AMAT',
  // Finance
  'JPM','BAC','WFC','GS','MS','BLK','AXP','SCHW','C','USB',
  // Healthcare
  'LLY','JNJ','UNH','ABBV','MRK','PFE','TMO','AMGN','CVS','ISRG',
  // Consumer
  'HD','MCD','NKE','COST','WMT','SBUX','LOW','TGT',
  // Energy
  'XOM','CVX','COP','EOG','SLB','OXY',
  // Industrials
  'CAT','HON','GE','BA','UPS','MMM',
  // Other
  'KO','PEP','PG','NEE','DIS','NFLX','T','VZ',
];
 
function sleep(ms) { return new Promise(function(r){ setTimeout(r,ms); }); }
 
async function fh(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(FH + path + sep + 'token=' + FINNHUB_KEY, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(6000)
  });
  if (!res.ok) throw new Error('Finnhub ' + res.status);
  const data = await res.json();
  if (data && data.error) throw new Error(data.error);
  return data;
}
 
// Phase 1: 2 API calls per ticker, returns a quick score 0-4
async function quickScreen(ticker) {
  try {
    const [q, met] = await Promise.all([
      fh('/quote?symbol=' + ticker),
      fh('/stock/metric?symbol=' + ticker + '&metric=all')
    ]);
    const px = q && q.c;
    if (!px || px <= 0) return null;
    const m = (met && met.metric) || {};
    let score = 0;
 
    const curPE = m.peBasicExclExtraTTM || m.peTTM;
    const eps   = m.epsBasicExclExtraAnnual || m.epsTTM;
    const hi    = m['52WeekHigh'];
    const lo    = m['52WeekLow'];
    if (curPE && eps > 0 && hi && lo) {
      const histPE = ((hi + lo) / 2) / eps;
      if (curPE < histPE * 0.92) score++;
    }
    const ma50 = m['50DayMA'] || m['50DayMovingAvg'];
    if (ma50 && px <= ma50) score++;
    const qg = m.epsGrowthQuarterlyYoy;
    if (qg != null && qg > 0) score++;
    if (curPE && curPE > 0 && curPE < 22) score++;
 
    return { ticker: ticker, score: score, px: px };
  } catch(_) { return null; }
}
 
// Phase 2 helpers
async function maFromFinnhub(ticker) {
  try {
    const d = await fh('/stock/candle?symbol=' + ticker + '&resolution=D&count=60');
    if (d && d.s === 'ok' && Array.isArray(d.c) && d.c.length >= 10) {
      const sl = d.c.slice(-50);
      return sl.reduce(function(a,b){return a+b;},0) / sl.length;
    }
  } catch(_) {}
  try {
    const now = Math.floor(Date.now()/1000);
    const r = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/'+ticker+'?interval=1d&period1='+(now-100*86400)+'&period2='+now,
      { headers:{'User-Agent':'Mozilla/5.0'}, signal: AbortSignal.timeout(4000) }
    );
    if (r.ok) {
      const j = await r.json();
      const closes = j&&j.chart&&j.chart.result&&j.chart.result[0]&&
        j.chart.result[0].indicators&&j.chart.result[0].indicators.quote&&
        j.chart.result[0].indicators.quote[0]&&j.chart.result[0].indicators.quote[0].close||[];
      const clean = closes.filter(function(c){return c!=null&&!isNaN(c);});
      if (clean.length >= 10) {
        const sl = clean.slice(-50);
        return sl.reduce(function(a,b){return a+b;},0)/sl.length;
      }
    }
  } catch(_) {}
  return null;
}
 
async function analystTarget(ticker) {
  try {
    const r = await fetch(
      'https://query1.finance.yahoo.com/v10/finance/quoteSummary/'+ticker+'?modules=financialData',
      { headers:{'User-Agent':'Mozilla/5.0'}, signal: AbortSignal.timeout(4000) }
    );
    if (r.ok) {
      const j = await r.json();
      const fd = j&&j.quoteSummary&&j.quoteSummary.result&&j.quoteSummary.result[0]&&
        j.quoteSummary.result[0].financialData;
      const t = (fd&&fd.targetMedianPrice&&fd.targetMedianPrice.raw)||
                (fd&&fd.targetMeanPrice&&fd.targetMeanPrice.raw);
      if (t && t > 0) return t;
    }
  } catch(_) {}
  return null;
}
 
// Phase 2: full 6-signal analysis on a single ticker
async function fullAnalyse(ticker) {
  try {
    const now    = Math.floor(Date.now()/1000);
    const from30 = new Date((now-30*86400)*1000).toISOString().slice(0,10);
    const to30   = new Date(now*1000).toISOString().slice(0,10);
 
    const [quote, profile, metrics, earnings, insider, target, ma50] = await Promise.allSettled([
      fh('/quote?symbol='+ticker),
      fh('/stock/profile2?symbol='+ticker),
      fh('/stock/metric?symbol='+ticker+'&metric=all'),
      fh('/stock/earnings?symbol='+ticker+'&limit=4'),
      fh('/stock/insider-transactions?symbol='+ticker+'&from='+from30+'&to='+to30),
      analystTarget(ticker),
      maFromFinnhub(ticker)
    ]);
 
    const q  = (quote.status==='fulfilled' && quote.value) || {};
    const p  = (profile.status==='fulfilled' && profile.value) || {};
    const m  = ((metrics.status==='fulfilled' && metrics.value && metrics.value.metric)) || {};
    const px = q.c;
    if (!px) return null;
 
    const company = p.name || ticker;
    const mc  = (p.marketCapitalization||0)*1e6;
    const mcs = mc>1e12?'$'+(mc/1e12).toFixed(2)+'T':mc>1e9?'$'+(mc/1e9).toFixed(1)+'B':mc>1e6?'$'+(mc/1e6).toFixed(0)+'M':'';
 
    // s1 EPS beat
    let s1 = {status:'neutral',value:'No data'};
    try {
      const earns = (earnings.status==='fulfilled'&&Array.isArray(earnings.value))?earnings.value:[];
      if (earns.length > 0) {
        const e = earns[0];
        const diff = e.actual - e.estimate;
        const beat = diff >= 0;
        const ds = Math.abs(diff)<0.005?'in-line':beat?'+$'+Math.abs(diff).toFixed(2):'-$'+Math.abs(diff).toFixed(2);
        s1 = { status:beat?'pass':'fail', value:beat?'Beat by '+ds:'Missed '+ds };
      }
    } catch(_){}
 
    // s2 PE vs historical
    let s2 = {status:'neutral',value:'No data'};
    try {
      const curPE = m.peBasicExclExtraTTM||m.peTTM;
      const eps   = m.epsBasicExclExtraAnnual||m.epsTTM;
      const hi    = m['52WeekHigh']; const lo = m['52WeekLow'];
      if (curPE && eps>0 && hi && lo) {
        const histPE = ((hi+lo)/2)/eps;
        if (curPE < histPE*0.92)      s2={status:'pass',   value:'PE '+curPE.toFixed(1)+'x < hist ~'+histPE.toFixed(0)+'x'};
        else if (curPE > histPE*1.08) s2={status:'fail',   value:'PE '+curPE.toFixed(1)+'x > hist ~'+histPE.toFixed(0)+'x'};
        else                          s2={status:'neutral',value:'PE '+curPE.toFixed(1)+'x ~ hist '+histPE.toFixed(0)+'x'};
      } else if (curPE) {
        s2={status:'neutral',value:'PE '+curPE.toFixed(1)+'x'};
      }
    } catch(_){}
 
    // s3 50d MA
    let s3 = {status:'neutral',value:'No data'};
    try {
      const maVal = (ma50.status==='fulfilled') ? ma50.value : null;
      if (maVal && px) {
        const pct = ((px-maVal)/maVal*100).toFixed(1);
        s3 = px<=maVal
          ? {status:'pass', value:'$'+px.toFixed(2)+' <= MA $'+maVal.toFixed(2)+' ('+pct+'%)'}
          : {status:'fail', value:'$'+px.toFixed(2)+' > MA $'+maVal.toFixed(2)+' (+'+pct+'%)'};
      }
    } catch(_){}
 
    // s4 insider buying
    let s4 = {status:'neutral',value:'No data'};
    try {
      const txns = (insider.status==='fulfilled'&&insider.value&&insider.value.data)||[];
      const buys  = txns.filter(function(t){return t.transactionCode==='P';});
      const sells = txns.filter(function(t){return t.transactionCode==='S';});
      const bv = buys.reduce(function(s,t){return s+Math.abs((t.share||0)*(t.transactionPrice||px||0));},0);
      if (buys.length > 0) {
        const fv = bv>1e6?'$'+(bv/1e6).toFixed(1)+'M':bv>1e3?'$'+(bv/1e3).toFixed(0)+'K':'$'+bv.toFixed(0);
        const dates = buys.map(function(t){return t.transactionDate;}).filter(Boolean).sort().reverse();
        const days  = dates[0] ? Math.floor((Date.now()-new Date(dates[0]).getTime())/86400000) : null;
        const ago   = days!=null?(days===0?'today':days<7?days+'d ago':Math.floor(days/7)+'w ago'):null;
        s4 = {status:'pass', value:buys.length+' buy'+(buys.length>1?'s':'')+' '+fv+(ago?' - '+ago:'')};
      } else if (sells.length > 0) {
        s4 = {status:'fail', value:sells.length+' sell'+(sells.length>1?'s':'')+', no buys'};
      } else {
        s4 = {status:'neutral', value:'No activity (30d)'};
      }
    } catch(_){}
 
    // s5 analyst target
    let s5 = {status:'neutral',value:'No data'};
    try {
      const tgt = (target.status==='fulfilled') ? target.value : null;
      if (tgt && px) {
        const up = ((tgt-px)/px*100).toFixed(1);
        s5 = parseFloat(up)>=25
          ? {status:'pass', value:'Target $'+tgt.toFixed(2)+', +'+up+'% upside'}
          : {status:'fail', value:'Target $'+tgt.toFixed(2)+', +'+up+'% upside'};
      }
    } catch(_){}
 
    // s6 peer PE placeholder (skipped to save rate limit)
    const s6 = {status:'neutral',value:'See full scan'};
 
    const signals = [s1,s2,s3,s4,s5,s6];
    const score   = signals.filter(function(s){return s.status==='pass';}).length;
    const passes  = signals.map(function(s,i){
      return s.status==='pass'?['EPS beat','Low PE','Below 50d MA','Insider buying','Analyst upside','PE vs peers'][i]:null;
    }).filter(Boolean);
 
    let summary;
    if (score>=5)      summary = 'Strong value candidate -- '+score+'/6 signals pass. Strengths: '+passes.join(', ')+'.';
    else if (score>=4) summary = 'Good signals ('+score+'/6). Passes: '+passes.join(', ')+'.';
    else if (score>=3) summary = 'Moderate signals ('+score+'/6). Passes: '+passes.join(', ')+'.';
    else               summary = 'Weak signals ('+score+'/6).';
 
    const rating = score>=5 ? {label:'Strong Buy',color:'#4A6741',bg:'#DDE8D8',border:'#A8C0A0'}
                 : score>=4 ? {label:'Buy',color:'#4A6741',bg:'#E8EEDF',border:'#B0C8A8'}
                 : score>=3 ? {label:'Watch',color:'#7A6030',bg:'#F0E8D0',border:'#C8A870'}
                 : {label:'Ignore',color:'#5F5E56',bg:'#E8E5DC',border:'rgba(95,94,86,0.4)'};
 
    return { ticker, company, price:'$'+px.toFixed(2),
      change: q.dp!=null?(q.dp>0?'+':'')+q.dp.toFixed(2)+'%':null,
      marketCap: mcs, score, signals, summary, rating,
      updatedAt: new Date().toISOString() };
  } catch(_) { return null; }
}
 
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({error:'GET only'});
  if (!FINNHUB_KEY)         return res.status(500).json({error:'FINNHUB_KEY not set'});
 
  try {
    // Phase 1: quick screen in 2 batches of 30 (~1.2s sleep between = ~6s total)
    const BATCH = 30;
    const allQuick = [];
 
    for (let i=0; i<WATCHLIST.length; i+=BATCH) {
      const batch   = WATCHLIST.slice(i, i+BATCH);
      const settled = await Promise.allSettled(batch.map(quickScreen));
      settled.forEach(function(r){
        if (r.status==='fulfilled' && r.value) allQuick.push(r.value);
      });
      if (i+BATCH < WATCHLIST.length) await sleep(600);
    }
 
    // Pick top 3 candidates by quick score
    allQuick.sort(function(a,b){ return b.score-a.score; });
    const candidates = allQuick.slice(0,3).map(function(c){return c.ticker;});
 
    // Phase 2: full parallel analyse on top 3 only (~3s)
    const fullResults = await Promise.allSettled(candidates.map(fullAnalyse));
    const top3 = fullResults
      .filter(function(r){return r.status==='fulfilled' && r.value;})
      .map(function(r){return r.value;})
      .sort(function(a,b){return (b.score||0)-(a.score||0);});
 
    res.setHeader('Cache-Control','s-maxage=1800, stale-while-revalidate');
    return res.status(200).json({
      top3, scannedAt: new Date().toISOString(), totalScanned: allQuick.length
    });
  } catch(e) {
    return res.status(500).json({error:e.message});
  }
}
 
