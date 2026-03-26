import { useState, useEffect, useRef, useCallback } from 'react';
import Head from 'next/head';
 
const UNIVERSE = ['AAPL','MSFT','GOOGL','AMZN','META','NVDA','AVGO','ORCL','ADBE','INTU','AMD','INTC','QCOM','TXN','AMAT','MU','CSCO','IBM','ACN','HPQ','NOW','CRM','PANW','FTNT','KLAC','LRCX','SNPS','CDNS','JPM','BAC','WFC','GS','MS','BLK','C','AXP','SCHW','USB','PNC','TFC','COF','DFS','AIG','MET','PRU','AFL','CB','TRV','CME','ICE','SPGI','MCO','MA','V','LLY','JNJ','UNH','ABBV','MRK','PFE','TMO','ABT','AMGN','CVS','MDT','ISRG','BSX','SYK','REGN','BIIB','VRTX','CI','HUM','ELV','XOM','CVX','COP','EOG','SLB','MPC','PSX','VLO','OXY','DVN','HAL','BKR','HES','TPL','HD','MCD','NKE','SBUX','LOW','TGT','COST','WMT','TJX','ROST','BKNG','MAR','HLT','YUM','CMG','DRI','TSCO','ORLY','AZO','KO','PEP','PG','PM','MO','KHC','GIS','HSY','MDLZ','CL','CLX','CHD','SYY','KR','CAG','MKC','HRL','TSN','CAT','HON','MMM','GE','RTX','LMT','NOC','GD','UPS','FDX','UNP','CSX','NSC','DE','EMR','ROK','ITW','ETN','PH','DOV','LIN','APD','ECL','NEM','FCX','PPG','SHW','T','VZ','TMUS','NEE','DUK','SO','AEP','EXC','AMT','PLD','EQIX','CCI','SPG','O','VICI','TSM','ASML','NVO','SAP','TM','AZN','HSBC','SHEL','BHP','RIO','NVS','UL','DEO','BTI','GSK'];
const UNIQ = [...new Set(UNIVERSE)];
 
// Improved quick-score: weights PE more heavily, penalises missing PE less,
// and boosts stocks near fair value rather than near distressed lows.
function quickScore(s) {
  if (!s.marketCap || s.marketCap < 2_000_000_000) return null;
  let n = 0;
 
  // PE value — strongest signal for undervaluation
  if (s.peRatio && s.peRatio > 0 && s.peRatio <= 150) {
    if      (s.peRatio <= 10) n += 50;
    else if (s.peRatio <= 15) n += 40;
    else if (s.peRatio <= 20) n += 30;
    else if (s.peRatio <= 28) n += 18;
    else if (s.peRatio <= 40) n += 8;
    else                      n += 2;
  } else if (!s.peRatio) {
    // No PE: don't penalise, but don't boost — neutral
    n += 5;
  }
 
  // Price position: mild boost for being below recent highs (potential bounce)
  // but NOT rewarding stocks that are crashing
  if (s.pctFromHigh > 60)      n -= 10; // likely distressed — small penalty
  else if (s.pctFromHigh > 40) n += 0;  // significant pullback — neutral
  else if (s.pctFromHigh > 20) n += 8;  // healthy pullback — mild boost
  else if (s.pctFromHigh > 10) n += 12; // minor dip — good entry
  else                          n += 5;  // near 52w high — priced in
 
  // Size: larger caps have better signal data coverage
  if      (s.marketCap > 500e9) n += 15;
  else if (s.marketCap > 100e9) n += 10;
  else if (s.marketCap >  20e9) n += 5;
  else if (s.marketCap >   5e9) n += 2;
 
  return n > 0 ? n : null;
}
 
