import { useState, useEffect, useRef, useCallback } from 'react';

// Inject Google Fonts — only correct method without Next.js Head
function useFonts() {
  useEffect(() => {
    if (document.getElementById('se-gf')) return;
    const l = document.createElement('link');
    l.id = 'se-gf'; l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;0,700;1,300;1,400&family=DM+Sans:wght@300;400;500&family=DM+Mono:wght@300;400;500&display=swap';
    document.head.appendChild(l);
  }, []);
}

const PRESETS = {
  'Mega-cap':     'AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,JPM,XOM,UNH',
  'Technology':   'AAPL,MSFT,NVDA,AVGO,ORCL,AMD,INTC,QCOM,TXN,AMAT',
  'Finance':      'JPM,BAC,WFC,GS,MS,BLK,C,AXP,SCHW,USB',
  'Healthcare':   'LLY,JNJ,UNH,ABBV,MRK,PFE,TMO,ABT,AMGN,CVS',
  'Energy':       'XOM,CVX,COP,EOG,SLB,MPC,PSX,VLO,OXY,DVN',
  'Consumer':     'AMZN,TSLA,HD,MCD,NKE,SBUX,LOW,TGT,COST,WMT',
  'International':'TSM,ASML,NVO,SAP,TM,SHEL,BHP,RIO,AZN,HSBC',
  'Dividend':     'T,VZ,MO,PM,XOM,CVX,JNJ,KO,PEP,IBM',
};

const SIG_LABELS = ['EPS beat','PE vs hist','vs 50d MA','Insider','Analyst','PE vs peers'];

const US_SET = new Set('AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,JPM,XOM,UNH,LLY,AVGO,ORCL,AMD,INTC,QCOM,TXN,AMAT,MU,ADBE,BAC,WFC,GS,MS,BLK,C,AXP,SCHW,USB,PNC,TFC,JNJ,ABBV,MRK,PFE,TMO,ABT,AMGN,CVS,MDT,ISRG,COP,EOG,SLB,MPC,PSX,VLO,OXY,DVN,HAL,BKR,CVX,HD,MCD,NKE,SBUX,LOW,TGT,COST,WMT,T,VZ,MO,PM,KO,PEP,MMM,IBM,CAT,DE,GE,HON,RTX,LMT,NOW,CRM,PANW,INTU,CSCO,MA,V,BKNG,CME,SPGI,FCX,NEM,NEE,DUK,AMT,PLD,EQIX,CCI,SPG,NFLX,DIS,TMUS,CMCSA,F,GM'.split(','));

const C = {
  pageBg:'#F1EFE8', cardBg:'#E8E5DC', deepBg:'#3A3832', darkBg:'#5F5E56',
  border:'rgba(95,94,86,0.2)', borderDk:'rgba(95,94,86,0.4)',
  tx:'#2C2C2A', txMid:'#5F5E56', txLight:'#9A9890',
  gold:'#B8A070', accent:'#8B7D6B', accentDk:'#6B5D4F',
  green:'#4A6741', greenBg:'#DDE8D8', greenBd:'#A8C0A0',
  red:'#7A3A30', redBg:'#F0DDD9', redBd:'#C8A09A',
  amber:'#AC8431', amberBg:'#F1E8C8', amberBd:'#CCB164',
  dkGreen:'#4A6741', dkGreenBg:'#D8E8D0', dkGreenBd:'#98B890',
  dkRed:'#7A3A30', dkRedBg:'#EDD8D8', dkRedBd:'#C09898',
  dkAmber:'#7A6428', dkAmberBg:'#EBE3C8', dkAmberBd:'#C4B060',
};
const FONTS = "'Cormorant Garamond','Georgia',serif";
const SANS  = "'DM Sans','Helvetica Neue',sans-serif";
const MONO  = "'DM Mono','Courier New',monospace";
const RANK_LABELS   = ['I','II','III','IV','V','VI','VII','VIII','IX'];
const PAGE_SIZE     = 3;
const TOTAL_PICKS   = 9;
const RESCAN_MS     = 5 * 60 * 1000;
const TOTAL_BATCHES = 5;

function scoreColor(sc, dark=false) {
  if (sc>=6) return dark?'#7EC87A':'#2D6E2A';
  if (sc===5) return dark?'#9DD88A':'#3D8A38';
  if (sc===4) return dark?'#B8E0A0':'#5A9A50';
  if (sc===3) return dark?'#C8A870':C.amber;
  return dark?'rgba(154,152,144,0.55)':C.txLight;
}
function getRating(sc) {
  if (sc>=5) return {label:'Strong Buy',color:'#14532d',bg:'#dcfce7',border:'#86efac'};
  if (sc===4) return {label:'Buy',color:'#15803d',bg:'#f0fdf4',border:'#bbf7d0'};
  if (sc===3) return {label:'Watch',color:'#92400e',bg:'#fffbeb',border:'#fde68a'};
  return {label:'Ignore',color:'#6b7280',bg:'#f9fafb',border:'#d1d5db'};
}

