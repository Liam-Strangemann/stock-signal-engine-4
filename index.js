// v2.1 - peer PE panel always visible
import { useState, useEffect, useRef, useCallback } from 'react';
import Head from 'next/head';
 
const PRESETS = {
  'Mega-cap':     'AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,JPM,XOM,UNH',
  'Tech':         'AAPL,MSFT,NVDA,AVGO,ORCL,AMD,INTC,QCOM,TXN,AMAT',
  'Finance':      'JPM,BAC,WFC,GS,MS,BLK,C,AXP,SCHW,USB',
  'Healthcare':   'LLY,JNJ,UNH,ABBV,MRK,PFE,TMO,ABT,AMGN,CVS',
  'Energy':       'XOM,CVX,COP,EOG,SLB,MPC,PSX,VLO,OXY,DVN',
  'Consumer':     'AMZN,TSLA,HD,MCD,NKE,SBUX,LOW,TGT,COST,WMT',
  'International':'TSM,ASML,NVO,SAP,TM,SHEL,BHP,RIO,AZN,HSBC',
  'Dividend':     'T,VZ,MO,PM,XOM,CVX,JNJ,KO,PEP,IBM',
};
 
const SIG_LABELS = ['EPS & Rev beat', 'PE vs hist avg', 'Price vs 50d MA', 'Insider buying', 'Analyst +25% upside'];
const US_SET = new Set('AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,JPM,XOM,UNH,LLY,AVGO,ORCL,AMD,INTC,QCOM,TXN,AMAT,MU,ADBE,BAC,WFC,GS,MS,BLK,C,AXP,SCHW,USB,PNC,TFC,JNJ,ABBV,MRK,PFE,TMO,ABT,AMGN,CVS,MDT,ISRG,COP,EOG,SLB,MPC,PSX,VLO,OXY,DVN,HAL,BKR,CVX,HD,MCD,NKE,SBUX,LOW,TGT,GM,F,COST,WMT,T,VZ,MO,PM,KO,PEP,MMM,IBM,WBA'.split(','));
 
function ScoreBar({ score }) {
  const colors = ['#f87171','#f87171','#fb923c','#fbbf24','#4ade80','#4ade80'];
  return (
    <div style={{ display:'flex', gap:3 }}>
      {[0,1,2,3,4].map(i => (
        <div key={i} style={{ width:8, height:8, borderRadius:'50%', background: i < score ? colors[score] : '#2a2a30' }}/>
      ))}
    </div>
  );
}
 
function SigBadge({ sig }) {
  const bg    = sig.status === 'pass' ? '#EAF3DE' : sig.status === 'fail' ? '#FCEBEB' : '#18181c';
  const color = sig.status === 'pass' ? '#27500A' : sig.status === 'fail' ? '#A32D2D' : '#666';
  const bd    = sig.status === 'pass' ? '#C0DD97' : sig.status === 'fail' ? '#F7C1C1' : '#2a2a30';
  return (
    <div style={{ background:bg, border:`0.5px solid ${bd}`, borderRadius:7, padding:'6px 7px' }}>
      <div style={{ fontSize:9, color:'#888', marginBottom:3, lineHeight:1.3 }}>{sig.label}</div>
      <div style={{ fontSize:10, fontWeight:500, color, fontFamily:'monospace', lineHeight:1.3, wordBreak:'break-word' }}>
        {sig.value || '—'}
      </div>
    </div>
  );
}
 