var PRESETS={'Mega-cap':'AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,JPM,XOM,UNH','Technology':'AAPL,MSFT,NVDA,AVGO,ORCL,AMD,INTC,QCOM,TXN,AMAT','Finance':'JPM,BAC,WFC,GS,MS,BLK,C,AXP,SCHW,USB','Healthcare':'LLY,JNJ,UNH,ABBV,MRK,PFE,TMO,ABT,AMGN,CVS','Energy':'XOM,CVX,COP,EOG,SLB,MPC,PSX,VLO,OXY,DVN','Consumer':'AMZN,TSLA,HD,MCD,NKE,SBUX,LOW,TGT,COST,WMT','International':'TSM,ASML,NVO,SAP,TM,SHEL,BHP,RIO,AZN,HSBC','Dividend':'T,VZ,MO,PM,XOM,CVX,JNJ,KO,PEP,IBM'};
var SIG_LABELS=['EPS & Rev beat','PE vs hist avg','Price vs 50d MA','Insider buying','Analyst +25% upside','PE vs peers'];
var US_SET=new Set('AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,JPM,XOM,UNH,LLY,AVGO,ORCL,AMD,INTC,QCOM,TXN,AMAT,MU,ADBE,BAC,WFC,GS,MS,BLK,C,AXP,SCHW,USB,PNC,TFC,JNJ,ABBV,MRK,PFE,TMO,ABT,AMGN,CVS,MDT,ISRG,COP,EOG,SLB,MPC,PSX,VLO,OXY,DVN,HAL,BKR,CVX,HD,MCD,NKE,SBUX,LOW,TGT,GM,F,COST,WMT,T,VZ,MO,PM,KO,PEP,MMM,IBM'.split(','));
var XM={AAPL:'NASDAQ',MSFT:'NASDAQ',GOOGL:'NASDAQ',AMZN:'NASDAQ',META:'NASDAQ',NVDA:'NASDAQ',AVGO:'NASDAQ',ORCL:'NYSE',ADBE:'NASDAQ',INTU:'NASDAQ',AMD:'NASDAQ',INTC:'NASDAQ',QCOM:'NASDAQ',TXN:'NASDAQ',AMAT:'NASDAQ',MU:'NASDAQ',NOW:'NYSE',CRM:'NYSE',PANW:'NASDAQ',CSCO:'NASDAQ',IBM:'NYSE',HPQ:'NYSE',KLAC:'NASDAQ',LRCX:'NASDAQ',SNPS:'NASDAQ',CDNS:'NASDAQ',JPM:'NYSE',BAC:'NYSE',WFC:'NYSE',GS:'NYSE',MS:'NYSE',BLK:'NYSE',C:'NYSE',AXP:'NYSE',SCHW:'NYSE',USB:'NYSE',PNC:'NYSE',TFC:'NYSE',COF:'NYSE',DFS:'NYSE',AIG:'NYSE',MET:'NYSE',PRU:'NYSE',AFL:'NYSE',CB:'NYSE',TRV:'NYSE',CME:'NASDAQ',ICE:'NYSE',SPGI:'NYSE',MCO:'NYSE',MA:'NYSE',V:'NYSE',LLY:'NYSE',JNJ:'NYSE',UNH:'NYSE',ABBV:'NYSE',MRK:'NYSE',PFE:'NYSE',TMO:'NYSE',ABT:'NYSE',AMGN:'NASDAQ',CVS:'NYSE',MDT:'NYSE',ISRG:'NASDAQ',BSX:'NYSE',SYK:'NYSE',REGN:'NASDAQ',BIIB:'NASDAQ',VRTX:'NASDAQ',XOM:'NYSE',CVX:'NYSE',COP:'NYSE',EOG:'NYSE',SLB:'NYSE',MPC:'NYSE',PSX:'NYSE',VLO:'NYSE',OXY:'NYSE',DVN:'NYSE',HAL:'NYSE',BKR:'NYSE',HD:'NYSE',MCD:'NYSE',NKE:'NYSE',SBUX:'NASDAQ',LOW:'NYSE',TGT:'NYSE',COST:'NASDAQ',WMT:'NYSE',BKNG:'NASDAQ',MAR:'NASDAQ',CAT:'NYSE',HON:'NASDAQ',MMM:'NYSE',GE:'NYSE',RTX:'NYSE',LMT:'NYSE',NOC:'NYSE',GD:'NYSE',UPS:'NYSE',FDX:'NYSE',UNP:'NYSE',CSX:'NASDAQ',NSC:'NYSE',DE:'NYSE',KO:'NYSE',PEP:'NASDAQ',PG:'NYSE',PM:'NYSE',MO:'NYSE',T:'NYSE',VZ:'NYSE',TMUS:'NASDAQ',NEE:'NYSE',LIN:'NYSE',APD:'NYSE',ECL:'NYSE',NEM:'NYSE',FCX:'NYSE',AMT:'NYSE',PLD:'NYSE',EQIX:'NASDAQ',CCI:'NYSE',SPG:'NYSE',TSM:'NYSE',ASML:'NASDAQ',NVO:'NYSE',SAP:'NYSE',TM:'NYSE',AZN:'NASDAQ',HSBC:'NYSE',SHEL:'NYSE',BHP:'NYSE',RIO:'NYSE'};
function getExchange(s){return s.exchange||XM[s.ticker]||(US_SET.has(s.ticker)?'NYSE':'INTL');}
 
var C={pageBg:'#F1EFE8',cardBg:'#E8E5DC',darkBg:'#5F5E56',deepBg:'#3A3832',accent:'#8B7D6B',accentDk:'#6B5D4F',gold:'#B8A070',border:'rgba(95,94,86,0.2)',borderDk:'rgba(95,94,86,0.4)',tx:'#2C2C2A',txMid:'#5F5E56',txLight:'#9A9890',amber:'#B8903A',amberBg:'#F5EDD0',amberBd:'#D4B870',green:'#4A6741',greenBg:'#DDE8D8',greenBd:'#A8C0A0',red:'#7A3A30',redBg:'#F0DDD9',redBd:'#C8A09A'};
var FONTS="'Cormorant Garamond','Georgia',serif";
var SANS="'DM Sans','Helvetica Neue',sans-serif";
var MONO="'DM Mono','Courier New',monospace";
 