function ScoreDots({score,max=6,dark=false}) {
  const fc=scoreColor(score,dark), er=dark?'rgba(95,94,86,0.45)':C.borderDk;
  return (
    <div style={{display:'flex',gap:4}}>
      {Array.from({length:max}).map((_,i)=>(
        <div key={i} style={{width:7,height:7,borderRadius:'50%',background:i<score?fc:'transparent',border:`1.5px solid ${i<score?fc:er}`,transition:'all 0.3s'}}/>
      ))}
    </div>
  );
}

// KEY FIX: pill shows ANY non-empty string from the backend.
// Only shows "retry" when value is genuinely absent (null, undefined, '').
function SigPill({sig, label, dark=false, signalIndex, onRetry, loading=false}) {
  const val = sig?.value;
  const hasVal = !loading && val != null && val !== '';
  const p = sig?.status === 'pass';
  const f = sig?.status === 'fail';

  const bg  = !hasVal?( dark?C.dkAmberBg:C.amberBg):dark?(p?C.dkGreenBg:f?C.dkRedBg:C.dkAmberBg):(p?C.greenBg:f?C.redBg:C.amberBg);
  const col = !hasVal?(dark?C.dkAmber:C.amber):dark?(p?C.dkGreen:f?C.dkRed:C.dkAmber):(p?C.green:f?C.red:C.amber);
  const bdc = !hasVal?(dark?C.dkAmberBd:C.amberBd):dark?(p?C.dkGreenBd:f?C.dkRedBd:C.dkAmberBd):(p?C.greenBd:f?C.redBd:C.amberBd);
  const bd  = !hasVal?`0.5px dashed ${bdc}`:`0.5px solid ${bdc}`;
  const clickable = !hasVal && !loading && onRetry;

  return (
    <div onClick={clickable?()=>onRetry(signalIndex):undefined}
      title={clickable?`Retry ${label}`:undefined}
      style={{background:bg,border:bd,borderRadius:5,padding:'5px 7px',cursor:clickable?'pointer':'default'}}>
      <div style={{display:'flex',alignItems:'center',gap:4,marginBottom:3}}>
        {loading
          ?<div style={{width:7,height:7,borderRadius:'50%',border:`1.5px solid ${col}`,borderTopColor:'transparent',flexShrink:0,animation:'spin 0.7s linear infinite'}}/>
          :<div style={{width:4,height:4,borderRadius:'50%',background:col,flexShrink:0}}/>}
        <div style={{fontSize:7.5,color:dark?'rgba(154,152,144,0.75)':C.txLight,fontFamily:SANS,textTransform:'uppercase',letterSpacing:'0.06em',lineHeight:1}}>{label}</div>
      </div>
      <div style={{fontSize:10,fontWeight:500,color:col,fontFamily:MONO,lineHeight:1.3,wordBreak:'break-word'}}>
        {loading ? 'loading…' : hasVal ? val : '— tap to retry'}
      </div>
    </div>
  );
}

function SkeletonCard() {
  const b=(w,h,x={})=><div style={{width:w,height:h,borderRadius:2,background:'rgba(255,255,255,0.06)',animation:'shimmer 1.8s ease-in-out infinite',...x}}/>;
  return (
    <div style={{background:C.deepBg,border:`1px solid ${C.accent}`,borderTop:'3px solid rgba(184,160,112,0.35)',borderRadius:2,padding:'24px 22px',display:'flex',flexDirection:'column',height:'100%'}}>
      <div style={{display:'flex',justifyContent:'space-between',marginBottom:14}}>
        <div style={{flex:1}}>{b(80,9,{marginBottom:8})}{b(140,26,{marginBottom:6})}{b(160,11)}</div>
        <div>{b(56,26,{marginBottom:8})}{b(60,9)}</div>
      </div>
      {b(130,18,{marginBottom:14})}
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:5,marginBottom:14}}>
        {[0,1,2,3,4,5].map(i=><div key={i} style={{height:52,borderRadius:4,background:'rgba(255,255,255,0.04)',animation:'shimmer 1.8s ease-in-out infinite',animationDelay:`${i*0.08}s`}}/>)}
      </div>
      <div style={{flex:1}}>{b('100%',44)}</div>
    </div>
  );
}

