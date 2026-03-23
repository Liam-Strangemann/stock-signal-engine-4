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
      {[0,1,2,3,4,5].map(function(i) {
        return <div key={i} style={{ width:8, height:8, borderRadius:'50%', background: i < score ? colors[score] : '#2a2a30' }}/>;
      })}
    </div>
  );
}
 
function SigBadge({ sig }) {
  var bg    = sig.status === 'pass' ? '#EAF3DE' : sig.status === 'fail' ? '#FCEBEB' : '#18181c';
  var color = sig.status === 'pass' ? '#27500A' : sig.status === 'fail' ? '#A32D2D' : '#666';
  var bd    = sig.status === 'pass' ? '#C0DD97' : sig.status === 'fail' ? '#F7C1C1' : '#2a2a30';
  return (
    <div style={{ background:bg, border:'0.5px solid '+bd, borderRadius:7, padding:'6px 7px' }}>
      <div style={{ fontSize:9, color:'#888', marginBottom:3, lineHeight:1.3 }}>{sig.label}</div>
      <div style={{ fontSize:10, fontWeight:500, color:color, fontFamily:'monospace', lineHeight:1.3, wordBreak:'break-word' }}>
        {sig.value || '--'}
      </div>
    </div>
  );
}
 
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
  var medianPE  = peerPE.medianPE;
  var avgPE     = peerPE.avgPE;
  var peerCount = peerPE.peerCount;
  var diff      = peerPE.diff;
  var cheaper   = diff !== null && diff < -8;
  var expensive = diff !== null && diff > 8;
  var bg        = cheaper ? '#EAF3DE' : expensive ? '#FCEBEB' : '#18181c';
  var color     = cheaper ? '#27500A' : expensive ? '#A32D2D' : '#888';
  var bd        = cheaper ? '#C0DD97' : expensive ? '#F7C1C1' : '#2a2a30';
  var label;
  if (diff === null) {
    label = 'Med ' + medianPE + 'x';
  } else if (cheaper) {
    label = Math.abs(diff).toFixed(0) + '% cheaper';
  } else if (expensive) {
    label = Math.abs(diff).toFixed(0) + '% pricier';
  } else {
    label = 'In line (' + (diff > 0 ? '+' : '') + diff.toFixed(0) + '%)';
  }
  return (
    <div style={{ background:bg, border:'0.5px solid '+bd, borderRadius:7, padding:'6px 7px' }}>
      <div style={{ fontSize:9, color:'#888', marginBottom:3, lineHeight:1.3 }}>{'PE vs peers (' + peerCount + ')'}</div>
      <div style={{ fontSize:10, fontWeight:500, fontFamily:'monospace', color:color, lineHeight:1.3, wordBreak:'break-word' }}>
        {label}
      </div>
      <div style={{ fontSize:9, color:'#555', fontFamily:'monospace', marginTop:2 }}>
        {'Med ' + medianPE + 'x / Avg ' + avgPE + 'x'}
      </div>
    </div>
  );
}
 