function getRating(s){if(s>=5)return{label:'Strong Buy',color:C.green,bg:C.greenBg,border:C.greenBd};if(s===4)return{label:'Buy',color:'#4A6741',bg:'#E8EEDF',border:'#B0C8A8'};if(s===3)return{label:'Watch',color:'#7A6030',bg:'#F0E8D0',border:'#C8A870'};return{label:'Ignore',color:C.txMid,bg:C.cardBg,border:C.border};}
function ScoreDots({score,max=6}){return <div style={{display:'flex',gap:4}}>{Array.from({length:max}).map((_,i)=>{var f=i<score,c=score>=5?C.green:score>=4?'#6A8B60':score>=3?'#B8903A':C.txLight;return <div key={i} style={{width:7,height:7,borderRadius:'50%',background:f?c:'transparent',border:'1px solid '+(f?c:C.borderDk)}}/>;})}</div>;}
function SigPill({sig}){var bg=sig.status==='pass'?C.greenBg:sig.status==='fail'?C.redBg:C.amberBg,color=sig.status==='pass'?C.green:sig.status==='fail'?C.red:C.amber,bd=sig.status==='pass'?C.greenBd:sig.status==='fail'?C.redBd:C.amberBd;return(<div style={{background:bg,border:'0.5px solid '+bd,borderRadius:6,padding:'5px 7px'}}><div style={{display:'flex',alignItems:'center',gap:4,marginBottom:3}}><div style={{width:5,height:5,borderRadius:'50%',background:color,flexShrink:0}}/><div style={{fontSize:8,color:C.txLight,fontFamily:SANS,textTransform:'uppercase',letterSpacing:'0.04em',lineHeight:1.2}}>{sig.label}</div></div><div style={{fontSize:10,fontWeight:500,color:color,fontFamily:MONO,lineHeight:1.3,wordBreak:'break-word'}}>{sig.value||'--'}</div></div>);}
function ScoreDisplay({score,size=22}){var sc=Math.min(score||0,6),c=sc>=5?C.gold:sc>=4?'#A8C080':sc>=3?'#C8A870':C.txLight;return <span style={{fontFamily:MONO,fontSize:size,fontWeight:400,letterSpacing:'0.05em',fontVariantNumeric:'tabular-nums',color:c,lineHeight:1}}>{sc}<span style={{opacity:0.5,margin:'0 1px'}}>/</span>6</span>;}
 
// ── Polygonal bull — traced faithfully from reference image ───────────────────
// The reference shows a low-poly bull facing right in charging pose.
// Outline colour = deepBg (#3A3832). Faces filled with three gold tones
// to simulate flat-shaded lighting from upper-right.
// viewBox 340×200 matches the approximate proportions of the reference.
function PolyBull() {
  const bg  = '#3A3832'; // deepBg — replaces black outline
  const L   = '#CBA96A'; // light face (upper surfaces, catching light)
  const M   = '#B8A070'; // mid face  (lateral surfaces) — the gold
  const D   = '#8B7355'; // dark face (lower surfaces, shadow)
  const S   = '#6B5840'; // deepest shadow (underside, legs)
  const str = bg;        // stroke colour — matches background so lines pop
  const sw  = '2';       // stroke width
 
  return (
    <svg viewBox="0 0 340 200" width="170" height="100" xmlns="http://www.w3.org/2000/svg" style={{display:'block'}}>
      {/* ════ BODY — main torso ════ */}
      {/* Upper back — light */}
      <polygon points="80,60 130,30 175,45 145,80" fill={L} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      {/* Upper mid — light */}
      <polygon points="130,30 175,45 200,25 165,10" fill={L} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      {/* Shoulder hump — lightest */}
      <polygon points="165,10 200,25 210,15 185,5" fill={L} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      {/* Central body — mid */}
      <polygon points="80,60 145,80 160,110 105,100" fill={M} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      {/* Lower back — mid */}
      <polygon points="80,60 105,100 85,120 60,90" fill={M} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      {/* Belly — dark */}
      <polygon points="105,100 160,110 155,135 110,130" fill={D} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      {/* Right flank upper — mid */}
      <polygon points="145,80 175,45 200,70 175,95" fill={M} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      {/* Right flank lower — dark */}
      <polygon points="175,95 200,70 215,95 190,115" fill={D} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      {/* Right flank bottom — dark */}
      <polygon points="175,95 190,115 170,130 155,115" fill={D} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      {/* Mid body centre — mid */}
      <polygon points="145,80 160,110 175,95" fill={M} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
 
      {/* ════ NECK ════ */}
      <polygon points="200,25 210,15 230,30 220,45" fill={L} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      <polygon points="200,25 220,45 210,60 195,45" fill={M} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
 
      {/* ════ HEAD ════ */}
      {/* Top of head — light */}
      <polygon points="210,15 230,30 250,20 235,5" fill={L} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      {/* Face front — mid */}
      <polygon points="230,30 250,20 265,35 248,50" fill={M} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      {/* Lower face — dark */}
      <polygon points="230,30 248,50 235,60 220,45" fill={D} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      {/* Snout — mid */}
      <polygon points="265,35 278,28 285,42 270,50" fill={M} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      {/* Snout bottom — dark */}
      <polygon points="265,35 270,50 255,52 248,50" fill={D} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
 
      {/* ════ HORNS ════ */}
      <polygon points="235,5 250,20 258,8 248,0" fill={L} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      <polygon points="250,20 265,35 275,22 258,8" fill={M} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
 
      {/* ════ EYE ════ */}
      <circle cx="256" cy="32" r="3.5" fill={bg}/>
      <circle cx="257" cy="31" r="1.5" fill={L} opacity="0.6"/>
 
      {/* ════ TAIL ════ */}
      {/* Tail base — dark */}
      <polygon points="60,90 80,60 65,50 45,75" fill={D} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      {/* Tail mid — mid */}
      <polygon points="45,75 65,50 52,38 35,58" fill={M} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      {/* Tail tip segments — light, jagged like reference */}
      <polygon points="35,58 52,38 42,28 28,44" fill={L} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      <polygon points="28,44 42,28 32,22 20,34" fill={M} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      <polygon points="20,34 32,22 25,15 14,25" fill={L} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      {/* Tail curl tip */}
      <polygon points="14,25 25,15 18,10 10,18" fill={D} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
 
      {/* ════ FRONT LEGS (right side, closer) ════ */}
      {/* Front right upper */}
      <polygon points="175,95 190,115 185,140 170,125" fill={M} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      {/* Front right lower */}
      <polygon points="185,140 190,115 200,138 195,160" fill={D} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      {/* Front right hoof */}
      <polygon points="185,140 195,160 188,168 178,155" fill={S} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      {/* Front left (far, partially hidden) */}
      <polygon points="160,110 175,130 168,155 155,138" fill={D} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      <polygon points="168,155 175,130 182,150 176,168" fill={S} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
 
      {/* ════ BACK LEGS ════ */}
      {/* Back right upper */}
      <polygon points="105,100 120,120 115,148 100,130" fill={M} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      {/* Back right lower */}
      <polygon points="115,148 120,120 132,142 128,165" fill={D} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      {/* Back right hoof */}
      <polygon points="115,148 128,165 120,172 108,158" fill={S} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      {/* Back left (far) */}
      <polygon points="85,120 100,138 94,162 80,148" fill={D} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
      <polygon points="94,162 100,138 110,155 105,174" fill={S} stroke={str} strokeWidth={sw} strokeLinejoin="round"/>
    </svg>
  );
}
 