function FeatureCard({stock,rank,onSignalRetry,isNew=false}) {
  if (!stock) return <SkeletonCard/>;
  const sc=Math.min(stock.score||0,6), rating=getRating(sc);
  const chgPos=stock.change?.startsWith('+');
  const exchange=stock.exchange||(US_SET.has(stock.ticker)?'NYSE':'INTL');
  return (
    <div style={{background:C.deepBg,border:`1px solid ${C.accent}`,borderTop:`3px solid ${isNew?'#7EC87A':C.gold}`,borderRadius:2,padding:'24px 22px',position:'relative',animation:isNew?'fadeUpNew 0.5s ease both':'fadeUp 0.4s ease both',display:'flex',flexDirection:'column',height:'100%'}}>
      {isNew&&<div style={{position:'absolute',top:10,left:14,fontSize:8,fontFamily:SANS,letterSpacing:'0.12em',textTransform:'uppercase',color:'#7EC87A',background:'rgba(126,200,122,0.12)',border:'0.5px solid rgba(126,200,122,0.3)',padding:'2px 6px',borderRadius:2}}>↑ Promoted</div>}
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:16,marginTop:isNew?20:0}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:9,color:C.gold,fontFamily:SANS,letterSpacing:'0.15em',textTransform:'uppercase',marginBottom:6}}>Rank {RANK_LABELS[rank-1]}</div>
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:5,flexWrap:'wrap'}}>
            <span style={{fontSize:26,fontWeight:700,fontFamily:FONTS,color:'#F1EFE8',letterSpacing:'0.02em'}}>{stock.ticker}</span>
            <span style={{fontSize:9,fontFamily:SANS,padding:'2px 6px',borderRadius:2,letterSpacing:'0.08em',background:'rgba(184,160,112,0.15)',color:C.gold,border:'0.5px solid rgba(184,160,112,0.3)',flexShrink:0}}>{exchange}</span>
            <span style={{fontSize:8,fontFamily:SANS,fontWeight:600,padding:'2px 8px',borderRadius:20,letterSpacing:'0.06em',textTransform:'uppercase',background:rating.bg,color:rating.color,border:`0.5px solid ${rating.border}`,flexShrink:0}}>{rating.label}</span>
          </div>
          <div style={{fontSize:11,color:C.txLight,fontFamily:SANS}}>{stock.company||''}</div>
        </div>
        <div style={{textAlign:'right',flexShrink:0,marginLeft:12}}>
          <div style={{fontSize:26,fontWeight:400,fontFamily:MONO,color:scoreColor(sc,true),lineHeight:1}}>{sc}<span style={{color:'rgba(154,152,144,0.5)'}}>/6</span></div>
          <div style={{marginTop:6,display:'flex',justifyContent:'flex-end'}}><ScoreDots score={sc} dark/></div>
        </div>
      </div>
      <div style={{marginBottom:14}}>
        <span style={{fontSize:18,fontFamily:MONO,fontWeight:400,color:'#F1EFE8'}}>{stock.price||'--'}</span>
        {stock.change&&<span style={{fontSize:12,marginLeft:8,color:chgPos?'#80C080':C.red,fontFamily:MONO}}>{stock.change}</span>}
        {stock.marketCap&&<span style={{fontSize:11,marginLeft:8,color:C.txLight,fontFamily:SANS}}>{stock.marketCap}</span>}
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:5,marginBottom:14}}>
        {SIG_LABELS.map((label,i)=>{
          const sig=(stock.signals||[])[i]||{};
          return <SigPill key={i} sig={sig} label={label} dark signalIndex={i} loading={sig._loading||false} onRetry={onSignalRetry?(idx)=>onSignalRetry(stock.ticker,idx):undefined}/>;
        })}
      </div>
      <div style={{flex:1,minHeight:44,padding:'10px 12px',background:'rgba(241,239,232,0.04)',borderRadius:2,border:'0.5px solid rgba(184,160,112,0.2)'}}>
        <span style={{fontSize:11,color:C.txLight,fontFamily:SANS,lineHeight:1.55}}>{stock.summary||''}</span>
      </div>
      <div style={{position:'absolute',top:14,right:18,fontSize:9,color:'rgba(154,152,144,0.5)',fontFamily:MONO}}>
        {stock.updatedAt?new Date(stock.updatedAt).toLocaleTimeString():''}
      </div>
    </div>
  );
}

function ArrowBtn({dir,onClick,disabled}) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{width:40,height:40,borderRadius:'50%',background:disabled?'rgba(58,56,50,0.5)':C.deepBg,border:`1px solid ${disabled?'rgba(184,160,112,0.15)':C.gold}`,color:disabled?'rgba(184,160,112,0.2)':C.gold,display:'flex',alignItems:'center',justifyContent:'center',cursor:disabled?'not-allowed':'pointer',padding:0,flexShrink:0}}>
      {dir==='left'
        ?<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6z"/></svg>
        :<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>}
    </button>
  );
}

function PageDots({total,active,onChange}) {
  return (
    <div style={{display:'flex',gap:6,alignItems:'center'}}>
      {Array.from({length:total}).map((_,i)=>(
        <button key={i} onClick={()=>onChange(i)}
          style={{width:i===active?20:6,height:6,borderRadius:3,background:i===active?C.gold:'rgba(184,160,112,0.3)',border:'none',padding:0,cursor:'pointer',transition:'all 0.25s ease'}}/>
      ))}
    </div>
  );
}