//-- Peer PE comparison panel shown below the signal badges -------------------
function PeerPEBadge({ peerPE }) {
  if (!peerPE || !peerPE.medianPE) {
    return (
      <div style={{ background:'#18181c', border:'0.5px solid #2a2a30', borderRadius:7, padding:'6px 7px' }}>
        <div style={{ fontSize:9, color:'#888', marginBottom:3, lineHeight:1.3 }}>PE vs peers</div>
        <div style={{ fontSize:10, fontWeight:500, fontFamily:'monospace', color:'#444', lineHeight:1.3 }}>
          {peerPE === null ? 'No peers found' : 'Loading...'}
        </div>
      </div>
    );
  }
  const { medianPE, avgPE, peerCount, diff, peers } = peerPE;
  const cheaper   = diff !== null && diff < -8;
  const expensive = diff !== null && diff > 8;
  const bg        = cheaper ? '#EAF3DE' : expensive ? '#FCEBEB' : '#18181c';
  const color     = cheaper ? '#27500A' : expensive ? '#A32D2D' : '#888';
  const bd        = cheaper ? '#C0DD97' : expensive ? '#F7C1C1' : '#2a2a30';
  const label     = diff === null ? `Med ${medianPE}x (${peerCount}co)`
                  : cheaper   ? `${Math.abs(diff).toFixed(0)}% < peers`
                  : expensive ? `${Math.abs(diff).toFixed(0)}% > peers`
                  : `~inline (${diff > 0 ? '+' : ''}${diff.toFixed(0)}%)`;
  const sub       = `Med ${medianPE}x  - Avg ${avgPE}x`;
  return (
    <div style={{ background:bg, border:`0.5px solid ${bd}`, borderRadius:7, padding:'6px 7px' }}>
      <div style={{ fontSize:9, color:'#888', marginBottom:3, lineHeight:1.3 }}>PE vs peers ({peerCount})</div>
      <div style={{ fontSize:10, fontWeight:500, fontFamily:'monospace', color, lineHeight:1.3, wordBreak:'break-word' }}>
        {label}
      </div>
      <div style={{ fontSize:9, color:'#555', fontFamily:'monospace', marginTop:2 }}>{sub}</div>
    </div>
  );
}
 
 
function StockCard({ stock, rank }) {
  const sc       = Math.min(stock.score || 0, 5);
  const barColor = sc >= 4 ? '#4ade80' : sc === 3 ? '#fbbf24' : sc === 2 ? '#fb923c' : '#f87171';
  const rnkStyle = rank === 1 ? { background:'#FAEEDA', border:'0.5px solid #FAC775', color:'#633806' }
                 : rank === 2 ? { background:'#F1EFE8', border:'0.5px solid #D3D1C7', color:'#444441' }
                 : rank === 3 ? { background:'#FAECE7', border:'0.5px solid #F5C4B3', color:'#712B13' }
                 : { background:'#18181c', border:'0.5px solid #2a2a30', color:'#666' };
  const isUS     = US_SET.has(stock.ticker);
  const chgPos   = stock.change && stock.change.startsWith('+');
 
  const rating = stock.rating || (() => {
    if (sc === 5) return { label:'Strong buy', color:'#14532d', bg:'#dcfce7', border:'#86efac' };
    if (sc === 4) return { label:'Buy',        color:'#15803d', bg:'#f0fdf4', border:'#bbf7d0' };
    if (sc === 3) return { label:'Watch',      color:'#92400e', bg:'#fffbeb', border:'#fde68a' };
    return               { label:'Ignore',     color:'#6b7280', bg:'#f9fafb', border:'#d1d5db' };
  })();
 
  return (
    <div style={{ background:'#111114', border:'0.5px solid #1f1f26', borderRadius:12, padding:'14px 16px', borderLeft:`3px solid ${barColor}`, position:'relative' }}>
 
      {/* Top row: rank, ticker, score */}
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:10, marginBottom:10 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ width:28, height:28, borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:500, fontFamily:'monospace', flexShrink:0, ...rnkStyle }}>
            {rank}
          </div>
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
              <span style={{ fontSize:16, fontWeight:500, fontFamily:'monospace', letterSpacing:.3 }}>{stock.ticker}</span>
              <span style={{ fontSize:9, fontFamily:'monospace', padding:'2px 5px', borderRadius:4,
                background: isUS ? '#E6F1FB' : '#FAEEDA',
                color:      isUS ? '#0C447C' : '#633806',
                border:     isUS ? '0.5px solid #B5D4F4' : '0.5px solid #FAC775' }}>
                {isUS ? 'US' : 'INTL'}
              </span>
              <span style={{ fontSize:10, fontWeight:600, letterSpacing:.4, padding:'3px 8px', borderRadius:20,
                background: rating.bg, color: rating.color, border:`0.5px solid ${rating.border}`, textTransform:'uppercase' }}>
                {rating.label}
              </span>
            </div>
            <div style={{ fontSize:12, color:'#666', marginTop:2 }}>{stock.company}</div>
            {stock.price && (
              <div style={{ fontSize:11, color:'#888', fontFamily:'monospace', marginTop:2 }}>
                {stock.price}
                {stock.change && <span style={{ marginLeft:6, color: chgPos ? '#4ade80' : '#f87171' }}>{stock.change}</span>}
                {stock.marketCap && <span style={{ marginLeft:6 }}>{stock.marketCap}</span>}
              </div>
            )}
          </div>
        </div>
        <div style={{ textAlign:'right', flexShrink:0 }}>
          <div style={{ fontSize:26, fontWeight:500, fontFamily:'monospace',
            color: sc>=4 ? '#4ade80' : sc===3 ? '#fbbf24' : sc===2 ? '#fb923c' : '#f87171' }}>
            {sc}<span style={{ fontSize:13, opacity:.4 }}>/5</span>
          </div>
          <ScoreBar score={sc}/>
        </div>
      </div>
 
      {/* Signal badges — 5 signals + peer PE badge as 6th */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:4, marginBottom:8 }}>
        {SIG_LABELS.map((label, i) => {
          const sig = (stock.signals || [])[i] || {};
          return <SigBadge key={i} sig={{ ...sig, label }}/>;
        })}
        <PeerPEBadge peerPE={stock.peerPE} />
      </div>
 
      {/* Summary */}
      {stock.summary && (
        <div style={{ fontSize:12, color:'#a1a0aa', borderTop:'0.5px solid #1f1f26', paddingTop:8, marginTop:8, lineHeight:1.55 }}>
          {stock.summary}
          <div style={{ fontSize:10, color:'#555', fontFamily:'monospace', marginTop:4 }}>
            Finnhub  - {stock.updatedAt ? new Date(stock.updatedAt).toLocaleTimeString() : new Date().toLocaleTimeString()}
          </div>
        </div>
      )}
      {stock.error && (
        <div style={{ fontSize:12, color:'#f87171', borderTop:'0.5px solid #1f1f26', paddingTop:8 }}>
          Error: {stock.error}
        </div>
      )}
    </div>
  );
}
 