// ── Loading bar with polygonal bull ──────────────────────────────────────────
function BullLoader({ scanned, total, phase }) {
  var pct = phase==='enriching' ? 100 : (total>0 ? Math.min(98, Math.round(scanned/total*100)) : 2);
  var label = phase==='enriching' ? 'Enriching top picks with signal data…' : `Scanning ${scanned} of ${total} securities`;
  return (
    <div style={{padding:'20px',background:C.cardBg,border:'0.5px solid '+C.border,borderRadius:2}}>
      <div style={{position:'relative',paddingBottom:20,marginBottom:12}}>
        {/* Track */}
        <div style={{height:3,background:C.borderDk,borderRadius:2,overflow:'hidden',marginTop:8}}>
          <div style={{height:'100%',background:C.gold,width:pct+'%',transition:'width 0.6s ease',borderRadius:2}}/>
        </div>
        {/* Bull rides along the track */}
        <div style={{
          position:'absolute', bottom:0,
          left:`clamp(0%, calc(${pct}% - 90px), calc(100% - 180px))`,
          transition:'left 0.6s ease',
        }}>
          <PolyBull/>
        </div>
      </div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:14}}>
        <span style={{fontSize:11,fontFamily:MONO,color:C.txLight,letterSpacing:'0.04em'}}>{label}</span>
        <span style={{fontSize:11,fontFamily:MONO,color:C.gold}}>{pct}%</span>
      </div>
    </div>
  );
}
 
function FeatureCard({stock,rank}){
  if(!stock)return null;
  var sc=Math.min(stock.score||0,6),medals=['I','II','III'],chgPos=stock.change?.startsWith('+');
  var exchange=getExchange(stock),timeStr=stock.updatedAt?new Date(stock.updatedAt).toLocaleTimeString():'';
  return(<div style={{background:C.deepBg,border:'1px solid '+C.accent,borderTop:'3px solid '+C.gold,borderRadius:2,padding:'24px 22px',flex:1,minWidth:0,display:'flex',flexDirection:'column'}}>
    <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:16}}>
      <div>
        <div style={{fontSize:10,color:C.gold,fontFamily:SANS,letterSpacing:'0.15em',textTransform:'uppercase',marginBottom:6}}>{'Rank '+medals[rank-1]}</div>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
          <span style={{fontSize:26,fontWeight:700,fontFamily:FONTS,color:'#F1EFE8',letterSpacing:'0.02em'}}>{stock.ticker}</span>
          <span style={{fontSize:9,fontFamily:SANS,padding:'2px 6px',borderRadius:2,letterSpacing:'0.08em',background:'rgba(184,160,112,0.15)',color:C.gold,border:'0.5px solid '+C.gold}}>{exchange}</span>
        </div>
        <div style={{fontSize:12,color:C.txLight,fontFamily:SANS}}>{stock.company||''}</div>
      </div>
      <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:4}}>
        <div style={{fontSize:9,color:'rgba(154,152,144,0.55)',fontFamily:MONO,letterSpacing:'0.04em'}}>{timeStr}</div>
        <ScoreDisplay score={sc} size={24}/>
        <ScoreDots score={sc}/>
      </div>
    </div>
    <div style={{marginBottom:14}}>
      <div style={{fontSize:18,fontFamily:SANS,fontWeight:500,color:'#F1EFE8'}}>
        {stock.price||'--'}
        {stock.change&&<span style={{fontSize:12,marginLeft:8,color:chgPos?'#80C080':C.red}}>{stock.change}</span>}
        {stock.marketCap&&<span style={{fontSize:11,marginLeft:8,color:C.txLight,fontWeight:400}}>{stock.marketCap}</span>}
      </div>
    </div>
    <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:5,marginBottom:14}}>
      {SIG_LABELS.map((label,i)=>{var sig=(stock.signals||[])[i]||{};return <SigPill key={i} sig={{status:sig.status,value:sig.value,label}}/>;} )}
    </div>
    <div style={{flex:1,padding:'10px 12px',background:'rgba(241,239,232,0.04)',borderRadius:2,border:'0.5px solid rgba(184,160,112,0.2)',display:'flex',alignItems:'flex-start'}}>
      <span style={{fontSize:11,color:C.txLight,fontFamily:SANS,lineHeight:1.55}}>{stock.summary||''}</span>
    </div>
  </div>);
}
 
