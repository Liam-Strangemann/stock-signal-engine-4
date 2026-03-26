// pages/api/top3.js
//
// GET  — returns cached result instantly if available
// POST { tickers: string[], totalScanned: number }
//       — receives top candidates from browser scan, runs Finnhub enrichment
//
// Only 3 stocks × ~8 Finnhub calls = 24 total, all parallel, done in ~4s.
// Well within Vercel's 10s limit.
 
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const FH = 'https://finnhub.io/api/v1';
 
const EXCHANGE_MAP = {
  AAPL:'NASDAQ',MSFT:'NASDAQ',GOOGL:'NASDAQ',AMZN:'NASDAQ',META:'NASDAQ',NVDA:'NASDAQ',AVGO:'NASDAQ',ORCL:'NYSE',ADBE:'NASDAQ',INTU:'NASDAQ',AMD:'NASDAQ',INTC:'NASDAQ',QCOM:'NASDAQ',TXN:'NASDAQ',AMAT:'NASDAQ',MU:'NASDAQ',NOW:'NYSE',CRM:'NYSE',PANW:'NASDAQ',CSCO:'NASDAQ',IBM:'NYSE',HPQ:'NYSE',KLAC:'NASDAQ',LRCX:'NASDAQ',SNPS:'NASDAQ',CDNS:'NASDAQ',JPM:'NYSE',BAC:'NYSE',WFC:'NYSE',GS:'NYSE',MS:'NYSE',BLK:'NYSE',C:'NYSE',AXP:'NYSE',SCHW:'NYSE',USB:'NYSE',PNC:'NYSE',TFC:'NYSE',COF:'NYSE',DFS:'NYSE',AIG:'NYSE',MET:'NYSE',PRU:'NYSE',AFL:'NYSE',CB:'NYSE',TRV:'NYSE',CME:'NASDAQ',ICE:'NYSE',SPGI:'NYSE',MCO:'NYSE',MA:'NYSE',V:'NYSE',LLY:'NYSE',JNJ:'NYSE',UNH:'NYSE',ABBV:'NYSE',MRK:'NYSE',PFE:'NYSE',TMO:'NYSE',ABT:'NYSE',AMGN:'NASDAQ',CVS:'NYSE',MDT:'NYSE',ISRG:'NASDAQ',BSX:'NYSE',SYK:'NYSE',REGN:'NASDAQ',BIIB:'NASDAQ',VRTX:'NASDAQ',XOM:'NYSE',CVX:'NYSE',COP:'NYSE',EOG:'NYSE',SLB:'NYSE',MPC:'NYSE',PSX:'NYSE',VLO:'NYSE',OXY:'NYSE',DVN:'NYSE',HAL:'NYSE',BKR:'NYSE',HD:'NYSE',MCD:'NYSE',NKE:'NYSE',SBUX:'NASDAQ',LOW:'NYSE',TGT:'NYSE',COST:'NASDAQ',WMT:'NYSE',BKNG:'NASDAQ',MAR:'NASDAQ',CAT:'NYSE',HON:'NASDAQ',MMM:'NYSE',GE:'NYSE',RTX:'NYSE',LMT:'NYSE',NOC:'NYSE',GD:'NYSE',UPS:'NYSE',FDX:'NYSE',UNP:'NYSE',CSX:'NASDAQ',NSC:'NYSE',DE:'NYSE',KO:'NYSE',PEP:'NASDAQ',PG:'NYSE',PM:'NYSE',MO:'NYSE',T:'NYSE',VZ:'NYSE',TMUS:'NASDAQ',NEE:'NYSE',LIN:'NYSE',APD:'NYSE',ECL:'NYSE',NEM:'NYSE',FCX:'NYSE',AMT:'NYSE',PLD:'NYSE',EQIX:'NASDAQ',CCI:'NYSE',SPG:'NYSE',TSM:'NYSE',ASML:'NASDAQ',NVO:'NYSE',SAP:'NYSE',TM:'NYSE',AZN:'NASDAQ',HSBC:'NYSE',SHEL:'NYSE',BHP:'NYSE',RIO:'NYSE',
};
 
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 60 * 60 * 1000;
 