export default function Home() {
  const [input, setInput]               = useState('');
  const [results, setResults]           = useState([]);
  const [scanning, setScanning]         = useState(false);
  const [status, setStatus]             = useState('');
  const [progress, setProgress]         = useState(0);
  const [filter, setFilter]             = useState('all');
  const [updatedAt, setUpdatedAt]       = useState('');
  const [activePreset, setActivePreset] = useState('');
  const timerRef   = useRef(null);
  const tickersRef = useRef([]);
 
  const scan = useCallback(async (tickers) => {
    setScanning(true);
    setStatus(`Fetching data for ${tickers.length} stocks...`);
    setProgress(10);
    try {
      const res = await fetch('/api/analyse', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ tickers })
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || `HTTP ${res.status}`); }
      const data = await res.json();
      const arr  = Object.values(data.results)
        .filter(r => r && (!r.error || r.error))
        .sort((a,b) => (b.score||0) - (a.score||0));
      setResults(arr);
      setUpdatedAt(new Date().toLocaleTimeString());
      setStatus('');
      setProgress(100);
    } catch(e) {
      setStatus('Error: ' + e.message);
    } finally {
      setScanning(false);
      setTimeout(() => setProgress(0), 1000);
    }
  }, []);
 
  const runScan = () => {
    const tickers = input.split(/[\s,;]+/).map(t=>t.toUpperCase().trim()).filter(Boolean).slice(0,20);
    if (!tickers.length) return;
    tickersRef.current = tickers;
    clearInterval(timerRef.current);
    setResults([]);
    scan(tickers);
    timerRef.current = setInterval(() => scan(tickersRef.current), 5*60*1000);
  };
 
  const doRefresh = () => { if (tickersRef.current.length) scan(tickersRef.current); };
  useEffect(() => () => clearInterval(timerRef.current), []);
 
  const filtered = results.filter(r => {
    if (filter==='strong') return (r.score||0) >= 4;
    if (filter==='mod')    return (r.score||0) === 3;
    if (filter==='weak')   return (r.score||0) <= 2;
    if (filter==='us')     return US_SET.has(r.ticker);
    if (filter==='intl')   return !US_SET.has(r.ticker);
    return true;
  });
 
  const stats = {
    total:    results.filter(r=>r.score!=null).length,
    strong:   results.filter(r=>(r.score||0)>=4).length,
    moderate: results.filter(r=>(r.score||0)===3).length,
    avg:      results.length ? (results.reduce((s,r)=>s+(r.score||0),0)/results.length).toFixed(1) : '—'
  };
 
  function exportCSV() {
    const hdr  = ['Rank','Ticker','Company','Score','Price','Change','MktCap','EPS_Beat','PE_hist','vs50dMA','Insider','Analyst_Upside','PeerMedianPE','PeerAvgPE','vsPeers%','Summary'];
    const rows = filtered.map((r,i) => {
      const g  = r.signals||[];
      const pp = r.peerPE||{};
      return [i+1,r.ticker,`"${(r.company||'').replace(/"/g,'""')}"`,r.score||0,
        r.price||'',r.change||'',r.marketCap||'',
        g[0]?.value||'',g[1]?.value||'',g[2]?.value||'',g[3]?.value||'',g[4]?.value||'',
        pp.medianPE||'',pp.avgPE||'',pp.diff!=null?pp.diff+'%':'',
        `"${(r.summary||'').replace(/"/g,'""')}"`
      ].join(',');
    });
    const blob = new Blob([[hdr.join(','),...rows].join('\n')],{type:'text/csv'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `signals_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
  }
 
  return (
    <>
      <Head>
        <title>Stock Signal Engine</title>
        <meta name="description" content="5-factor undervalue stock scanner with peer PE comparison"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
      </Head>
      <div style={{ background:'#09090b', minHeight:'100vh', color:'#f0eff4', fontFamily:"'DM Sans', sans-serif", fontSize:14 }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet"/>
        <div style={{ maxWidth:1100, margin:'0 auto', padding:'2rem 1.25rem 5rem' }}>
 
          {/* Header */}
          <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', flexWrap:'wrap', gap:12, marginBottom:'2rem' }}>
            <div style={{ display:'flex', alignItems:'center', gap:12 }}>
              <div style={{ width:40, height:40, background:'#7c6af7', borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                <svg viewBox="0 0 24 24" width="22" height="22" fill="white"><path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z"/></svg>
              </div>
              <div>
                <h1 style={{ fontSize:20, fontWeight:500, letterSpacing:-.3, margin:0 }}>Stock Signal Engine</h1>
                <p style={{ fontSize:11, color:'#5a5966', fontFamily:'monospace', marginTop:2 }}>5-factor scanner + peer PE comparison  - Finnhub live data  - auto-refresh 5 min</p>
              </div>
            </div>
            <div style={{ textAlign:'right', fontSize:11, color:'#5a5966', fontFamily:'monospace', lineHeight:1.8 }}>
              <div>
                <span style={{ display:'inline-block', width:7, height:7, borderRadius:'50%', background: scanning ? '#fbbf24' : results.length ? '#4ade80' : '#5a5966', marginRight:5, verticalAlign:'middle', animation: scanning ? 'pulse 1s infinite' : 'none' }}/>
                {scanning ? 'Scanning...' : results.length ? 'Live' : 'Ready'}
              </div>
              {updatedAt && <div>Updated {updatedAt}</div>}
              <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}`}</style>
            </div>
          </div>
 
          {/* Stats */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8, marginBottom:'1.5rem' }}>
            {[
              { label:'Scanned',     val: stats.total,    color: null },
              { label:'Strong (4–5)',val: stats.strong,   color: '#4ade80' },
              { label:'Moderate (3)',val: stats.moderate, color: '#fbbf24' },
              { label:'Avg score',   val: stats.avg,      color: null },
            ].map(s => (
              <div key={s.label} style={{ background:'#111114', border:'0.5px solid #1f1f26', borderRadius:10, padding:'12px 14px' }}>
                <div style={{ fontSize:10, color:'#5a5966', fontFamily:'monospace', marginBottom:4, textTransform:'uppercase', letterSpacing:.5 }}>{s.label}</div>
                <div style={{ fontSize:22, fontWeight:500, color: s.color || '#f0eff4' }}>{s.val}</div>
              </div>
            ))}
          </div>
 
          {/* Progress */}
          {scanning && (
            <div style={{ height:3, background:'#1f1f26', borderRadius:2, marginBottom:12, overflow:'hidden' }}>
              <div style={{ height:'100%', background:'#7c6af7', borderRadius:2, width:`${progress}%`, transition:'width .4s' }}/>
            </div>
          )}
 
          {/* Controls */}
          <div style={{ background:'#111114', border:'0.5px solid #1f1f26', borderRadius:12, padding:'1.125rem 1.25rem', marginBottom:'1.125rem' }}>
            <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center', marginBottom:10 }}>
              <input type="text" value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&runScan()}
                placeholder="Enter tickers: AAPL, MSFT, NVDA, TSM ..."
                style={{ flex:1, minWidth:180, background:'#18181c', border:'0.5px solid #2a2a30', borderRadius:8, padding:'8px 12px', fontSize:13, fontFamily:'monospace', color:'#f0eff4', outline:'none' }}/>
              <button onClick={runScan} disabled={scanning}
                style={{ padding:'8px 16px', borderRadius:8, fontSize:13, fontWeight:500, cursor:scanning?'not-allowed':'pointer', opacity:scanning?.38:1, background:'#7c6af7', border:'none', color:'#fff', whiteSpace:'nowrap' }}>
                {scanning ? 'Scanning...' : '▶ Scan'}
              </button>
              {results.length > 0 && (
                <button onClick={doRefresh} disabled={scanning}
                  style={{ padding:'8px 14px', borderRadius:8, fontSize:13, fontWeight:500, cursor:'pointer', background:'transparent', border:'0.5px solid #2a2a30', color:'#a1a0aa', whiteSpace:'nowrap' }}>
                  ↻ Refresh
                </button>
              )}
              {results.length > 0 && (
                <button onClick={() => { setResults([]); tickersRef.current=[]; setUpdatedAt(''); }}
                  style={{ padding:'8px 14px', borderRadius:8, fontSize:13, cursor:'pointer', background:'transparent', border:'0.5px solid #2a2a30', color:'#a1a0aa' }}>✕</button>
              )}
            </div>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
              <span style={{ fontSize:11, color:'#5a5966', fontFamily:'monospace', flexShrink:0 }}>presets →</span>
              {Object.entries(PRESETS).map(([name, tickers]) => (
                <button key={name} onClick={() => { setInput(tickers); setActivePreset(name); }}
                  style={{ padding:'4px 10px', borderRadius:20, fontSize:11, cursor:'pointer', fontFamily:'monospace', whiteSpace:'nowrap',
                    background: activePreset===name ? '#18181c' : 'transparent',
                    border:     activePreset===name ? '0.5px solid #7c6af7' : '0.5px solid #2a2a30',
                    color:      activePreset===name ? '#7c6af7' : '#a1a0aa' }}>
                  {name}
                </button>
              ))}
            </div>
          </div>
 
          {/* Filters */}
          <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center', marginBottom:'.875rem' }}>
            <span style={{ fontSize:11, color:'#5a5966' }}>filter:</span>
            {[['all','All'],['strong','Strong 4–5'],['mod','Moderate 3'],['weak','Weak 0–2'],['us','US only'],['intl','International']].map(([k,l]) => (
              <button key={k} onClick={() => setFilter(k)}
                style={{ padding:'3px 10px', borderRadius:6, fontSize:11, cursor:'pointer',
                  background: filter===k ? '#18181c' : 'transparent',
                  border:     filter===k ? '0.5px solid #7c6af7' : '0.5px solid #2a2a30',
                  color:      filter===k ? '#7c6af7' : '#5a5966' }}>
                {l}
              </button>
            ))}
          </div>
 
          {/* Status */}
          {status && (
            <div style={{ fontSize:12, color:status.startsWith('Error')?'#f87171':'#5a5966', fontFamily:'monospace', marginBottom:'.875rem', display:'flex', alignItems:'center', gap:8 }}>
              {scanning && <div style={{ width:12, height:12, border:'1.5px solid #2a2a30', borderTopColor:'#7c6af7', borderRadius:'50%', animation:'spin .7s linear infinite', flexShrink:0 }}/>}
              <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
              {status}
            </div>
          )}
 
          {/* Grid */}
          {filtered.length === 0 && !scanning ? (
            <div style={{ textAlign:'center', padding:'3rem 1rem', color:'#5a5966', fontFamily:'monospace', fontSize:13 }}>
              {results.length > 0 ? 'No results match this filter.' : 'Pick a preset or enter tickers, then click ▶ Scan'}
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {filtered.map((stock, i) => <StockCard key={stock.ticker} stock={stock} rank={i+1}/>)}
            </div>
          )}
 
          {/* Export */}
          {results.length > 0 && (
            <div style={{ display:'flex', gap:8, marginTop:'1.5rem', paddingTop:'1.25rem', borderTop:'0.5px solid #1f1f26', flexWrap:'wrap', alignItems:'center' }}>
              <span style={{ fontSize:11, color:'#5a5966', fontFamily:'monospace', flex:1 }}>{filtered.length} stocks ready to export</span>
              <button onClick={exportCSV} style={{ padding:'7px 14px', borderRadius:8, fontSize:13, cursor:'pointer', background:'transparent', border:'0.5px solid #2a2a30', color:'#a1a0aa' }}>↓ Export CSV</button>
              <button onClick={() => {
                const blob = new Blob([JSON.stringify(filtered.map((r,i)=>({rank:i+1,...r})),null,2)],{type:'application/json'});
                const a = document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`signals_${new Date().toISOString().slice(0,10)}.json`; a.click();
              }} style={{ padding:'7px 14px', borderRadius:8, fontSize:13, cursor:'pointer', background:'transparent', border:'0.5px solid #2a2a30', color:'#a1a0aa' }}>↓ Export JSON</button>
            </div>
          )}
 
        </div>
      </div>
    </>
  );
}
 
