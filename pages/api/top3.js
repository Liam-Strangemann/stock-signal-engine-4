// pages/api/top3.js
//
// This endpoint is now TINY — it only receives 3 pre-selected tickers
// from the browser and runs the full Finnhub signal analysis on them.
//
// The heavy Yahoo scan (280 stocks) happens entirely in the browser,
// which has no timeout limit. Only the final Finnhub enrichment comes
// through here, well within Vercel's 10s limit.
//
// POST { tickers: ["AAPL","JPM","XOM"] }
// GET  — returns cached result if available
 
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const FH = 'https://finnhub.io/api/v1';
 
const EXCHANGE_MAP = {
  AAPL:'NASDAQ',MSFT:'NASDAQ',GOOGL:'NASDAQ',AMZN:'NASDAQ',META:'NASDAQ',
  NVDA:'NASDAQ',AVGO:'NASDAQ',ORCL:'NYSE',ADBE:'NASDAQ',INTU:'NASDAQ',
  AMD:'NASDAQ',INTC:'NASDAQ',QCOM:'NASDAQ',TXN:'NASDAQ',AMAT:'NASDAQ',
  MU:'NASDAQ',NOW:'NYSE',CRM:'NYSE',PANW:'NASDAQ',CSCO:'NASDAQ',
  IBM:'NYSE',HPQ:'NYSE',KLAC:'NASDAQ',LRCX:'NASDAQ',SNPS:'NASDAQ',CDNS:'NASDAQ',
  JPM:'NYSE',BAC:'NYSE',WFC:'NYSE',GS:'NYSE',MS:'NYSE',BLK:'NYSE',
  C:'NYSE',AXP:'NYSE',SCHW:'NYSE',USB:'NYSE',PNC:'NYSE',TFC:'NYSE',
  COF:'NYSE',DFS:'NYSE',AIG:'NYSE',MET:'NYSE',PRU:'NYSE',AFL:'NYSE',
  CB:'NYSE',TRV:'NYSE',CME:'NASDAQ',ICE:'NYSE',SPGI:'NYSE',MCO:'NYSE',
  MA:'NYSE',V:'NYSE',
  LLY:'NYSE',JNJ:'NYSE',UNH:'NYSE',ABBV:'NYSE',MRK:'NYSE',PFE:'NYSE',
  TMO:'NYSE',ABT:'NYSE',AMGN:'NASDAQ',CVS:'NYSE',MDT:'NYSE',
  ISRG:'NASDAQ',BSX:'NYSE',SYK:'NYSE',REGN:'NASDAQ',BIIB:'NASDAQ',VRTX:'NASDAQ',
  XOM:'NYSE',CVX:'NYSE',COP:'NYSE',EOG:'NYSE',SLB:'NYSE',MPC:'NYSE',
  PSX:'NYSE',VLO:'NYSE',OXY:'NYSE',DVN:'NYSE',HAL:'NYSE',BKR:'NYSE',
  HD:'NYSE',MCD:'NYSE',NKE:'NYSE',SBUX:'NASDAQ',LOW:'NYSE',TGT:'NYSE',
  COST:'NASDAQ',WMT:'NYSE',BKNG:'NASDAQ',MAR:'NASDAQ',
  CAT:'NYSE',HON:'NASDAQ',MMM:'NYSE',GE:'NYSE',RTX:'NYSE',LMT:'NYSE',
  NOC:'NYSE',GD:'NYSE',UPS:'NYSE',FDX:'NYSE',UNP:'NYSE',CSX:'NASDAQ',NSC:'NYSE',DE:'NYSE',
  KO:'NYSE',PEP:'NASDAQ',PG:'NYSE',PM:'NYSE',MO:'NYSE',T:'NYSE',VZ:'NYSE',TMUS:'NASDAQ',
  NEE:'NYSE',LIN:'NYSE',APD:'NYSE',ECL:'NYSE',NEM:'NYSE',FCX:'NYSE',
  AMT:'NYSE',PLD:'NYSE',EQIX:'NASDAQ',CCI:'NYSE',SPG:'NYSE',
  TSM:'NYSE',ASML:'NASDAQ',NVO:'NYSE',SAP:'NYSE',TM:'NYSE',
  AZN:'NASDAQ',HSBC:'NYSE',SHEL:'NYSE',BHP:'NYSE',RIO:'NYSE',
};
 