function ResultCard({stock,rank}){
  var sc=Math.min(stock.score||0,6),rating=getRating(sc),chgPos=stock.change?.startsWith('+'),exchange=getExchange(stock);
  var rnkBg=rank===1?{bg:C.gold,color:'#2C2C2A'}:rank===2?{bg:C.accent,color:'#F1EFE8'}:rank===3?{bg:C.accentDk,color:'#F1EFE8'}:{bg:C.border,color:C.txMid};
  return(<div style={{background:C.cardBg,border:'0.5px solid '+C.borderDk,borderLeft:'3px solid '+(sc>=5?C.gold:sc>=4?C.green:sc>=3?'#B8903A':C.borderDk),borderRadius:2,padding:'14px 16px'}}>
    <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:10,marginBottom:10}}>
      <div style={{display:'flex',alignItems:'center',gap:10}}>
        <div style={{width:26,height:26,borderRadius:2,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:600,fontFamily:MONO,flexShrink:0,background:rnkBg.bg,color:rnkBg.color}}>{rank}</div>
        <div>
          <div style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
            <span style={{fontSize:16,fontWeight:700,fontFamily:FONTS,letterSpacing:'0.02em',color:C.tx}}>{stock.ticker}</span>
            <span style={{fontSize:8,fontFamily:SANS,padding:'2px 5px',borderRadius:2,letterSpacing:'0.06em',background:C.darkBg,color:'#F1EFE8'}}>{exchange}</span>
            <span style={{fontSize:9,fontFamily:SANS,fontWeight:600,padding:'2px 8px',borderRadius:20,letterSpacing:'0.06em',textTransform:'uppercase',background:rating.bg,color:rating.color,border:'0.5px solid '+rating.border}}>{rating.label}</span>
          </div>
          <div style={{fontSize:11,color:C.txMid,marginTop:2,fontFamily:SANS}}>{stock.company||''}</div>
          {stock.price&&<div style={{fontSize:11,color:C.txMid,fontFamily:MONO,marginTop:2}}>{stock.price}{stock.change&&<span style={{marginLeft:6,color:chgPos?C.green:C.red}}>{stock.change}</span>}{stock.marketCap&&<span style={{marginLeft:6}}>{stock.marketCap}</span>}</div>}
        </div>
      </div>
      <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:4,flexShrink:0}}>
        <div style={{fontSize:9,color:C.txLight,fontFamily:MONO}}>{stock.updatedAt?new Date(stock.updatedAt).toLocaleTimeString():''}</div>
        <ScoreDisplay score={sc} size={20}/>
        <ScoreDots score={sc}/>
      </div>
    </div>
    <div style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:4,marginBottom:8}}>
      {SIG_LABELS.map((label,i)=>{var sig=(stock.signals||[])[i]||{};return <SigPill key={i} sig={{status:sig.status,value:sig.value,label}}/>;} )}
    </div>
    {stock.summary&&<div style={{fontSize:11,color:C.txMid,borderTop:'0.5px solid '+C.border,paddingTop:8,lineHeight:1.55,fontFamily:SANS}}>{stock.summary}<span style={{marginLeft:8,fontSize:9,color:C.txLight,fontFamily:MONO}}>{'Finnhub · '+(stock.updatedAt?new Date(stock.updatedAt).toLocaleTimeString():'')}</span></div>}
    {stock.error&&<div style={{fontSize:11,color:C.red,borderTop:'0.5px solid '+C.border,paddingTop:8,fontFamily:SANS}}>{'Error: '+stock.error}</div>}
  </div>);
}
 