function StockCard({ stock, rank }) {
  var sc       = Math.min(stock.score || 0, 5);
  var barColor = sc >= 4 ? '#4ade80' : sc === 3 ? '#fbbf24' : sc === 2 ? '#fb923c' : '#f87171';
  var rnkStyle = rank === 1 ? { background:'#FAEEDA', border:'0.5px solid #FAC775', color:'#633806' }
               : rank === 2 ? { background:'#F1EFE8', border:'0.5px solid #D3D1C7', color:'#444441' }
               : rank === 3 ? { background:'#FAECE7', border:'0.5px solid #F5C4B3', color:'#712B13' }
               : { background:'#18181c', border:'0.5px solid #2a2a30', color:'#666' };
  var isUS   = US_SET.has(stock.ticker);
  var chgPos = stock.change && stock.change.startsWith('+');
  var rating = stock.rating || (function() {
    if (sc >= 5) return { label:'Strong buy', color:'#14532d', bg:'#dcfce7', border:'#86efac' };
    if (sc === 4) return { label:'Buy',        color:'#15803d', bg:'#f0fdf4', border:'#bbf7d0' };
    if (sc === 3) return { label:'Watch',      color:'#92400e', bg:'#fffbeb', border:'#fde68a' };
    return               { label:'Ignore',     color:'#6b7280', bg:'#f9fafb', border:'#d1d5db' };
  })();
 
  return (
    <div style={{ background:'#111114', border:'0.5px solid #1f1f26', borderRadius:12, padding:'14px 16px', borderLeft:'3px solid '+barColor }}>
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:10, marginBottom:10 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ width:28, height:28, borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:500, fontFamily:'monospace', flexShrink:0, background:rnkStyle.background, border:rnkStyle.border, color:rnkStyle.color }}>
            {rank}
          </div>
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
              <span style={{ fontSize:16, fontWeight:500, fontFamily:'monospace', letterSpacing:0.3 }}>{stock.ticker}</span>
              <span style={{ fontSize:9, fontFamily:'monospace', padding:'2px 5px', borderRadius:4, background: isUS ? '#E6F1FB' : '#FAEEDA', color: isUS ? '#0C447C' : '#633806', border: isUS ? '0.5px solid #B5D4F4' : '0.5px solid #FAC775' }}>
                {isUS ? 'US' : 'INTL'}
              </span>
              <span style={{ fontSize:10, fontWeight:600, letterSpacing:0.4, padding:'3px 8px', borderRadius:20, background:rating.bg, color:rating.color, border:'0.5px solid '+rating.border, textTransform:'uppercase' }}>
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
          <div style={{ fontSize:26, fontWeight:500, fontFamily:'monospace', color: sc>=4 ? '#4ade80' : sc===3 ? '#fbbf24' : sc===2 ? '#fb923c' : '#f87171' }}>
            {sc}<span style={{ fontSize:13, opacity:0.4 }}>/6</span>
          </div>
          <ScoreBar score={sc}/>
        </div>
      </div>
 
      <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:4, marginBottom:8 }}>
        {SIG_LABELS.map(function(label, i) {
          var sig = (stock.signals || [])[i] || {};
          return <SigBadge key={i} sig={{ status: sig.status, value: sig.value, label: label }}/>;
        })}
        <PeerPEBadge peerPE={stock.peerPE}/>
      </div>
 
      {stock.summary && (
        <div style={{ fontSize:12, color:'#a1a0aa', borderTop:'0.5px solid #1f1f26', paddingTop:8, lineHeight:1.55 }}>
          {stock.summary}
          <div style={{ fontSize:10, color:'#555', fontFamily:'monospace', marginTop:4 }}>
            {'Finnhub - ' + (stock.updatedAt ? new Date(stock.updatedAt).toLocaleTimeString() : new Date().toLocaleTimeString())}
          </div>
        </div>
      )}
      {stock.error && (
        <div style={{ fontSize:12, color:'#f87171', borderTop:'0.5px solid #1f1f26', paddingTop:8 }}>
          {'Error: ' + stock.error}
        </div>
      )}
    </div>
  );
}
 
 
function Top3Bar({ top3Data, loading }) {
  var containerStyle = {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    background: '#0d0d10',
    borderTop: '0.5px solid #2a2a30',
    padding: '10px 20px',
    zIndex: 100,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap'
  };
  var labelStyle = {
    fontSize: 10,
    color: '#5a5966',
    fontFamily: 'monospace',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    flexShrink: 0,
    whiteSpace: 'nowrap'
  };
  if (loading) {
    return (
      <div style={containerStyle}>
        <span style={labelStyle}>Top 3 of the day</span>
        <span style={{ fontSize:11, color:'#444', fontFamily:'monospace' }}>Scanning watchlist...</span>
      </div>
    );
  }
  if (!top3Data || !top3Data.top3 || top3Data.top3.length === 0) {
    return (
      <div style={containerStyle}>
        <span style={labelStyle}>Top 3 of the day</span>
        <span style={{ fontSize:11, color:'#444', fontFamily:'monospace' }}>No data yet</span>
      </div>
    );
  }
  var medals = ['#FFD700','#C0C0C0','#CD7F32'];
  var scannedAt = top3Data.scannedAt ? new Date(top3Data.scannedAt).toLocaleTimeString() : '';
  var total = top3Data.totalScanned || 0;
  return (
    <div style={containerStyle}>
      <span style={labelStyle}>{'Top 3 today (' + total + ' scanned' + (scannedAt ? ', ' + scannedAt : '') + ')'}</span>
      {top3Data.top3.map(function(stock, i) {
        var chgPos = stock.change && stock.change.startsWith('+');
        return (
          <div key={stock.ticker} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: '#111114', border: '0.5px solid #2a2a30',
            borderRadius: 8, padding: '5px 10px', flexShrink: 0
          }}>
            <span style={{ fontSize:12, color: medals[i] }}>{'#' + (i+1)}</span>
            <span style={{ fontSize:13, fontWeight:500, fontFamily:'monospace', color:'#f0eff4' }}>{stock.ticker}</span>
            <span style={{ fontSize:11, fontFamily:'monospace', color:'#888' }}>{stock.price}</span>
            {stock.change && (
              <span style={{ fontSize:10, fontFamily:'monospace', color: chgPos ? '#4ade80' : '#f87171' }}>{stock.change}</span>
            )}
            <span style={{
              fontSize: 10, fontFamily: 'monospace', fontWeight: 600,
              padding: '2px 6px', borderRadius: 20,
              background: stock.score >= 3 ? '#EAF3DE' : '#FCEBEB',
              color: stock.score >= 3 ? '#27500A' : '#A32D2D'
            }}>{stock.score + '/4'}</span>
          </div>
        );
      })}
    </div>
  );
}
 