// Simple in-memory cache — serves repeat visitors instantly
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 60 * 60 * 1000;
 
async function fh(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${FH}${path}${sep}token=${FINNHUB_KEY}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Finnhub ${res.status}`);
  const d = await res.json();
  if (d?.error) throw new Error(d.error);
  return d;
}
 
function fmtShares(n) { if (!n) return null; if (n>=1e6) return `${(n/1e6).toFixed(1)}M sh`; if (n>=1e3) return `${(n/1e3).toFixed(0)}K sh`; return null; }
function fmtDollars(n) { if (!n) return null; if (n>=1e9) return `$${(n/1e9).toFixed(1)}B`; if (n>=1e6) return `$${(n/1e6).toFixed(0)}M`; return null; }
function timeAgo(d) { if (!d) return null; const days=Math.floor((Date.now()-new Date(d).getTime())/86400000); if (days<1) return 'today'; if (days<7) return `${days}d ago`; if (days<30) return `${Math.floor(days/7)}w ago`; return `${Math.floor(days/30)}mo ago`; }
 
async function fetchInsider(ticker, curPx) {
  const now=Math.floor(Date.now()/1000), ago60=now-60*86400;
  const cutoff=new Date(ago60*1000);
  const from60=cutoff.toISOString().slice(0,10);
  const to60=new Date(now*1000).toISOString().slice(0,10);
 
  // Yahoo first (Finnhub free tier often empty)
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=insiderTransactions`,
      { headers:{'User-Agent':'Mozilla/5.0'}, signal:AbortSignal.timeout(5000) });
    if (r.ok) {
      const j=await r.json();
      const txns=j?.quoteSummary?.result?.[0]?.insiderTransactions?.transactions||[];
      const buys=[],sells=[];
      for (const t of txns) {
        const ts=t.startDate?.raw; if (!ts) continue;
        const dt=new Date(ts*1000); if (dt<cutoff) continue;
        const ds=dt.toISOString().slice(0,10);
        const sh=Math.abs(t.shares?.raw||0),val=Math.abs(t.value?.raw||0);
        const desc=(t.transactionDescription||'').toLowerCase();
        const entry={transactionDate:ds,share:sh,value:val,transactionPrice:sh>0?val/sh:curPx};
        if (/purchase|buy/i.test(desc)) buys.push(entry);
        else if (/sale|sell/i.test(desc)) sells.push(entry);
      }
      if (buys.length>0||sells.length>0) return {buys,sells,source:'yahoo'};
    }
  } catch(_) {}
 
  // Finnhub fallback
  try {
    const d=await fh(`/stock/insider-transactions?symbol=${ticker}&from=${from60}&to=${to60}`);
    const txns=d?.data||[];
    const buys=txns.filter(t=>t.transactionCode==='P');
    const sells=txns.filter(t=>t.transactionCode==='S');
    if (buys.length>0||sells.length>0) return {buys,sells,source:'finnhub'};
  } catch(_) {}
 
  // SEC EDGAR fallback
  try {
    const r=await fetch(`https://efts.sec.gov/LATEST/search-index?q=%22${ticker}%22&dateRange=custom&startdt=${from60}&enddt=${to60}&forms=4`,
      {headers:{'User-Agent':'signal-engine/1.0'},signal:AbortSignal.timeout(5000)});
    if (r.ok) {
      const j=await r.json();
      const hits=(j?.hits?.hits||[]).filter(h=>(h._source?.form_type||'').toUpperCase()==='4'&&new Date(h._source?.file_date)>=cutoff);
      if (hits.length>0) {
        const buys=hits.slice(0,6).map(h=>({transactionDate:h._source.file_date,share:0,value:0,transactionPrice:curPx}));
        return {buys,sells:[],source:'sec-edgar'};
      }
    }
  } catch(_) {}
 
  return {buys:[],sells:[],source:null};
}
 
function buildInsiderValue(buys,sells,source) {
  if (buys.length>0) {
    if (source==='sec-edgar') { const rc=timeAgo(buys[0].transactionDate); return {status:'pass',value:`Form 4 · ${buys.length} filing${buys.length>1?'s':''}${rc?' · '+rc:''}`}; }
    const sh=fmtShares(buys.reduce((s,t)=>s+(t.share||0),0));
    const dl=fmtDollars(buys.reduce((s,t)=>s+(t.value||0),0));
    const rc=timeAgo(buys.map(t=>t.transactionDate).sort().reverse()[0]);
    return {status:'pass',value:[`${buys.length} buy${buys.length>1?'s':''}`,sh,dl,rc].filter(Boolean).join(' · ')};
  }
  if (sells.length>0) {
    const rc=timeAgo(sells.map(t=>t.transactionDate).sort().reverse()[0]);
    return {status:'fail',value:[`${sells.length} sell${sells.length>1?'s':''}, no buys`,rc].filter(Boolean).join(' · ')};
  }
  return {status:'neutral',value:'No activity (60d)'};
}
 