export default function Home() {
  var [input,setInput]=useState('');
  var [results,setResults]=useState([]);
  var [scanning,setScanning]=useState(false);
  var [status,setStatus]=useState('');
  var [progress,setProgress]=useState(0);
  var [filter,setFilter]=useState('all');
  var [updatedAt,setUpdatedAt]=useState('');
  var [activePreset,setActivePreset]=useState('');
  var [top3,setTop3]=useState(null);
  var [scanPhase,setScanPhase]=useState('idle');
  var [scanProg,setScanProg]=useState({scanned:0,total:UNIQ.length});
  var timerRef=useRef(null),tickersRef=useRef([]),hasRunRef=useRef(false);
 
  async function runTop3Scan() {
    setScanPhase('scanning');
    setScanProg({scanned:0,total:UNIQ.length});
 
    let allStocks=[];
    try {
      const r=await fetch('/api/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbols:UNIQ})});
      if (r.ok) { const d=await r.json(); allStocks=Array.isArray(d.results)?d.results:[]; }
    } catch(_){}
 
    setScanProg({scanned:UNIQ.length,total:UNIQ.length});
 
    const scored=allStocks.map(s=>{const qs=quickScore(s);return qs!==null?{...s,qs}:null;}).filter(Boolean).sort((a,b)=>b.qs-a.qs);
    const pool=scored.length>=3?scored:allStocks.filter(s=>s.marketCap>1e9).sort((a,b)=>(b.marketCap||0)-(a.marketCap||0));
    const candidates=pool.length>=3?pool.slice(0,6).map(s=>s.symbol):['AAPL','MSFT','JPM','KO','XOM','JNJ'];
 
    setScanPhase('enriching');
 
    try {
      const res=await fetch('/api/top3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tickers:candidates,totalScanned:allStocks.length})});
      if (res.ok){const data=await res.json();if(data.top3&&data.top3.length>0){setTop3(data);setScanPhase('ready');return;}}
    } catch(_){}
    setScanPhase('ready');
  }
 
  useEffect(function(){
    if(hasRunRef.current)return;
    hasRunRef.current=true;
    fetch('/api/top3').then(r=>r.json()).then(function(d){
      if(d.top3&&d.top3.length>0){setTop3(d);setScanPhase('ready');}
      else runTop3Scan();
    }).catch(()=>runTop3Scan());
  },[]);
 
  var scan=useCallback(function(tickers){
    setScanning(true);setStatus('Analysing '+tickers.length+' securities...');setProgress(10);
    return fetch('/api/analyse',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tickers})})
      .then(r=>{if(!r.ok)return r.json().then(e=>{throw new Error(e.error||'HTTP '+r.status);});return r.json();})
      .then(d=>{var arr=Object.values(d.results).filter(Boolean).sort((a,b)=>(b.score||0)-(a.score||0));setResults(arr);setUpdatedAt(new Date().toLocaleTimeString());setStatus('');setProgress(100);})
      .catch(e=>setStatus('Error: '+e.message))
      .finally(()=>{setScanning(false);setTimeout(()=>setProgress(0),1000);});
  },[]);
 
  function runScan(){var t=input.split(/[\s,;]+/).map(x=>x.toUpperCase().trim()).filter(Boolean).slice(0,20);if(!t.length)return;tickersRef.current=t;clearInterval(timerRef.current);setResults([]);scan(t);timerRef.current=setInterval(()=>scan(tickersRef.current),5*60*1000);}
  function doRefresh(){if(tickersRef.current.length)scan(tickersRef.current);}
  useEffect(()=>()=>clearInterval(timerRef.current),[]);
 
  var filtered=results.filter(function(r){if(filter==='strong')return(r.score||0)>=5;if(filter==='mod')return(r.score||0)===3||(r.score||0)===4;if(filter==='weak')return(r.score||0)<=2;if(filter==='us')return US_SET.has(r.ticker);if(filter==='intl')return!US_SET.has(r.ticker);return true;});
 
  function exportCSV(){var hdr=['Rank','Ticker','Company','Score','Price','Change','MktCap','EPS','PE_hist','vs50dMA','Insider','Analyst','PE_peers','Summary'];var rows=filtered.map(function(r,i){var g=r.signals||[];return[i+1,r.ticker,'"'+(r.company||'').replace(/"/g,'""')+'"',r.score||0,r.price||'',r.change||'',r.marketCap||'',g[0]?g[0].value||'':'',g[1]?g[1].value||'':'',g[2]?g[2].value||'':'',g[3]?g[3].value||'':'',g[4]?g[4].value||'':'',g[5]?g[5].value||'':'','"'+(r.summary||'').replace(/"/g,'""')+'"'].join(',');});var blob=new Blob([[hdr.join(',')].concat(rows).join('\n')],{type:'text/csv'});var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='signals_'+new Date().toISOString().slice(0,10)+'.csv';a.click();}
 
  var top3Stocks=top3?.top3||[],scannedTotal=top3?.totalScanned||0;
 
  return(<>
    <Head>
      <title>Signal Engine</title>
      <meta name="description" content="Institutional-grade equity value scanner"/>
      <meta name="viewport" content="width=device-width, initial-scale=1"/>
      <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;0,700;1,300;1,400&family=DM+Sans:wght@300;400;500&family=DM+Mono:wght@300;400&display=swap" rel="stylesheet"/>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}body{background:${C.pageBg}}
        ::selection{background:${C.gold};color:#2C2C2A}
        input::placeholder{color:${C.txLight}}input:focus{outline:none}
        button{cursor:pointer}button:disabled{opacity:0.4;cursor:not-allowed}
        @keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes shimmer{0%,100%{opacity:0.35}50%{opacity:0.65}}
        .card-anim{animation:fadeUp 0.5s ease both}
        .card-anim:nth-child(1){animation-delay:0.05s}
        .card-anim:nth-child(2){animation-delay:0.15s}
        .card-anim:nth-child(3){animation-delay:0.25s}
      `}</style>
    </Head>
 
    <div style={{background:C.pageBg,minHeight:'100vh',color:C.tx,fontFamily:SANS}}>
      <div style={{background:C.deepBg,borderBottom:'1px solid rgba(184,160,112,0.3)',padding:'0 32px'}}>
        <div style={{maxWidth:1200,margin:'0 auto',display:'flex',alignItems:'center',justifyContent:'space-between',height:64}}>
          <div style={{display:'flex',alignItems:'center',gap:16}}>
            <div style={{width:32,height:32,border:'1px solid '+C.gold,display:'flex',alignItems:'center',justifyContent:'center'}}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill={C.gold}><path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z"/></svg>
            </div>
            <div>
              <div style={{fontSize:18,fontFamily:FONTS,fontWeight:600,color:'#F1EFE8',letterSpacing:'0.08em'}}>SIGNAL ENGINE</div>
              <div style={{fontSize:9,color:C.gold,fontFamily:SANS,letterSpacing:'0.18em',textTransform:'uppercase',marginTop:1}}>Equity Undervalue Scanner</div>
            </div>
          </div>
          <div style={{textAlign:'right',fontSize:10,color:C.txLight,fontFamily:MONO,lineHeight:1.8}}>
            <div style={{display:'flex',alignItems:'center',gap:6,justifyContent:'flex-end'}}>
              <div style={{width:6,height:6,borderRadius:'50%',background:scanning?'#C8A870':results.length?'#80C080':C.txLight}}/>
              <span style={{color:'#F1EFE8'}}>{scanning?'Scanning...':results.length?'Live':'Ready'}</span>
            </div>
            {updatedAt&&<div>{'Updated '+updatedAt}</div>}
          </div>
        </div>
      </div>
 
      <div style={{maxWidth:1200,margin:'0 auto',padding:'32px 32px 80px'}}>
        <div style={{marginBottom:40}}>
          <div style={{display:'flex',alignItems:'baseline',gap:16,marginBottom:20}}>
            <h2 style={{fontSize:36,fontFamily:FONTS,fontWeight:600,color:C.tx,letterSpacing:'0.02em'}}>Top Picks Today</h2>
            <div style={{height:'0.5px',flex:1,background:C.borderDk}}/>
            <div style={{fontSize:10,color:C.txLight,fontFamily:SANS,letterSpacing:'0.1em',textTransform:'uppercase',whiteSpace:'nowrap'}}>
              {scanPhase==='ready'&&scannedTotal>0?scannedTotal+' securities screened':''}
            </div>
          </div>
 
          {scanPhase!=='ready'&&(
            <div>
              <div style={{display:'flex',gap:16,marginBottom:16}}>
                {[0,1,2].map(i=>(
                  <div key={i} style={{flex:1,background:C.cardBg,border:'0.5px solid '+C.border,borderTop:'3px solid '+C.border,borderRadius:2,padding:'24px 22px',animation:'shimmer 1.8s ease-in-out infinite',animationDelay:(i*0.25)+'s'}}>
                    <div style={{fontSize:10,color:C.txLight,fontFamily:SANS,letterSpacing:'0.1em',marginBottom:10}}>Rank {['I','II','III'][i]}</div>
                    <div style={{width:72,height:26,background:C.borderDk,borderRadius:2,marginBottom:10}}/>
                    <div style={{width:130,height:11,background:C.border,borderRadius:2,marginBottom:6}}/>
                    <div style={{width:90,height:10,background:C.border,borderRadius:2}}/>
                  </div>
                ))}
              </div>
              {(scanPhase==='scanning'||scanPhase==='enriching')&&(
                <BullLoader scanned={scanProg.scanned} total={scanProg.total} phase={scanPhase}/>
              )}
            </div>
          )}
 
          {scanPhase==='ready'&&top3Stocks.length>0&&(
            <div style={{display:'flex',gap:16,alignItems:'stretch'}}>
              {top3Stocks.map((stock,i)=>(
                <div key={stock.ticker} className="card-anim" style={{flex:1,minWidth:0,display:'flex'}}>
                  <FeatureCard stock={stock} rank={i+1}/>
                </div>
              ))}
            </div>
          )}
        </div>
 
        <div style={{display:'flex',alignItems:'center',gap:16,marginBottom:32}}>
          <h2 style={{fontSize:36,fontFamily:FONTS,fontWeight:600,color:C.tx,letterSpacing:'0.02em',whiteSpace:'nowrap'}}>Custom Scan</h2>
          <div style={{height:'0.5px',flex:1,background:C.borderDk}}/>
        </div>
 
        <div style={{background:C.cardBg,border:'0.5px solid '+C.borderDk,padding:'20px',marginBottom:20}}>
          <div style={{display:'flex',gap:10,marginBottom:14}}>
            <input type="text" value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')runScan();}} placeholder="Enter ticker symbols: AAPL, MSFT, NVDA, TSM..." style={{flex:1,background:C.pageBg,border:'0.5px solid '+C.borderDk,padding:'10px 14px',fontSize:13,fontFamily:MONO,color:C.tx,borderRadius:0}}/>
            <button onClick={runScan} disabled={scanning} style={{padding:'10px 24px',background:C.darkBg,color:'#F1EFE8',border:'none',fontSize:12,fontFamily:SANS,fontWeight:500,letterSpacing:'0.1em',textTransform:'uppercase'}}>{scanning?'Scanning...':'Scan'}</button>
            {results.length>0&&<button onClick={doRefresh} disabled={scanning} style={{padding:'10px 16px',background:'transparent',color:C.txMid,border:'0.5px solid '+C.borderDk,fontSize:12,fontFamily:SANS}}>Refresh</button>}
            {results.length>0&&<button onClick={()=>{setResults([]);tickersRef.current=[];setUpdatedAt('');}} style={{padding:'10px 16px',background:'transparent',color:C.txMid,border:'0.5px solid '+C.borderDk,fontSize:12,fontFamily:SANS}}>Clear</button>}
          </div>
          <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
            <span style={{fontSize:9,color:C.txLight,fontFamily:SANS,letterSpacing:'0.12em',textTransform:'uppercase',marginRight:4}}>Sectors</span>
            {Object.keys(PRESETS).map(name=>{var a=activePreset===name;return <button key={name} onClick={()=>{setInput(PRESETS[name]);setActivePreset(name);}} style={{padding:'4px 12px',fontSize:10,fontFamily:SANS,letterSpacing:'0.06em',background:a?C.darkBg:'transparent',color:a?'#F1EFE8':C.txMid,border:'0.5px solid '+(a?C.darkBg:C.borderDk),borderRadius:0,whiteSpace:'nowrap'}}>{name}</button>;})}
          </div>
        </div>
 
        <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center',marginBottom:16}}>
          <span style={{fontSize:9,color:C.txLight,fontFamily:SANS,letterSpacing:'0.12em',textTransform:'uppercase',marginRight:4}}>Filter</span>
          {[['all','All'],['strong','Strong 5-6'],['mod','Moderate 3-4'],['weak','Weak 0-2'],['us','US'],['intl','International']].map(kl=>{var a=filter===kl[0];return <button key={kl[0]} onClick={()=>setFilter(kl[0])} style={{padding:'4px 12px',fontSize:10,fontFamily:SANS,letterSpacing:'0.06em',background:a?C.accentDk:'transparent',color:a?'#F1EFE8':C.txMid,border:'0.5px solid '+(a?C.accentDk:C.borderDk),borderRadius:0}}>{kl[1]}</button>;})}
        </div>
 
        {scanning&&<div style={{height:2,background:C.border,marginBottom:16,overflow:'hidden'}}><div style={{height:'100%',background:C.gold,width:progress+'%',transition:'width 0.4s'}}/></div>}
        {status&&<div style={{display:'flex',alignItems:'center',gap:8,fontSize:11,color:status.startsWith('Error')?C.red:C.txMid,fontFamily:MONO,marginBottom:12}}>{scanning&&<div style={{width:11,height:11,border:'1.5px solid '+C.border,borderTopColor:C.gold,borderRadius:'50%',flexShrink:0,animation:'spin 0.7s linear infinite'}}/>}{status}</div>}
 
        {filtered.length===0&&!scanning?(
          <div style={{textAlign:'center',padding:'48px 16px',color:C.txLight,fontFamily:FONTS,fontSize:18,fontStyle:'italic',fontWeight:300}}>{results.length>0?'No results match this filter.':'Select a sector or enter tickers above to begin scanning.'}</div>
        ):(
          <div style={{display:'flex',flexDirection:'column',gap:8}}>{filtered.map((s,i)=><ResultCard key={s.ticker} stock={s} rank={i+1}/>)}</div>
        )}
 
        {results.length>0&&(
          <div style={{display:'flex',gap:8,marginTop:24,paddingTop:20,borderTop:'0.5px solid '+C.borderDk,flexWrap:'wrap',alignItems:'center'}}>
            <span style={{fontSize:10,color:C.txLight,fontFamily:MONO,flex:1,letterSpacing:'0.06em'}}>{filtered.length+' securities ready to export'}</span>
            <button onClick={exportCSV} style={{padding:'8px 18px',background:'transparent',color:C.txMid,border:'0.5px solid '+C.borderDk,fontSize:11,fontFamily:SANS,letterSpacing:'0.06em'}}>Export CSV</button>
            <button onClick={()=>{var out=filtered.map((r,i)=>Object.assign({rank:i+1},r));var blob=new Blob([JSON.stringify(out,null,2)],{type:'application/json'});var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='signals_'+new Date().toISOString().slice(0,10)+'.json';a.click();}} style={{padding:'8px 18px',background:'transparent',color:C.txMid,border:'0.5px solid '+C.borderDk,fontSize:11,fontFamily:SANS,letterSpacing:'0.06em'}}>Export JSON</button>
          </div>
        )}
      </div>
    </div>
  </>);
}
 