function ResultCard({stock,rank,onSignalRetry}) {
  const sc=Math.min(stock.score||0,6), rating=getRating(sc);
  const chgPos=stock.change?.startsWith('+');
  const accentL=sc>=5?C.gold:sc>=4?C.greenBd:sc>=3?C.amberBd:C.borderDk;
  const rnk=rank===1?{bg:C.gold,color:'#2C2C2A'}:rank===2?{bg:C.accent,color:'#F1EFE8'}:rank===3?{bg:C.accentDk,color:'#F1EFE8'}:{bg:C.border,color:C.txMid};
  return (
    <div style={{background:C.cardBg,borderRadius:2,border:`0.5px solid ${C.borderDk}`,borderLeft:`3px solid ${accentL}`,padding:'14px 16px'}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:10,marginBottom:10}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <div style={{width:26,height:26,borderRadius:2,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:600,fontFamily:MONO,flexShrink:0,background:rnk.bg,color:rnk.color}}>{rank}</div>
          <div>
            <div style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
              <span style={{fontSize:16,fontWeight:700,fontFamily:FONTS,letterSpacing:'0.02em',color:C.tx}}>{stock.ticker}</span>
              <span style={{fontSize:8,fontFamily:SANS,padding:'2px 5px',borderRadius:2,letterSpacing:'0.06em',background:C.darkBg,color:'#F1EFE8'}}>{stock.exchange||(US_SET.has(stock.ticker)?'NYSE':'INTL')}</span>
              <span style={{fontSize:9,fontFamily:SANS,fontWeight:600,padding:'2px 8px',borderRadius:20,letterSpacing:'0.06em',textTransform:'uppercase',background:rating.bg,color:rating.color,border:`0.5px solid ${rating.border}`}}>{rating.label}</span>
            </div>
            <div style={{fontSize:11,color:C.txMid,marginTop:2,fontFamily:SANS}}>{stock.company||''}</div>
            {stock.price&&<div style={{fontSize:11,color:C.txMid,fontFamily:MONO,marginTop:2}}>
              {stock.price}
              {stock.change&&<span style={{marginLeft:6,color:chgPos?C.green:C.red}}>{stock.change}</span>}
              {stock.marketCap&&<span style={{marginLeft:6,color:C.txLight}}>{stock.marketCap}</span>}
            </div>}
          </div>
        </div>
        <div style={{textAlign:'right',flexShrink:0,display:'flex',flexDirection:'column',alignItems:'flex-end',gap:8}}>
          <div style={{fontSize:22,fontWeight:400,fontFamily:MONO,color:scoreColor(sc),lineHeight:1}}>{sc}<span style={{color:C.txLight}}>/6</span></div>
          <ScoreDots score={sc}/>
        </div>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:4,marginBottom:8}}>
        {SIG_LABELS.map((label,i)=>{
          const sig=(stock.signals||[])[i]||{};
          return <SigPill key={i} sig={sig} label={label} signalIndex={i} loading={sig._loading||false} onRetry={onSignalRetry?(idx)=>onSignalRetry(stock.ticker,idx):undefined}/>;
        })}
      </div>
      {stock.summary&&<div style={{fontSize:11,color:C.txMid,borderTop:`0.5px solid ${C.border}`,paddingTop:8,lineHeight:1.55,fontFamily:SANS}}>
        {stock.summary}<span style={{marginLeft:8,fontSize:9,color:C.txLight,fontFamily:MONO}}>· {stock.updatedAt?new Date(stock.updatedAt).toLocaleTimeString():''}</span>
      </div>}
      {stock.error&&<div style={{fontSize:11,color:C.red,borderTop:`0.5px solid ${C.border}`,paddingTop:8,fontFamily:SANS}}>Error: {stock.error}</div>}
    </div>
  );
}

function BatchProgress({completed,total}) {
  const pct=total>0?Math.round((completed/total)*100):0;
  return (
    <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:16}}>
      <div style={{flex:1,height:2,background:'rgba(95,94,86,0.2)',borderRadius:1,overflow:'hidden'}}>
        <div style={{height:'100%',width:`${pct}%`,background:C.gold,transition:'width 0.5s ease',borderRadius:1}}/>
      </div>
      <span style={{fontSize:9,color:C.txLight,fontFamily:MONO,whiteSpace:'nowrap',minWidth:56}}>
        {pct < 100 ? `${pct}% scanned` : '100% scanned'}
      </span>
    </div>
  );
}