async function fh(path) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${FH}${path}${sep}token=${FINNHUB_KEY}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error(`FH ${r.status}`);
  const d = await r.json();
  if (d?.error) throw new Error(d.error);
  return d;
}
 
function fmtD(n) { if (!n) return null; if (n>=1e9) return `$${(n/1e9).toFixed(1)}B`; if (n>=1e6) return `$${(n/1e6).toFixed(0)}M`; return null; }
function fmtS(n) { if (!n) return null; if (n>=1e6) return `${(n/1e6).toFixed(1)}M sh`; if (n>=1e3) return `${(n/1e3).toFixed(0)}K sh`; return null; }
function ago(d) { if (!d) return null; const days=Math.floor((Date.now()-new Date(d).getTime())/86400000); if (days<1) return 'today'; if (days<7) return `${days}d ago`; if (days<30) return `${Math.floor(days/7)}w ago`; return `${Math.floor(days/30)}mo ago`; }
 
async function getInsider(ticker, px) {
  const now=Math.floor(Date.now()/1000), cutoff=new Date((now-60*86400)*1000);
  const from=cutoff.toISOString().slice(0,10), to=new Date(now*1000).toISOString().slice(0,10);
  // Yahoo first
  try {
    const r=await fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=insiderTransactions`,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(5000)});
    if (r.ok) {
      const j=await r.json(), txns=j?.quoteSummary?.result?.[0]?.insiderTransactions?.transactions||[];
      const buys=[],sells=[];
      for (const t of txns) {
        const ts=t.startDate?.raw; if (!ts||new Date(ts*1000)<cutoff) continue;
        const ds=new Date(ts*1000).toISOString().slice(0,10);
        const sh=Math.abs(t.shares?.raw||0),val=Math.abs(t.value?.raw||0),desc=(t.transactionDescription||'').toLowerCase();
        const e={transactionDate:ds,share:sh,value:val,transactionPrice:sh>0?val/sh:px};
        if (/purchase|buy/i.test(desc)) buys.push(e); else if (/sale|sell/i.test(desc)) sells.push(e);
      }
      if (buys.length||sells.length) return {buys,sells,src:'yahoo'};
    }
  } catch(_) {}
  // Finnhub
  try {
    const d=await fh(`/stock/insider-transactions?symbol=${ticker}&from=${from}&to=${to}`);
    const b=(d?.data||[]).filter(t=>t.transactionCode==='P'), s=(d?.data||[]).filter(t=>t.transactionCode==='S');
    if (b.length||s.length) return {buys:b,sells:s,src:'finnhub'};
  } catch(_) {}
  // SEC
  try {
    const r=await fetch(`https://efts.sec.gov/LATEST/search-index?q=%22${ticker}%22&dateRange=custom&startdt=${from}&enddt=${to}&forms=4`,{headers:{'User-Agent':'signal-engine/1.0'},signal:AbortSignal.timeout(5000)});
    if (r.ok) { const j=await r.json(), hits=(j?.hits?.hits||[]).filter(h=>(h._source?.form_type||'').toUpperCase()==='4'&&new Date(h._source?.file_date)>=cutoff); if (hits.length) return {buys:hits.slice(0,5).map(h=>({transactionDate:h._source.file_date,share:0,value:0,transactionPrice:px})),sells:[],src:'sec'}; }
  } catch(_) {}
  return {buys:[],sells:[],src:null};
}
 
function insiderSig(buys,sells,src) {
  if (buys.length) {
    if (src==='sec') { const rc=ago(buys[0].transactionDate); return {status:'pass',value:`Form 4 · ${buys.length} filing${buys.length>1?'s':''}${rc?' · '+rc:''}`}; }
    const sh=fmtS(buys.reduce((s,t)=>s+(t.share||0),0)), dl=fmtD(buys.reduce((s,t)=>s+(t.value||0),0)), rc=ago(buys.map(t=>t.transactionDate).sort().reverse()[0]);
    return {status:'pass',value:[`${buys.length} buy${buys.length>1?'s':''}`,sh,dl,rc].filter(Boolean).join(' · ')};
  }
  if (sells.length) { const rc=ago(sells.map(t=>t.transactionDate).sort().reverse()[0]); return {status:'fail',value:[`${sells.length} sell${sells.length>1?'s':''}, no buys`,rc].filter(Boolean).join(' · ')}; }
  return {status:'neutral',value:'No activity (60d)'};
}
 