export default function Home() {
  var inputState    = useState('');
  var input         = inputState[0];
  var setInput      = inputState[1];
  var top3State     = useState(null);
  var top3          = top3State[0];
  var setTop3       = top3State[1];
  var top3LoadState = useState(false);
  var top3Loading   = top3LoadState[0];
  var setTop3Loading = top3LoadState[1];
  var resultsState  = useState([]);
  var results       = resultsState[0];
  var setResults    = resultsState[1];
  var scanningState = useState(false);
  var scanning      = scanningState[0];
  var setScanning   = scanningState[1];
  var statusState   = useState('');
  var status        = statusState[0];
  var setStatus     = statusState[1];
  var progressState = useState(0);
  var progress      = progressState[0];
  var setProgress   = progressState[1];
  var filterState   = useState('all');
  var filter        = filterState[0];
  var setFilter     = filterState[1];
  var updatedState  = useState('');
  var updatedAt     = updatedState[0];
  var setUpdatedAt  = updatedState[1];
  var presetState   = useState('');
  var activePreset  = presetState[0];
  var setActivePreset = presetState[1];
  var timerRef   = useRef(null);
  var tickersRef = useRef([]);
 
  var scan = useCallback(function(tickers) {
    setScanning(true);
    setStatus('Fetching data for ' + tickers.length + ' stocks...');
    setProgress(10);
    return fetch('/api/analyse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers: tickers })
    }).then(function(res) {
      if (!res.ok) {
        return res.json().then(function(e) { throw new Error(e.error || 'HTTP ' + res.status); });
      }
      return res.json();
    }).then(function(data) {
      var arr = Object.values(data.results)
        .filter(function(r) { return r; })
        .sort(function(a, b) { return (b.score||0) - (a.score||0); });
      setResults(arr);
      setUpdatedAt(new Date().toLocaleTimeString());
      setStatus('');
      setProgress(100);
    }).catch(function(e) {
      setStatus('Error: ' + e.message);
    }).finally(function() {
      setScanning(false);
      setTimeout(function() { setProgress(0); }, 1000);
    });
  }, []);
 
  function runScan() {
    var tickers = input.split(/[\s,;]+/).map(function(t) { return t.toUpperCase().trim(); }).filter(Boolean).slice(0,20);
    if (!tickers.length) return;
    tickersRef.current = tickers;
    clearInterval(timerRef.current);
    setResults([]);
    scan(tickers);
    timerRef.current = setInterval(function() { scan(tickersRef.current); }, 5*60*1000);
  }
 
  function doRefresh() {
    if (tickersRef.current.length) scan(tickersRef.current);
  }
 
  useEffect(function() {
    return function() { clearInterval(timerRef.current); };
  }, []);
 
  useEffect(function() {
    setTop3Loading(true);
    fetch('/api/top3')
      .then(function(r) { return r.json(); })
      .then(function(d) { if (d.top3) setTop3(d); })
      .catch(function() {})
      .finally(function() { setTop3Loading(false); });
  }, []);
 
  var filtered = results.filter(function(r) {
    if (filter === 'strong') return (r.score||0) >= 4;
    if (filter === 'mod')    return (r.score||0) === 3;
    if (filter === 'weak')   return (r.score||0) <= 2;
    if (filter === 'us')     return US_SET.has(r.ticker);
    if (filter === 'intl')   return !US_SET.has(r.ticker);
    return true;
  });
 
  var stats = {
    total:    results.filter(function(r) { return r.score != null; }).length,
    strong:   results.filter(function(r) { return (r.score||0) >= 4; }).length,
    moderate: results.filter(function(r) { return (r.score||0) === 3; }).length,
    avg:      results.length ? (results.reduce(function(s,r) { return s+(r.score||0); }, 0) / results.length).toFixed(1) : '--'
  };
 
  function exportCSV() {
    var hdr  = ['Rank','Ticker','Company','Score','Price','Change','MktCap','EPS_Beat','PE_hist','vs50dMA','Insider','Analyst','PeerMedianPE','PeerAvgPE','vsPeers','Summary'];
    var rows = filtered.map(function(r, i) {
      var g  = r.signals || [];
      var pp = r.peerPE  || {};
      return [
        i+1, r.ticker,
        '"' + (r.company||'').replace(/"/g,'""') + '"',
        r.score||0, r.price||'', r.change||'', r.marketCap||'',
        g[0] ? g[0].value||'' : '',
        g[1] ? g[1].value||'' : '',
        g[2] ? g[2].value||'' : '',
        g[3] ? g[3].value||'' : '',
        g[4] ? g[4].value||'' : '',
        pp.medianPE||'', pp.avgPE||'',
        pp.diff != null ? pp.diff + '%' : '',
        '"' + (r.summary||'').replace(/"/g,'""') + '"'
      ].join(',');
    });
    var blob = new Blob([[hdr.join(',')].concat(rows).join('\n')], { type:'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'signals_' + new Date().toISOString().slice(0,10) + '.csv';
    a.click();
  }
 
  function exportJSON() {
    var out = filtered.map(function(r, i) {
      return Object.assign({ rank: i+1 }, r);
    });
    var blob = new Blob([JSON.stringify(out, null, 2)], { type:'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'signals_' + new Date().toISOString().slice(0,10) + '.json';
    a.click();
  }
 
  var dotColor = scanning ? '#fbbf24' : results.length ? '#4ade80' : '#5a5966';
 
  return (
    <>
      <Head>
        <title>Stock Signal Engine</title>
        <meta name="description" content="5-factor undervalue stock scanner with peer PE comparison"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
      </Head>
      <div style={{ background:'#09090b', minHeight:'100vh', color:'#f0eff4', fontFamily:"'DM Sans', sans-serif", fontSize:14 }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet"/>
        <div style={{ maxWidth:1100, margin:'0 auto', padding:'2rem 1.25rem 8rem' }}>
 
          <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', flexWrap:'wrap', gap:12, marginBottom:'2rem' }}>
            <div style={{ display:'flex', alignItems:'center', gap:12 }}>
              <div style={{ width:40, height:40, background:'#7c6af7', borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                <svg viewBox="0 0 24 24" width="22" height="22" fill="white"><path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z"/></svg>
              </div>
              <div>
                <h1 style={{ fontSize:20, fontWeight:500, letterSpacing:-0.3, margin:0 }}>Stock Signal Engine</h1>
                <p style={{ fontSize:11, color:'#5a5966', fontFamily:'monospace', marginTop:2 }}>6-signal scanner + peer PE comparison - Finnhub live data - auto-refresh 5 min</p>
              </div>
            </div>
            <div style={{ textAlign:'right', fontSize:11, color:'#5a5966', fontFamily:'monospace', lineHeight:1.8 }}>
              <div>
                <span style={{ display:'inline-block', width:7, height:7, borderRadius:'50%', background:dotColor, marginRight:5, verticalAlign:'middle' }}/>
                {scanning ? 'Scanning...' : results.length ? 'Live' : 'Ready'}
              </div>
              {updatedAt && <div>{'Updated ' + updatedAt}</div>}
            </div>
          </div>
 
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8, marginBottom:'1.5rem' }}>
            {[
              { label:'Scanned',      val: stats.total,    color: null },
              { label:'Strong (5-6)', val: stats.strong,   color: '#4ade80' },
              { label:'Moderate (3)', val: stats.moderate, color: '#fbbf24' },
              { label:'Avg score',    val: stats.avg,      color: null },
            ].map(function(s) {
              return (
                <div key={s.label} style={{ background:'#111114', border:'0.5px solid #1f1f26', borderRadius:10, padding:'12px 14px' }}>
                  <div style={{ fontSize:10, color:'#5a5966', fontFamily:'monospace', marginBottom:4, textTransform:'uppercase', letterSpacing:0.5 }}>{s.label}</div>
                  <div style={{ fontSize:22, fontWeight:500, color: s.color || '#f0eff4' }}>{s.val}</div>
                </div>
              );
            })}
          </div>
 
          {scanning && (
            <div style={{ height:3, background:'#1f1f26', borderRadius:2, marginBottom:12, overflow:'hidden' }}>
              <div style={{ height:'100%', background:'#7c6af7', borderRadius:2, width:progress+'%', transition:'width 0.4s' }}/>
            </div>
          )}
 
          <div style={{ background:'#111114', border:'0.5px solid #1f1f26', borderRadius:12, padding:'1.125rem 1.25rem', marginBottom:'1.125rem' }}>
            <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center', marginBottom:10 }}>
              <input type="text" value={input} onChange={function(e) { setInput(e.target.value); }}
                onKeyDown={function(e) { if (e.key === 'Enter') runScan(); }}
                placeholder="Enter tickers: AAPL, MSFT, NVDA, TSM ..."
                style={{ flex:1, minWidth:180, background:'#18181c', border:'0.5px solid #2a2a30', borderRadius:8, padding:'8px 12px', fontSize:13, fontFamily:'monospace', color:'#f0eff4', outline:'none' }}/>
              <button onClick={runScan} disabled={scanning}
                style={{ padding:'8px 16px', borderRadius:8, fontSize:13, fontWeight:500, cursor: scanning ? 'not-allowed' : 'pointer', opacity: scanning ? 0.38 : 1, background:'#7c6af7', border:'none', color:'#fff', whiteSpace:'nowrap' }}>
                {scanning ? 'Scanning...' : 'Scan'}
              </button>
              {results.length > 0 && (
                <button onClick={doRefresh} disabled={scanning}
                  style={{ padding:'8px 14px', borderRadius:8, fontSize:13, fontWeight:500, cursor:'pointer', background:'transparent', border:'0.5px solid #2a2a30', color:'#a1a0aa', whiteSpace:'nowrap' }}>
                  Refresh
                </button>
              )}
              {results.length > 0 && (
                <button onClick={function() { setResults([]); tickersRef.current=[]; setUpdatedAt(''); }}
                  style={{ padding:'8px 14px', borderRadius:8, fontSize:13, cursor:'pointer', background:'transparent', border:'0.5px solid #2a2a30', color:'#a1a0aa' }}>
                  Clear
                </button>
              )}
            </div>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
              <span style={{ fontSize:11, color:'#5a5966', fontFamily:'monospace', flexShrink:0 }}>presets</span>
              {Object.keys(PRESETS).map(function(name) {
                return (
                  <button key={name} onClick={function() { setInput(PRESETS[name]); setActivePreset(name); }}
                    style={{ padding:'4px 10px', borderRadius:20, fontSize:11, cursor:'pointer', fontFamily:'monospace', whiteSpace:'nowrap',
                      background: activePreset===name ? '#18181c' : 'transparent',
                      border:     activePreset===name ? '0.5px solid #7c6af7' : '0.5px solid #2a2a30',
                      color:      activePreset===name ? '#7c6af7' : '#a1a0aa' }}>
                    {name}
                  </button>
                );
              })}
            </div>
          </div>
 
          <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center', marginBottom:'0.875rem' }}>
            <span style={{ fontSize:11, color:'#5a5966' }}>filter:</span>
            {[['all','All'],['strong','Strong 5-6'],['mod','Moderate 3'],['weak','Weak 0-2'],['us','US only'],['intl','International']].map(function(kl) {
              return (
                <button key={kl[0]} onClick={function() { setFilter(kl[0]); }}
                  style={{ padding:'3px 10px', borderRadius:6, fontSize:11, cursor:'pointer',
                    background: filter===kl[0] ? '#18181c' : 'transparent',
                    border:     filter===kl[0] ? '0.5px solid #7c6af7' : '0.5px solid #2a2a30',
                    color:      filter===kl[0] ? '#7c6af7' : '#5a5966' }}>
                  {kl[1]}
                </button>
              );
            })}
          </div>
 
          {status && (
            <div style={{ fontSize:12, color: status.startsWith('Error') ? '#f87171' : '#5a5966', fontFamily:'monospace', marginBottom:'0.875rem', display:'flex', alignItems:'center', gap:8 }}>
              {scanning && (
                <div style={{ width:12, height:12, border:'1.5px solid #2a2a30', borderTopColor:'#7c6af7', borderRadius:'50%', flexShrink:0,
                  animation:'spin 0.7s linear infinite' }}/>
              )}
              <style>{'@keyframes spin { to { transform: rotate(360deg); } }'}</style>
              {status}
            </div>
          )}
 
          {filtered.length === 0 && !scanning ? (
            <div style={{ textAlign:'center', padding:'3rem 1rem', color:'#5a5966', fontFamily:'monospace', fontSize:13 }}>
              {results.length > 0 ? 'No results match this filter.' : 'Pick a preset or enter tickers, then click Scan'}
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {filtered.map(function(stock, i) {
                return <StockCard key={stock.ticker} stock={stock} rank={i+1}/>;
              })}
            </div>
          )}
 
          {results.length > 0 && (
            <div style={{ display:'flex', gap:8, marginTop:'1.5rem', paddingTop:'1.25rem', borderTop:'0.5px solid #1f1f26', flexWrap:'wrap', alignItems:'center' }}>
              <span style={{ fontSize:11, color:'#5a5966', fontFamily:'monospace', flex:1 }}>{filtered.length + ' stocks ready to export'}</span>
              <button onClick={exportCSV} style={{ padding:'7px 14px', borderRadius:8, fontSize:13, cursor:'pointer', background:'transparent', border:'0.5px solid #2a2a30', color:'#a1a0aa' }}>Export CSV</button>
              <button onClick={exportJSON} style={{ padding:'7px 14px', borderRadius:8, fontSize:13, cursor:'pointer', background:'transparent', border:'0.5px solid #2a2a30', color:'#a1a0aa' }}>Export JSON</button>
            </div>
          )}
 
        </div>
      </div>
      <Top3Bar top3Data={top3} loading={top3Loading} />
    </>
  );
}
 