async function fetchAnalystTarget(ticker) {
  // Finnhub price-target (most reliable)
  try { const d=await fh(`/stock/price-target?symbol=${ticker}`); const t=d?.targetMedian||d?.targetMean; if (t&&t>0) return t; } catch(_) {}
  // Yahoo fallbacks
  for (const host of ['query1','query2']) {
    try {
      const r=await fetch(`https://${host}.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData`,
        {headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(5000)});
      if (r.ok) { const j=await r.json(); const fd=j?.quoteSummary?.result?.[0]?.financialData; const t=fd?.targetMedianPrice?.raw||fd?.targetMeanPrice?.raw; if (t&&t>0) return t; }
    } catch(_) {}
  }
  return null;
}
 
function getRating(score) {
  if (score>=5) return {label:'Strong Buy',color:'#14532d',bg:'#dcfce7',border:'#86efac'};
  if (score===4) return {label:'Buy',color:'#15803d',bg:'#f0fdf4',border:'#bbf7d0'};
  if (score===3) return {label:'Watch',color:'#92400e',bg:'#fffbeb',border:'#fde68a'};
  return {label:'Ignore',color:'#6b7280',bg:'#f9fafb',border:'#d1d5db'};
}
 
async function fullAnalyse(ticker) {
  // 4 Finnhub calls in parallel — the only server-side work
  const [quote, metrics, earnings, profile] = await Promise.allSettled([
    fh(`/quote?symbol=${ticker}`),
    fh(`/stock/metric?symbol=${ticker}&metric=all`),
    fh(`/stock/earnings?symbol=${ticker}&limit=4`),
    fh(`/stock/profile2?symbol=${ticker}`),
  ]);
 
  const q=quote.status==='fulfilled'?quote.value||{}:{};
  const m=metrics.status==='fulfilled'?metrics.value?.metric||{}:{};
  const p=profile.status==='fulfilled'?profile.value||{}:{};
  const curPx=q.c; if (!curPx) return null;
 
  // Secondary calls — all parallel
  const [ma50res, insiderData, analystTarget] = await Promise.all([
    // MA from Yahoo
    (async()=>{
      try {
        const now=Math.floor(Date.now()/1000);
        const r=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&period1=${now-80*86400}&period2=${now}`,
          {headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(5000)});
        if (r.ok) { const j=await r.json(); const c=j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(x=>x!=null&&!isNaN(x)); if (c&&c.length>=10) { const s=c.slice(-50); return s.reduce((a,b)=>a+b,0)/s.length; } }
      } catch(_) {}
      return null;
    })(),
    fetchInsider(ticker, curPx),
    fetchAnalystTarget(ticker),
  ]);
 
  const mc=p.marketCapitalization?p.marketCapitalization*1e6:0;
  const mcs=mc>1e12?`$${(mc/1e12).toFixed(2)}T`:mc>1e9?`$${(mc/1e9).toFixed(1)}B`:mc>1e6?`$${(mc/1e6).toFixed(0)}M`:'';
 
  // Signal 1 — EPS beat (Finnhub + Yahoo fallback)
  let s1={status:'neutral',value:'No data'};
  try {
    const earns=Array.isArray(earnings.value)?earnings.value:[];
    if (earns.length>0&&earns[0].actual!=null&&earns[0].estimate!=null) {
      const e=earns[0],diff=e.actual-e.estimate,beat=diff>=0;
      const ds=Math.abs(diff)<0.005?'in-line':beat?`+$${Math.abs(diff).toFixed(2)}`:`-$${Math.abs(diff).toFixed(2)}`;
      s1={status:beat?'pass':'fail',value:beat?`Beat by ${ds}`:`Missed ${ds}`};
    } else {
      // Yahoo fallback
      const r=await fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=earningsHistory`,
        {headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(5000)});
      if (r.ok) {
        const j=await r.json();
        const hist=j?.quoteSummary?.result?.[0]?.earningsHistory?.history||[];
        if (hist.length>0) {
          const rec=hist[hist.length-1],actual=rec?.epsActual?.raw,estimate=rec?.epsEstimate?.raw;
          if (actual!=null&&estimate!=null) {
            const diff=actual-estimate,beat=diff>=0;
            const ds=Math.abs(diff)<0.005?'in-line':beat?`+$${Math.abs(diff).toFixed(2)}`:`-$${Math.abs(diff).toFixed(2)}`;
            s1={status:beat?'pass':'fail',value:beat?`Beat by ${ds}`:`Missed ${ds}`};
          }
        }
      }
    }
  } catch(_) {}
 
  // Signal 2 — PE vs historical
  let s2={status:'neutral',value:'No data'};
  try {
    const curPE=m.peBasicExclExtraTTM||m.peTTM;
    const eps=m.epsBasicExclExtraAnnual||m.epsTTM;
    const hi=m['52WeekHigh'],lo=m['52WeekLow'];
    if (curPE&&eps>0&&hi&&lo) {
      const histPE=((hi+lo)/2)/eps;
      if (curPE<histPE*0.92) s2={status:'pass',value:`PE ${curPE.toFixed(1)}x < hist ~${histPE.toFixed(0)}x`};
      else if (curPE>histPE*1.08) s2={status:'fail',value:`PE ${curPE.toFixed(1)}x > hist ~${histPE.toFixed(0)}x`};
      else s2={status:'neutral',value:`PE ${curPE.toFixed(1)}x ≈ hist ~${histPE.toFixed(0)}x`};
    } else if (curPE) {
      s2={status:'neutral',value:`PE ${curPE.toFixed(1)}x`};
    } else {
      // Yahoo fallback
      const r=await fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=summaryDetail,defaultKeyStatistics`,
        {headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(5000)});
      if (r.ok) {
        const j=await r.json();
        const sd=j?.quoteSummary?.result?.[0]?.summaryDetail||{};
        const ks=j?.quoteSummary?.result?.[0]?.defaultKeyStatistics||{};
        const pe=sd?.trailingPE?.raw||sd?.forwardPE?.raw;
        const eps2=ks?.trailingEps?.raw;
        const hi2=sd?.fiftyTwoWeekHigh?.raw,lo2=sd?.fiftyTwoWeekLow?.raw;
        if (pe&&eps2&&hi2&&lo2) { const h=((hi2+lo2)/2)/eps2; if (pe<h*0.92) s2={status:'pass',value:`PE ${pe.toFixed(1)}x < hist ~${h.toFixed(0)}x`}; else if (pe>h*1.08) s2={status:'fail',value:`PE ${pe.toFixed(1)}x > hist ~${h.toFixed(0)}x`}; else s2={status:'neutral',value:`PE ${pe.toFixed(1)}x ≈ hist ~${h.toFixed(0)}x`}; }
        else if (pe) s2={status:'neutral',value:`PE ${pe.toFixed(1)}x`};
      }
    }
  } catch(_) {}
 
  // Signal 3 — 50d MA
  let s3={status:'neutral',value:'No data'};
  if (ma50res&&curPx) { const pct=((curPx-ma50res)/ma50res*100).toFixed(1); s3=curPx<=ma50res?{status:'pass',value:`$${curPx.toFixed(2)} ≤ MA $${ma50res.toFixed(2)} (${pct}%)`}:{status:'fail',value:`$${curPx.toFixed(2)} > MA $${ma50res.toFixed(2)} (+${pct}%)`}; }
 
  // Signal 4 — Insider
  const {buys,sells,source}=insiderData||{buys:[],sells:[],source:null};
  const s4=buildInsiderValue(buys,sells,source);
 
  // Signal 5 — Analyst target
  let s5={status:'neutral',value:'No data'};
  if (analystTarget&&curPx) { const up=((analystTarget-curPx)/curPx*100).toFixed(1); s5=parseFloat(up)>=25?{status:'pass',value:`Target $${analystTarget.toFixed(2)}, +${up}% upside`}:{status:'fail',value:`Target $${analystTarget.toFixed(2)}, +${up}% upside`}; }
 
  // Signal 6 — PE vs peers
  let s6={status:'neutral',value:'No data'};
  try {
    const pd=await fh(`/stock/peers?symbol=${ticker}`);
    const peers=Array.isArray(pd)?pd.filter(x=>x!==ticker).slice(0,8):[];
    if (peers.length>=2) {
      const pm=await Promise.allSettled(peers.map(p=>fh(`/stock/metric?symbol=${p}&metric=all`)));
      const pes=pm.filter(r=>r.status==='fulfilled').map(r=>r.value?.metric?.peBasicExclExtraTTM||r.value?.metric?.peTTM).filter(pe=>pe&&pe>0&&pe<300);
      if (pes.length>=2) {
        const avg=pes.reduce((a,b)=>a+b,0)/pes.length;
        const tpe=m.peBasicExclExtraTTM||m.peTTM;
        if (tpe&&avg) { const diff=((tpe-avg)/avg*100); if (diff<-8) s6={status:'pass',value:`${Math.abs(diff).toFixed(0)}% < peer avg ${avg.toFixed(1)}x`}; else if (diff>8) s6={status:'fail',value:`${Math.abs(diff).toFixed(0)}% > peer avg ${avg.toFixed(1)}x`}; else s6={status:'neutral',value:`In line, avg ${avg.toFixed(1)}x`}; }
      }
    }
  } catch(_) {}
 
  const signals=[s1,s2,s3,s4,s5,s6];
  const score=signals.filter(s=>s.status==='pass').length;
  const SIG_NAMES=['EPS beat','Low PE','Below 50d MA','Insider buying','Analyst upside','PE vs peers'];
  const passes=signals.map((s,i)=>s.status==='pass'?SIG_NAMES[i]:null).filter(Boolean);
  const fails=signals.map((s,i)=>s.status==='fail'?SIG_NAMES[i]:null).filter(Boolean);
 
  let summary;
  if (score>=5) summary=`Strong value candidate — ${score}/6 signals pass. Strengths: ${passes.join(', ')}.`;
  else if (score===4) summary=`Good signals (4/6). Passes: ${passes.join(', ')}.`;
  else if (score===3) summary=`Moderate signals (3/6). Passes: ${passes.join(', ')}.`;
  else if (score>0) summary=`Weak signals (${score}/6). Passes: ${passes.join(', ')}. Fails: ${fails.join(', ')}.`;
  else summary=`No signals pass. Fails: ${fails.join(', ')}.`;
 
  const rawEx=(p.exchange||'').replace(/NASDAQ.*/i,'NASDAQ').replace(/New York Stock Exchange.*/i,'NYSE').toUpperCase().trim();
  const exchange=rawEx||EXCHANGE_MAP[ticker]||'NYSE';
 
  return { ticker, company:p.name||ticker, exchange, price:`$${curPx.toFixed(2)}`, change:q.dp!=null?`${q.dp>0?'+':''}${q.dp.toFixed(2)}%`:null, marketCap:mcs, score, signals, summary, rating:getRating(score), updatedAt:new Date().toISOString() };
}
 
export default async function handler(req, res) {
  // GET — return cache
  if (req.method === 'GET') {
    if (cache.data && Date.now()-cache.timestamp < CACHE_TTL) {
      res.setHeader('X-Cache','HIT');
      return res.status(200).json(cache.data);
    }
    return res.status(200).json({ top3:[], totalScanned:0, empty:true });
  }
 
  // POST — receive pre-selected tickers from browser, run Finnhub analysis
  if (req.method === 'POST') {
    if (!FINNHUB_KEY) return res.status(500).json({ error:'FINNHUB_KEY not set' });
    const { tickers, totalScanned } = req.body;
    if (!Array.isArray(tickers)||tickers.length===0) return res.status(400).json({ error:'tickers required' });
 
    try {
      // Run all 3 concurrently — only 4 Finnhub calls each = 12 total, well within limits
      const results = await Promise.allSettled(tickers.slice(0,3).map(t => fullAnalyse(t)));
      const top3 = results.filter(r=>r.status==='fulfilled'&&r.value).map(r=>r.value).sort((a,b)=>(b.score||0)-(a.score||0));
 
      const data = { top3, totalScanned: totalScanned||0, generatedAt: new Date().toISOString() };
      cache = { data, timestamp: Date.now() };
      res.setHeader('Cache-Control','s-maxage=3600,stale-while-revalidate');
      return res.status(200).json(data);
    } catch(err) {
      return res.status(500).json({ error:err.message });
    }
  }
 
  return res.status(405).json({ error:'Method not allowed' });
}
 