async function getAnalystTarget(ticker) {
  try { const d=await fh(`/stock/price-target?symbol=${ticker}`); const t=d?.targetMedian||d?.targetMean; if (t>0) return t; } catch(_) {}
  for (const h of ['query1','query2']) {
    try { const r=await fetch(`https://${h}.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData`,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(5000)}); if (r.ok) { const j=await r.json(), fd=j?.quoteSummary?.result?.[0]?.financialData, t=fd?.targetMedianPrice?.raw||fd?.targetMeanPrice?.raw; if (t>0) return t; } } catch(_) {}
  }
  return null;
}
 
async function getMA(ticker) {
  try {
    const now=Math.floor(Date.now()/1000);
    const r=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&period1=${now-80*86400}&period2=${now}`,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(5000)});
    if (r.ok) { const j=await r.json(), c=j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(x=>x!=null&&!isNaN(x)); if (c?.length>=10) { const s=c.slice(-50); return s.reduce((a,b)=>a+b,0)/s.length; } }
  } catch(_) {}
  try { const d=await fh(`/stock/candle?symbol=${ticker}&resolution=D&count=60`); if (d?.s==='ok'&&d.c?.length>=10) { const s=d.c.slice(-50); return s.reduce((a,b)=>a+b,0)/s.length; } } catch(_) {}
  return null;
}
 
function getRating(s) {
  if (s>=5) return {label:'Strong Buy',color:'#14532d',bg:'#dcfce7',border:'#86efac'};
  if (s===4) return {label:'Buy',color:'#15803d',bg:'#f0fdf4',border:'#bbf7d0'};
  if (s===3) return {label:'Watch',color:'#92400e',bg:'#fffbeb',border:'#fde68a'};
  return {label:'Ignore',color:'#6b7280',bg:'#f9fafb',border:'#d1d5db'};
}
 
async function analyse(ticker) {
  const [quote, metrics, earnings, profile] = await Promise.allSettled([
    fh(`/quote?symbol=${ticker}`),
    fh(`/stock/metric?symbol=${ticker}&metric=all`),
    fh(`/stock/earnings?symbol=${ticker}&limit=4`),
    fh(`/stock/profile2?symbol=${ticker}`),
  ]);
  const q=quote.status==='fulfilled'?quote.value||{}:{};
  const m=metrics.status==='fulfilled'?metrics.value?.metric||{}:{};
  const p=profile.status==='fulfilled'?profile.value||{}:{};
  const px=q.c; if (!px) return null;
 
  const [ma, insider, analystTgt] = await Promise.all([getMA(ticker), getInsider(ticker,px), getAnalystTarget(ticker)]);
 
  const mc=p.marketCapitalization?p.marketCapitalization*1e6:0;
  const mcs=mc>1e12?`$${(mc/1e12).toFixed(2)}T`:mc>1e9?`$${(mc/1e9).toFixed(1)}B`:mc>1e6?`$${(mc/1e6).toFixed(0)}M`:'';
 
  // S1 EPS
  let s1={status:'neutral',value:'No data'};
  try {
    const earns=Array.isArray(earnings.value)?earnings.value:[];
    if (earns.length&&earns[0].actual!=null&&earns[0].estimate!=null) {
      const diff=earns[0].actual-earns[0].estimate,beat=diff>=0,ds=Math.abs(diff)<0.005?'in-line':beat?`+$${Math.abs(diff).toFixed(2)}`:`-$${Math.abs(diff).toFixed(2)}`;
      s1={status:beat?'pass':'fail',value:beat?`Beat by ${ds}`:`Missed ${ds}`};
    } else {
      const r=await fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=earningsHistory`,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(5000)});
      if (r.ok) { const j=await r.json(),hist=j?.quoteSummary?.result?.[0]?.earningsHistory?.history||[]; if (hist.length) { const rec=hist[hist.length-1],a=rec?.epsActual?.raw,e=rec?.epsEstimate?.raw; if (a!=null&&e!=null) { const diff=a-e,beat=diff>=0,ds=Math.abs(diff)<0.005?'in-line':beat?`+$${Math.abs(diff).toFixed(2)}`:`-$${Math.abs(diff).toFixed(2)}`; s1={status:beat?'pass':'fail',value:beat?`Beat by ${ds}`:`Missed ${ds}`}; } } }
    }
  } catch(_) {}
 
  // S2 PE vs hist
  let s2={status:'neutral',value:'No data'};
  try {
    const pe=m.peBasicExclExtraTTM||m.peTTM, eps=m.epsBasicExclExtraAnnual||m.epsTTM, hi=m['52WeekHigh'], lo=m['52WeekLow'];
    if (pe&&eps>0&&hi&&lo) { const h=((hi+lo)/2)/eps; if (pe<h*0.92) s2={status:'pass',value:`PE ${pe.toFixed(1)}x < hist ~${h.toFixed(0)}x`}; else if (pe>h*1.08) s2={status:'fail',value:`PE ${pe.toFixed(1)}x > hist ~${h.toFixed(0)}x`}; else s2={status:'neutral',value:`PE ${pe.toFixed(1)}x ≈ hist ~${h.toFixed(0)}x`}; }
    else if (pe) s2={status:'neutral',value:`PE ${pe.toFixed(1)}x`};
    else {
      const r=await fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=summaryDetail,defaultKeyStatistics`,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(5000)});
      if (r.ok) { const j=await r.json(),sd=j?.quoteSummary?.result?.[0]?.summaryDetail||{},ks=j?.quoteSummary?.result?.[0]?.defaultKeyStatistics||{},pe2=sd?.trailingPE?.raw||sd?.forwardPE?.raw,eps2=ks?.trailingEps?.raw,hi2=sd?.fiftyTwoWeekHigh?.raw,lo2=sd?.fiftyTwoWeekLow?.raw; if (pe2&&eps2&&hi2&&lo2) { const h=((hi2+lo2)/2)/eps2; if (pe2<h*0.92) s2={status:'pass',value:`PE ${pe2.toFixed(1)}x < hist ~${h.toFixed(0)}x`}; else if (pe2>h*1.08) s2={status:'fail',value:`PE ${pe2.toFixed(1)}x > hist ~${h.toFixed(0)}x`}; else s2={status:'neutral',value:`PE ${pe2.toFixed(1)}x ≈ hist ~${h.toFixed(0)}x`}; } else if (pe2) s2={status:'neutral',value:`PE ${pe2.toFixed(1)}x`}; }
    }
  } catch(_) {}
 
  // S3 MA
  let s3={status:'neutral',value:'No data'};
  if (ma&&px) { const pct=((px-ma)/ma*100).toFixed(1); s3=px<=ma?{status:'pass',value:`$${px.toFixed(2)} ≤ MA $${ma.toFixed(2)} (${pct}%)`}:{status:'fail',value:`$${px.toFixed(2)} > MA $${ma.toFixed(2)} (+${pct}%)`}; }
 
  // S4 Insider
  const {buys,sells,src}=insider||{buys:[],sells:[],src:null};
  const s4=insiderSig(buys,sells,src);
 
  // S5 Analyst
  let s5={status:'neutral',value:'No data'};
  if (analystTgt&&px) { const up=((analystTgt-px)/px*100).toFixed(1); s5=parseFloat(up)>=25?{status:'pass',value:`Target $${analystTgt.toFixed(2)}, +${up}% upside`}:{status:'fail',value:`Target $${analystTgt.toFixed(2)}, +${up}% upside`}; }
 
  // S6 Peer PE
  let s6={status:'neutral',value:'No data'};
  try {
    const pd=await fh(`/stock/peers?symbol=${ticker}`);
    const peers=Array.isArray(pd)?pd.filter(x=>x!==ticker).slice(0,8):[];
    if (peers.length>=2) {
      const pm=await Promise.allSettled(peers.map(p=>fh(`/stock/metric?symbol=${p}&metric=all`)));
      const pes=pm.filter(r=>r.status==='fulfilled').map(r=>r.value?.metric?.peBasicExclExtraTTM||r.value?.metric?.peTTM).filter(pe=>pe&&pe>0&&pe<300);
      if (pes.length>=2) { const avg=pes.reduce((a,b)=>a+b,0)/pes.length, tpe=m.peBasicExclExtraTTM||m.peTTM; if (tpe&&avg) { const diff=((tpe-avg)/avg*100); if (diff<-8) s6={status:'pass',value:`${Math.abs(diff).toFixed(0)}% < peer avg ${avg.toFixed(1)}x`}; else if (diff>8) s6={status:'fail',value:`${Math.abs(diff).toFixed(0)}% > peer avg ${avg.toFixed(1)}x`}; else s6={status:'neutral',value:`In line, avg ${avg.toFixed(1)}x`}; } }
    }
  } catch(_) {}
 
  const signals=[s1,s2,s3,s4,s5,s6], score=signals.filter(s=>s.status==='pass').length;
  const N=['EPS beat','Low PE','Below 50d MA','Insider buying','Analyst upside','PE vs peers'];
  const passes=signals.map((s,i)=>s.status==='pass'?N[i]:null).filter(Boolean);
  const fails=signals.map((s,i)=>s.status==='fail'?N[i]:null).filter(Boolean);
  const summary=score>=5?`Strong value candidate — ${score}/6 signals pass. Strengths: ${passes.join(', ')}.`:score===4?`Good signals (4/6). Passes: ${passes.join(', ')}.`:score===3?`Moderate signals (3/6). Passes: ${passes.join(', ')}.`:score>0?`Weak signals (${score}/6). Passes: ${passes.join(', ')}. Fails: ${fails.join(', ')}.`:`No signals pass. Fails: ${fails.join(', ')}.`;
 
  const rawEx=(p.exchange||'').replace(/NASDAQ.*/i,'NASDAQ').replace(/New York Stock Exchange.*/i,'NYSE').toUpperCase().trim();
  return { ticker, company:p.name||ticker, exchange:rawEx||EXCHANGE_MAP[ticker]||'NYSE', price:`$${px.toFixed(2)}`, change:q.dp!=null?`${q.dp>0?'+':''}${q.dp.toFixed(2)}%`:null, marketCap:mcs, score, signals, summary, rating:getRating(score), updatedAt:new Date().toISOString() };
}
 
export default async function handler(req, res) {
  if (req.method==='GET') {
    if (cache.data&&Date.now()-cache.timestamp<CACHE_TTL) { res.setHeader('X-Cache','HIT'); return res.status(200).json(cache.data); }
    return res.status(200).json({top3:[],totalScanned:0,empty:true});
  }
  if (req.method==='POST') {
    if (!FINNHUB_KEY) return res.status(500).json({error:'FINNHUB_KEY not set'});
    const {tickers,totalScanned}=req.body;
    if (!Array.isArray(tickers)||!tickers.length) return res.status(400).json({error:'tickers required'});
    try {
      const results=await Promise.allSettled(tickers.slice(0,3).map(t=>analyse(t)));
      const top3=results.filter(r=>r.status==='fulfilled'&&r.value).map(r=>r.value).sort((a,b)=>(b.score||0)-(a.score||0));
      const data={top3,totalScanned:totalScanned||0,generatedAt:new Date().toISOString()};
      cache={data,timestamp:Date.now()};
      return res.status(200).json(data);
    } catch(err) { return res.status(500).json({error:err.message}); }
  }
  return res.status(405).json({error:'Method not allowed'});
}
 