async function callAnalyse(tickers, universePECache = {}) {
  const res = await fetch('/api/analyse',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tickers, universePECache})});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function fetchBatch(idx, refresh=false) {
  const res = await fetch(`/api/top3?batch=${idx}${refresh?'&refresh=1':''}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export default function Home() {
  useFonts();

  const [input,setInput]               = useState('');
  const [results,setResults]           = useState([]);
  const [scanning,setScanning]         = useState(false);
  const [status,setStatus]             = useState('');
  const [filter,setFilter]             = useState('all');
  const [updatedAt,setUpdatedAt]       = useState('');
  const [activePreset,setActivePreset] = useState('');
  const [topPicks,setTopPicks]         = useState(Array(TOTAL_PICKS).fill(null));
  const [topStatus,setTopStatus]       = useState('Loading megacaps…');
  const [batchesCompleted,setBatchesCompleted] = useState(0);
  const [batchScanning,setBatchScanning]       = useState(true);
  const [newlyPromoted,setNewlyPromoted]       = useState(new Set());
  const [carouselPage,setCarouselPage] = useState(0);
  const [transitioning,setTransitioning] = useState(false);
  const [animPhase,setAnimPhase]         = useState('idle');
  const [rescanCountdown,setRescanCountdown] = useState('');

  const timerRef       = useRef(null);
  const rescanTimerRef = useRef(null);
  const rescanStartRef = useRef(Date.now());
  const tickersRef     = useRef([]);
  const allStocksRef   = useRef(new Map());
  // Accumulated PE data from all universe scans — used as free peer PE lookup
  const universePECacheRef = useRef({});
  const totalPages     = Math.ceil(TOTAL_PICKS / PAGE_SIZE);

  const recomputeTopPicks = useCallback((promoted=new Set())=>{
    const all=Array.from(allStocksRef.current.values())
      .filter(s=>s&&!s.error&&s.score!=null)
      .sort((a,b)=>{const sd=(b.score||0)-(a.score||0);return sd!==0?sd:new Date(b.updatedAt||0)-new Date(a.updatedAt||0);});
    setTopPicks(Array(TOTAL_PICKS).fill(null).map((_,i)=>all[i]||null));
    if(promoted.size>0) setNewlyPromoted(promoted);
  },[]);

  const mergePool = useCallback((stockMap,source,promoted=new Set())=>{
    for(const [ticker,stock] of Object.entries(stockMap)){
      if(!stock||stock.error) continue;
      const ex=allStocksRef.current.get(ticker);
      if(!ex||(stock.score??0)>=(ex.score??0)) allStocksRef.current.set(ticker,{...stock,_source:source});
    }
    recomputeTopPicks(promoted);
  },[recomputeTopPicks]);

  const updatePool = useCallback((ticker,updater)=>{
    const ex=allStocksRef.current.get(ticker);
    if(ex){allStocksRef.current.set(ticker,updater(ex));recomputeTopPicks();}
  },[recomputeTopPicks]);

  const goToPage = useCallback((p)=>{
    if(transitioning||p===carouselPage) return;
    setTransitioning(true);setAnimPhase('exit');
    setTimeout(()=>{setCarouselPage(p);setAnimPhase('enter');setTimeout(()=>{setAnimPhase('idle');setTransitioning(false);},150);},100);
  },[transitioning,carouselPage]);

  const prevPage=useCallback(()=>{if(carouselPage>0)goToPage(carouselPage-1);},[carouselPage,goToPage]);
  const nextPage=useCallback(()=>{if(carouselPage<totalPages-1)goToPage(carouselPage+1);},[carouselPage,totalPages,goToPage]);

  useEffect(()=>{
    const h=e=>{if(e.target.tagName==='INPUT')return;if(e.key==='ArrowRight')nextPage();if(e.key==='ArrowLeft')prevPage();};
    window.addEventListener('keydown',h);return()=>window.removeEventListener('keydown',h);
  },[nextPage,prevPage]);

  const runBatch = useCallback(async(batchIndex,isBackground=false,refresh=false)=>{
    try {
      const batchData = await fetchBatch(batchIndex,refresh);
      const {candidates=[],stockMeta={},allScored=[],universePECache={}} = batchData;
      if (!candidates.length) return;
      // Merge universe PE data into our cache
      Object.assign(universePECacheRef.current, universePECache || {});
      const pool = allStocksRef.current;
      const toAnalyse = isBackground
        ? candidates.filter(t=>{const ex=pool.get(t);const qs=(allScored||[]).find(s=>s.symbol===t)?.qs||0;return !ex||qs>(ex._qs||0);}).slice(0,10)
        : candidates;
      if (!toAnalyse.length) return;
      // Pass the accumulated PE cache so analyse.js can use it for peer PEs
      const data = await callAnalyse(toAnalyse, universePECacheRef.current);
      const top9 = Array.from(pool.values()).filter(s=>s&&!s.error&&s.score!=null).sort((a,b)=>(b.score||0)-(a.score||0)).slice(0,TOTAL_PICKS);
      const worstScore = top9.length>=TOTAL_PICKS?(top9[TOTAL_PICKS-1]?.score||0):0;
      const promoted = new Set();
      for(const [ticker,stock] of Object.entries(data.results||{})){
        if(!stock||stock.error) continue;
        const qs=(allScored||[]).find(s=>s.symbol===ticker)?.qs||0;
        const exchange=(stock.exchange&&stock.exchange!=='NYSE'&&stock.exchange!=='INTL')?stock.exchange:(stockMeta[ticker]?.exchange||stock.exchange);
        pool.set(ticker,{...stock,exchange,_qs:qs,_source:'auto'});
        if(isBackground&&(stock.score||0)>worstScore) promoted.add(ticker);
      }
      recomputeTopPicks(promoted);
    } catch(_) {}
  },[recomputeTopPicks]);

  const runAllBatches = useCallback(async(refresh=false)=>{
    setBatchScanning(true);
    setTopStatus('Loading megacaps…');
    await runBatch(0,false,refresh);
    setBatchesCompleted(1);
    setTopStatus('Megacaps loaded · scanning remaining sectors…');
    for(let i=1;i<TOTAL_BATCHES;i++){
      await runBatch(i,true,refresh);
      setBatchesCompleted(i+1);
      if(i<TOTAL_BATCHES-1) setTopStatus(`Scanning sectors… (${i+1}/${TOTAL_BATCHES})`);
      await new Promise(r=>setTimeout(r,400));
    }
    setTopStatus(`Full universe scanned · ${new Date().toLocaleTimeString()}`);
    setBatchScanning(false);
  },[runBatch]);

  useEffect(()=>{
    let live=true;
    runAllBatches();
    rescanTimerRef.current=setInterval(()=>{if(live)runAllBatches(true);},RESCAN_MS);
    rescanStartRef.current=Date.now();
    return()=>{live=false;clearInterval(rescanTimerRef.current);};
  },[runAllBatches]);

  useEffect(()=>{
    if(newlyPromoted.size===0) return;
    const t=setTimeout(()=>setNewlyPromoted(new Set()),30000);
    return()=>clearTimeout(t);
  },[newlyPromoted]);

  useEffect(()=>{
    const tick=setInterval(()=>{
      const rem=RESCAN_MS-((Date.now()-rescanStartRef.current)%RESCAN_MS);
      const m=Math.floor(rem/60000),s=Math.floor((rem%60000)/1000);
      setRescanCountdown(`${m}:${String(s).padStart(2,'0')}`);
    },1000);
    return()=>clearInterval(tick);
  },[]);

  const retrySignal=useCallback(async(ticker,signalIndex)=>{
    const mark=s=>{const sigs=[...(s.signals||Array(6).fill({status:'neutral',value:''}))];sigs[signalIndex]={...(sigs[signalIndex]||{}),_loading:true};return{...s,signals:sigs};};
    updatePool(ticker,mark);setResults(prev=>prev.map(s=>s?.ticker===ticker?mark(s):s));
    try{
      const data=await callAnalyse([ticker]);
      const fresh=data?.results?.[ticker];
      const ns=fresh?.signals?.[signalIndex]||{status:'neutral',value:'No data'};
      const apply=s=>{const sigs=[...(s.signals||Array(6).fill({status:'neutral',value:''}))];sigs[signalIndex]={...ns,_loading:false};return{...s,signals:sigs,score:sigs.filter(x=>x.status==='pass').length};};
      updatePool(ticker,apply);setResults(prev=>prev.map(s=>s?.ticker===ticker?apply(s):s));
    }catch(_){
      const clear=s=>{const sigs=[...(s.signals||[])];if(sigs[signalIndex])sigs[signalIndex]={...sigs[signalIndex],_loading:false};return{...s,signals:sigs};};
      updatePool(ticker,clear);setResults(prev=>prev.map(s=>s?.ticker===ticker?clear(s):s));
    }
  },[updatePool]);

  const scan=useCallback(async(tickers)=>{
    setScanning(true);setStatus(`Analysing ${tickers.length} tickers…`);
    try{
      const data=await callAnalyse(tickers, universePECacheRef.current);
      const arr=Object.values(data.results||{}).filter(Boolean).sort((a,b)=>(b.score||0)-(a.score||0));
      setResults(arr);setUpdatedAt(new Date().toLocaleTimeString());setStatus('');
      mergePool(data.results||{},'custom');
    }catch(e){setStatus(`Error: ${e.message}`);}
    finally{setScanning(false);}
  },[mergePool]);

  function runScan(){
    const tickers=input.split(/[\s,;]+/).map(t=>t.toUpperCase().trim()).filter(Boolean).slice(0,20);
    if(!tickers.length) return;
    tickersRef.current=tickers;clearInterval(timerRef.current);setResults([]);
    scan(tickers);timerRef.current=setInterval(()=>scan(tickersRef.current),5*60*1000);
  }
  useEffect(()=>()=>clearInterval(timerRef.current),[]);

  const filtered=results.filter(r=>{
    if(filter==='strong') return(r.score||0)>=5;
    if(filter==='mod')    return(r.score||0)===3||(r.score||0)===4;
    if(filter==='weak')   return(r.score||0)<=2;
    if(filter==='us')     return US_SET.has(r.ticker);
    if(filter==='intl')   return !US_SET.has(r.ticker);
    return true;
  });

  const pageStart=carouselPage*PAGE_SIZE;
  const currentCards=[...topPicks.slice(pageStart,pageStart+PAGE_SIZE)];
  while(currentCards.length<PAGE_SIZE) currentCards.push(null);

  return (
    <div style={{background:C.pageBg,minHeight:'100vh',color:C.tx,fontFamily:SANS}}>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0;}
        html,body{-webkit-font-smoothing:antialiased;background:${C.pageBg};}
        ::selection{background:${C.gold};color:#2C2C2A;}
        input::placeholder{color:${C.txLight};}input:focus{outline:none;}
        button{cursor:pointer;transition:opacity 0.14s,all 0.2s;}
        button:not(:disabled):hover{opacity:0.76;}
        button:disabled{opacity:0.38;cursor:not-allowed;}
        @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        @keyframes fadeUpNew{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
        @keyframes shimmer{0%,100%{opacity:0.5}50%{opacity:0.85}}
        @keyframes spin{to{transform:rotate(360deg)}}
      `}</style>

      {/* Header */}
      <div style={{background:C.deepBg,borderBottom:'1px solid rgba(184,160,112,0.3)',padding:'0 32px'}}>
        <div style={{maxWidth:1200,margin:'0 auto',display:'flex',alignItems:'center',justifyContent:'space-between',height:64}}>
          <div style={{display:'flex',alignItems:'center',gap:16}}>
            <div style={{width:32,height:32,border:`1px solid ${C.gold}`,display:'flex',alignItems:'center',justifyContent:'center'}}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill={C.gold}><path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z"/></svg>
            </div>
            <div>
              <div style={{fontSize:18,fontFamily:FONTS,fontWeight:600,color:'#F1EFE8',letterSpacing:'0.08em'}}>SIGNAL ENGINE</div>
              <div style={{fontSize:9,color:C.gold,fontFamily:SANS,letterSpacing:'0.18em',textTransform:'uppercase',marginTop:1}}>Equity Undervalue Scanner</div>
            </div>
          </div>
          <div style={{textAlign:'right',fontSize:10,color:C.txLight,fontFamily:MONO,lineHeight:1.8}}>
            <div style={{display:'flex',alignItems:'center',gap:6,justifyContent:'flex-end'}}>
              <div style={{width:6,height:6,borderRadius:'50%',background:batchScanning||scanning?C.gold:C.txLight}}/>
              <span style={{color:'#F1EFE8'}}>{scanning?'Scanning…':batchScanning?'Discovering…':'Ready'}</span>
            </div>
            {updatedAt&&<div>Updated {updatedAt}</div>}
            <div style={{fontSize:9,color:'rgba(154,152,144,0.5)'}}>rescan in {rescanCountdown}</div>
          </div>
        </div>
      </div>

      <div style={{maxWidth:1200,margin:'0 auto',padding:'32px 32px 80px'}}>

        {/* Top Picks */}
        <div style={{marginBottom:16}}>
          <div style={{display:'flex',alignItems:'baseline',gap:16,marginBottom:12}}>
            <h2 style={{fontSize:36,fontFamily:FONTS,fontWeight:600,color:C.tx,letterSpacing:'0.02em'}}>Top Picks Today</h2>
            <div style={{height:'0.5px',flex:1,background:C.borderDk}}/>
            <div style={{fontSize:9.5,color:C.txLight,fontFamily:SANS,letterSpacing:'0.1em',textTransform:'uppercase',whiteSpace:'nowrap'}}>{topStatus}</div>
          </div>

          <BatchProgress completed={batchesCompleted} total={TOTAL_BATCHES}/>

          <div style={{position:'relative'}}>
            <div style={{position:'absolute',left:-20,top:'50%',transform:'translateY(-50%)',zIndex:10}}>
              <ArrowBtn dir="left" onClick={prevPage} disabled={carouselPage===0}/>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:16,opacity:animPhase==='exit'?0:1,transition:animPhase==='exit'?'opacity 0.1s ease':'opacity 0.15s ease'}}>
              {currentCards.map((stock,i)=>(
                <FeatureCard key={stock?stock.ticker:`sk-${pageStart+i}`} stock={stock} rank={pageStart+i+1} onSignalRetry={retrySignal} isNew={stock?newlyPromoted.has(stock.ticker):false}/>
              ))}
            </div>
            <div style={{position:'absolute',right:-20,top:'50%',transform:'translateY(-50%)',zIndex:10}}>
              <ArrowBtn dir="right" onClick={nextPage} disabled={carouselPage===totalPages-1}/>
            </div>
          </div>
          <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:16,marginTop:14}}>
            <PageDots total={totalPages} active={carouselPage} onChange={goToPage}/>
            <span style={{fontSize:9,color:C.txLight,fontFamily:MONO,letterSpacing:'0.1em'}}>
              {pageStart+1}–{Math.min(pageStart+PAGE_SIZE,TOTAL_PICKS)} of {TOTAL_PICKS}
            </span>
          </div>
        </div>

        {/* Custom Scan */}
        <div style={{display:'flex',alignItems:'center',gap:16,marginBottom:20}}>
          <h2 style={{fontSize:36,fontFamily:FONTS,fontWeight:600,color:C.tx,letterSpacing:'0.02em',whiteSpace:'nowrap'}}>Custom Scan</h2>
          <div style={{height:'0.5px',flex:1,background:C.borderDk}}/>
        </div>
        <div style={{background:C.cardBg,border:`0.5px solid ${C.borderDk}`,padding:'20px',marginBottom:20}}>
          <div style={{display:'flex',gap:10,marginBottom:14}}>
            <input type="text" value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&runScan()}
              placeholder="AAPL, MSFT, NVDA, TSM…"
              style={{flex:1,background:C.pageBg,border:`0.5px solid ${C.borderDk}`,padding:'10px 14px',fontSize:13,fontFamily:MONO,color:C.tx,borderRadius:0}}/>
            <button onClick={runScan} disabled={scanning}
              style={{padding:'10px 24px',background:C.darkBg,color:'#F1EFE8',border:'none',fontSize:12,fontFamily:SANS,fontWeight:500,letterSpacing:'0.1em',textTransform:'uppercase'}}>
              {scanning?'Scanning…':'Scan'}
            </button>
            {results.length>0&&<>
              <button onClick={()=>scan(tickersRef.current)} disabled={scanning} style={{padding:'10px 16px',background:'transparent',color:C.txMid,border:`0.5px solid ${C.borderDk}`,fontSize:12,fontFamily:SANS}}>Refresh</button>
              <button onClick={()=>{setResults([]);tickersRef.current=[];setUpdatedAt('');}} style={{padding:'10px 16px',background:'transparent',color:C.txMid,border:`0.5px solid ${C.borderDk}`,fontSize:12,fontFamily:SANS}}>Clear</button>
            </>}
          </div>
          <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
            <span style={{fontSize:9,color:C.txLight,fontFamily:SANS,letterSpacing:'0.12em',textTransform:'uppercase',marginRight:4}}>Sectors</span>
            {Object.keys(PRESETS).map(name=>{
              const active=activePreset===name;
              return <button key={name} onClick={()=>{setInput(PRESETS[name]);setActivePreset(name);}}
                style={{padding:'4px 12px',fontSize:10,fontFamily:SANS,letterSpacing:'0.06em',background:active?C.darkBg:'transparent',color:active?'#F1EFE8':C.txMid,border:`0.5px solid ${active?C.darkBg:C.borderDk}`,borderRadius:0,whiteSpace:'nowrap'}}>{name}</button>;
            })}
          </div>
        </div>

        <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center',marginBottom:16}}>
          <span style={{fontSize:9,color:C.txLight,fontFamily:SANS,letterSpacing:'0.12em',textTransform:'uppercase',marginRight:4}}>Filter</span>
          {[['all','All'],['strong','Strong 5–6'],['mod','Moderate 3–4'],['weak','Weak 0–2'],['us','US'],['intl','International']].map(([k,l])=>{
            const active=filter===k;
            return <button key={k} onClick={()=>setFilter(k)}
              style={{padding:'4px 12px',fontSize:10,fontFamily:SANS,letterSpacing:'0.06em',background:active?C.accentDk:'transparent',color:active?'#F1EFE8':C.txMid,border:`0.5px solid ${active?C.accentDk:C.borderDk}`,borderRadius:0}}>{l}</button>;
          })}
        </div>

        {scanning&&<div style={{display:'flex',alignItems:'center',gap:8,fontSize:11,color:C.txMid,fontFamily:MONO,marginBottom:12}}>
          <div style={{width:11,height:11,border:`1.5px solid ${C.border}`,borderTopColor:C.gold,borderRadius:'50%',flexShrink:0,animation:'spin 0.7s linear infinite'}}/>{status}
        </div>}
        {!scanning&&status&&<div style={{fontSize:11,color:C.red,fontFamily:MONO,marginBottom:12}}>{status}</div>}

        {filtered.length===0&&!scanning?(
          <div style={{textAlign:'center',padding:'48px 16px',color:C.txLight,fontFamily:FONTS,fontSize:18,fontStyle:'italic',fontWeight:300}}>
            {results.length>0?'No results match this filter.':'Select a sector or enter tickers above to begin scanning.'}
          </div>
        ):(
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            {filtered.map((stock,i)=><ResultCard key={stock.ticker} stock={stock} rank={i+1} onSignalRetry={retrySignal}/>)}
          </div>
        )}

        {results.length>0&&(
          <div style={{display:'flex',gap:8,marginTop:24,paddingTop:20,borderTop:`0.5px solid ${C.borderDk}`,flexWrap:'wrap',alignItems:'center'}}>
            <span style={{fontSize:10,color:C.txLight,fontFamily:MONO,flex:1,letterSpacing:'0.06em'}}>{filtered.length} securities · export</span>
            <button onClick={()=>{
              const hdr=['Rank','Ticker','Company','Score','Price','Change','MktCap','EPS beat','PE hist','vs50dMA','Insider','Analyst','PE vs peers','Summary'];
              const rows=filtered.map((r,i)=>{const g=r.signals||[];return[i+1,r.ticker,`"${(r.company||'').replace(/"/g,'""')}"`,r.score||0,r.price||'',r.change||'',r.marketCap||'',g[0]?.value||'',g[1]?.value||'',g[2]?.value||'',g[3]?.value||'',g[4]?.value||'',g[5]?.value||'',`"${(r.summary||'').replace(/"/g,'""')}"`].join(',');});
              const blob=new Blob([[hdr.join(',')].concat(rows).join('\n')],{type:'text/csv'});
              const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`signals_${new Date().toISOString().slice(0,10)}.csv`;a.click();
            }} style={{padding:'8px 18px',background:'transparent',color:C.txMid,border:`0.5px solid ${C.borderDk}`,fontSize:11,fontFamily:SANS}}>CSV</button>
            <button onClick={()=>{
              const blob=new Blob([JSON.stringify(filtered.map((r,i)=>({rank:i+1,...r})),null,2)],{type:'application/json'});
              const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`signals_${new Date().toISOString().slice(0,10)}.json`;a.click();
            }} style={{padding:'8px 18px',background:'transparent',color:C.txMid,border:`0.5px solid ${C.borderDk}`,fontSize:11,fontFamily:SANS}}>JSON</button>
          </div>
        )}
      </div>
    </div>
  );
}
