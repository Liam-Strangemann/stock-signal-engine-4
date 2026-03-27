import { useState, useEffect, useRef, useCallback } from 'react';
import Head from 'next/head';
 
var PRESETS = {
  'Mega-cap':     'AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,JPM,XOM,UNH',
  'Technology':   'AAPL,MSFT,NVDA,AVGO,ORCL,AMD,INTC,QCOM,TXN,AMAT',
  'Finance':      'JPM,BAC,WFC,GS,MS,BLK,C,AXP,SCHW,USB',
  'Healthcare':   'LLY,JNJ,UNH,ABBV,MRK,PFE,TMO,ABT,AMGN,CVS',
  'Energy':       'XOM,CVX,COP,EOG,SLB,MPC,PSX,VLO,OXY,DVN',
  'Consumer':     'AMZN,TSLA,HD,MCD,NKE,SBUX,LOW,TGT,COST,WMT',
  'International':'TSM,ASML,NVO,SAP,TM,SHEL,BHP,RIO,AZN,HSBC',
  'Dividend':     'T,VZ,MO,PM,XOM,CVX,JNJ,KO,PEP,IBM',
};
 
var SIG_LABELS = ['EPS & Rev beat', 'PE vs hist avg', 'Price vs 50d MA', 'Insider buying', 'Analyst +25% upside', 'PE vs peers'];
 
var US_SET = new Set('AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,JPM,XOM,UNH,LLY,AVGO,ORCL,AMD,INTC,QCOM,TXN,AMAT,MU,ADBE,BAC,WFC,GS,MS,BLK,C,AXP,SCHW,USB,PNC,TFC,JNJ,ABBV,MRK,PFE,TMO,ABT,AMGN,CVS,MDT,ISRG,COP,EOG,SLB,MPC,PSX,VLO,OXY,DVN,HAL,BKR,CVX,HD,MCD,NKE,SBUX,LOW,TGT,GM,F,COST,WMT,T,VZ,MO,PM,KO,PEP,MMM,IBM,WBA'.split(','));
 
// Fallback exchange map for custom scan results (analyse.js doesn't return exchange)
var EXCHANGE_MAP = {
  AAPL:'NASDAQ',MSFT:'NASDAQ',GOOGL:'NASDAQ',AMZN:'NASDAQ',META:'NASDAQ',
  NVDA:'NASDAQ',TSLA:'NASDAQ',AVGO:'NASDAQ',COST:'NASDAQ',INTC:'NASDAQ',
  AMD:'NASDAQ',AMGN:'NASDAQ',QCOM:'NASDAQ',SBUX:'NASDAQ',PEP:'NASDAQ',
  TXN:'NASDAQ',HON:'NASDAQ',ASML:'NASDAQ',AZN:'NASDAQ',NVO:'NYSE',
  'BRK.B':'NYSE',JPM:'NYSE',JNJ:'NYSE',V:'NYSE',PG:'NYSE',
  UNH:'NYSE',HD:'NYSE',MA:'NYSE',XOM:'NYSE',CVX:'NYSE',
  ABBV:'NYSE',MRK:'NYSE',KO:'NYSE',TMO:'NYSE',MCD:'NYSE',
  ACN:'NYSE',LIN:'NYSE',DHR:'NYSE',NEE:'NYSE',PM:'NYSE',
  UNP:'NYSE',IBM:'NYSE',GS:'NYSE',CAT:'NYSE',BA:'NYSE',
  MMM:'NYSE',GE:'NYSE',F:'NYSE',GM:'NYSE',WMT:'NYSE',
  TGT:'NYSE',LOW:'NYSE',NKE:'NYSE',TSM:'NYSE',SAP:'NYSE',
  TM:'NYSE',HSBC:'NYSE',SHEL:'NYSE',BHP:'NYSE',RIO:'NYSE',
  LLY:'NYSE',ORCL:'NYSE',AMAT:'NASDAQ',MU:'NASDAQ',ADBE:'NASDAQ',
  BAC:'NYSE',WFC:'NYSE',MS:'NYSE',BLK:'NYSE',C:'NYSE',
  AXP:'NYSE',SCHW:'NYSE',USB:'NYSE',PNC:'NYSE',TFC:'NYSE',
  PFE:'NYSE',ABT:'NYSE',CVS:'NYSE',MDT:'NYSE',ISRG:'NASDAQ',
  COP:'NYSE',EOG:'NYSE',SLB:'NYSE',MPC:'NYSE',PSX:'NYSE',
  VLO:'NYSE',OXY:'NYSE',DVN:'NYSE',HAL:'NYSE',BKR:'NYSE',
  T:'NYSE',VZ:'NYSE',MO:'NYSE',WBA:'NASDAQ',
};
 
function getExchange(stock) {
  // top3 stocks have exchange field; custom scan stocks don't \u2014 fall back to map then US_SET
  if (stock.exchange) return stock.exchange;
  if (EXCHANGE_MAP[stock.ticker]) return EXCHANGE_MAP[stock.ticker];
  return US_SET.has(stock.ticker) ? 'NYSE' : 'INTL';
}
 
var C = {
  pageBg:    '#F1EFE8',
  cardBg:    '#E8E5DC',
  darkBg:    '#5F5E56',
  deepBg:    '#3A3832',
  accent:    '#8B7D6B',
  accentDk:  '#6B5D4F',
  gold:      '#B8A070',
  border:    'rgba(95,94,86,0.2)',
  borderDk:  'rgba(95,94,86,0.4)',
  tx:        '#2C2C2A',
  txMid:     '#5F5E56',
  txLight:   '#9A9890',
  amber:     '#B8903A',
  amberBg:   '#F5EDD0',
  amberBd:   '#D4B870',
  green:     '#4A6741',
  greenBg:   '#DDE8D8',
  greenBd:   '#A8C0A0',
  red:       '#7A3A30',
  redBg:     '#F0DDD9',
  redBd:     '#C8A09A',
};
 
var FONTS = "'Cormorant Garamond', 'Georgia', serif";
var SANS  = "'DM Sans', 'Helvetica Neue', sans-serif";
var MONO  = "'DM Mono', 'Courier New', monospace";
 
function getRating(score) {
  if (score >= 5) return { label: 'Strong Buy', color: C.green,   bg: C.greenBg, border: C.greenBd };
  if (score === 4) return { label: 'Buy',        color: '#4A6741', bg: '#E8EEDF', border: '#B0C8A8' };
  if (score === 3) return { label: 'Watch',      color: '#7A6030', bg: '#F0E8D0', border: '#C8A870' };
  return                  { label: 'Ignore',     color: C.txMid,   bg: C.cardBg,  border: C.border  };
}
 
function ScoreDots({ score, max }) {
  max = max || 6;
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {Array.from({ length: max }).map(function(_, i) {
        var filled = i < score;
        var color  = score >= 5 ? C.green : score >= 4 ? '#6A8B60' : score >= 3 ? '#B8903A' : C.txLight;
        return (
          <div key={i} style={{
            width: 7, height: 7, borderRadius: '50%',
            background: filled ? color : 'transparent',
            border: '1px solid ' + (filled ? color : C.borderDk)
          }}/>
        );
      })}
    </div>
  );
}
 
function SigPill({ sig }) {
  var bg    = sig.status === 'pass' ? C.greenBg  : sig.status === 'fail' ? C.redBg  : C.amberBg;
  var color = sig.status === 'pass' ? C.green    : sig.status === 'fail' ? C.red    : C.amber;
  var bd    = sig.status === 'pass' ? C.greenBd  : sig.status === 'fail' ? C.redBd  : C.amberBd;
  var dot   = sig.status === 'pass' ? C.green    : sig.status === 'fail' ? C.red    : C.amber;
  return (
    <div style={{ background: bg, border: '0.5px solid ' + bd, borderRadius: 6, padding: '5px 7px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
        <div style={{ width: 5, height: 5, borderRadius: '50%', background: dot, flexShrink: 0 }}/>
        <div style={{ fontSize: 8, color: C.txLight, fontFamily: SANS, textTransform: 'uppercase', letterSpacing: '0.04em', lineHeight: 1.2 }}>
          {sig.label}
        </div>
      </div>
      <div style={{ fontSize: 10, fontWeight: 500, color: color, fontFamily: MONO, lineHeight: 1.3, wordBreak: 'break-word' }}>
        {sig.value || '--'}
      </div>
    </div>
  );
}
 
// Large feature card for Top 3 picks
function FeatureCard({ stock, rank }) {
  if (!stock) return null;
  var sc       = Math.min(stock.score || 0, 6);
  var chgPos   = stock.change && stock.change.startsWith('+');
  var medals   = ['I', 'II', 'III'];
  var exchange = getExchange(stock);
  // Score colour
  var scoreColor = sc >= 5 ? C.gold : sc >= 4 ? '#A8C080' : sc >= 3 ? '#C8A870' : C.txLight;
 
  return (
    <div style={{
      background: C.deepBg,
      border: '1px solid ' + C.accent,
      borderTop: '3px solid ' + C.gold,
      borderRadius: 2,
      padding: '24px 22px',
      position: 'relative',
      flex: 1,
      minWidth: 0
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 10, color: C.gold, fontFamily: SANS, letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 6 }}>
            {'Rank ' + medals[rank - 1]}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 26, fontWeight: 700, fontFamily: FONTS, color: '#F1EFE8', letterSpacing: '0.02em' }}>
              {stock.ticker}
            </span>
            {/* Exchange badge \u2014 replaces US/INTL */}
            <span style={{
              fontSize: 9, fontFamily: SANS, padding: '2px 6px', borderRadius: 2,
              letterSpacing: '0.08em', background: 'rgba(184,160,112,0.15)',
              color: C.gold, border: '0.5px solid ' + C.gold
            }}>
              {exchange}
            </span>
          </div>
          <div style={{ fontSize: 12, color: C.txLight, fontFamily: SANS }}>{stock.company || ''}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          {/* Score uses FONTS (Cormorant Garamond) to match Signal Engine header */}
          <div style={{
            fontSize: 26, fontWeight: 700, fontFamily: FONTS,
            letterSpacing: '0.04em', color: scoreColor, lineHeight: 1
          }}>
            {sc + '/6'}
          </div>
          <div style={{ marginTop: 6, display: 'flex', justifyContent: 'flex-end' }}>
            <ScoreDots score={sc} max={6}/>
          </div>
        </div>
      </div>
 
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 18, fontFamily: SANS, fontWeight: 500, color: '#F1EFE8' }}>
          {stock.price || '--'}
          {stock.change && (
            <span style={{ fontSize: 12, marginLeft: 8, color: chgPos ? '#80C080' : C.red }}>
              {stock.change}
            </span>
          )}
          {stock.marketCap && (
            <span style={{ fontSize: 11, marginLeft: 8, color: C.txLight, fontWeight: 400 }}>
              {stock.marketCap}
            </span>
          )}
        </div>
      </div>
 
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 5, marginBottom: 14 }}>
        {SIG_LABELS.map(function(label, i) {
          var sig = (stock.signals || [])[i] || {};
          return <SigPill key={i} sig={{ status: sig.status, value: sig.value, label: label }}/>;
        })}
      </div>
 
      <div style={{ padding: '10px 12px', background: 'rgba(241,239,232,0.04)', borderRadius: 2, border: '0.5px solid rgba(184,160,112,0.2)' }}>
        <span style={{ fontSize: 11, color: C.txLight, fontFamily: SANS, lineHeight: 1.55 }}>
          {stock.summary || ''}
        </span>
      </div>
 
      <div style={{ position: 'absolute', top: 14, right: 18, fontSize: 9, color: 'rgba(154,152,144,0.5)', fontFamily: MONO }}>
        {stock.updatedAt ? new Date(stock.updatedAt).toLocaleTimeString() : ''}
      </div>
    </div>
  );
}
 
// Compact card for custom scan results
function ResultCard({ stock, rank }) {
  var sc       = Math.min(stock.score || 0, 6);
  var rating   = getRating(sc);
  var chgPos   = stock.change && stock.change.startsWith('+');
  var exchange = getExchange(stock);
  var rnkBg    = rank === 1 ? { bg: C.gold, color: '#2C2C2A' } : rank === 2 ? { bg: C.accent, color: '#F1EFE8' } : rank === 3 ? { bg: C.accentDk, color: '#F1EFE8' } : { bg: C.border, color: C.txMid };
  var scoreColor = sc >= 5 ? C.gold : sc >= 4 ? C.green : sc >= 3 ? '#B8903A' : C.txLight;
 
  return (
    <div style={{
      background: C.cardBg,
      border: '0.5px solid ' + C.borderDk,
      borderLeft: '3px solid ' + (sc >= 5 ? C.gold : sc >= 4 ? C.green : sc >= 3 ? '#B8903A' : C.borderDk),
      borderRadius: 2,
      padding: '14px 16px'
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 26, height: 26, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 600, fontFamily: MONO, flexShrink: 0,
            background: rnkBg.bg, color: rnkBg.color
          }}>
            {rank}
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 16, fontWeight: 700, fontFamily: FONTS, letterSpacing: '0.02em', color: C.tx }}>
                {stock.ticker}
              </span>
              {/* Exchange badge */}
              <span style={{
                fontSize: 8, fontFamily: SANS, padding: '2px 5px', borderRadius: 2,
                letterSpacing: '0.06em', background: C.darkBg, color: '#F1EFE8'
              }}>
                {exchange}
              </span>
              <span style={{
                fontSize: 9, fontFamily: SANS, fontWeight: 600, padding: '2px 8px',
                borderRadius: 20, letterSpacing: '0.06em', textTransform: 'uppercase',
                background: rating.bg, color: rating.color, border: '0.5px solid ' + rating.border
              }}>
                {rating.label}
              </span>
            </div>
            <div style={{ fontSize: 11, color: C.txMid, marginTop: 2, fontFamily: SANS }}>{stock.company || ''}</div>
            {stock.price && (
              <div style={{ fontSize: 11, color: C.txMid, fontFamily: MONO, marginTop: 2 }}>
                {stock.price}
                {stock.change && <span style={{ marginLeft: 6, color: chgPos ? C.green : C.red }}>{stock.change}</span>}
                {stock.marketCap && <span style={{ marginLeft: 6 }}>{stock.marketCap}</span>}
              </div>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
          {/* Score uses FONTS (Cormorant Garamond) to match Signal Engine header */}
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: FONTS, letterSpacing: '0.04em', color: scoreColor }}>
            {sc + '/6'}
          </div>
          <ScoreDots score={sc} max={6}/>
        </div>
      </div>
 
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4, marginBottom: 8 }}>
        {SIG_LABELS.map(function(label, i) {
          var sig = (stock.signals || [])[i] || {};
          return <SigPill key={i} sig={{ status: sig.status, value: sig.value, label: label }}/>;
        })}
      </div>
 
      {stock.summary && (
        <div style={{ fontSize: 11, color: C.txMid, borderTop: '0.5px solid ' + C.border, paddingTop: 8, lineHeight: 1.55, fontFamily: SANS }}>
          {stock.summary}
          <span style={{ marginLeft: 8, fontSize: 9, color: C.txLight, fontFamily: MONO }}>
            {'Finnhub \u00b7 ' + (stock.updatedAt ? new Date(stock.updatedAt).toLocaleTimeString() : '')}
          </span>
        </div>
      )}
      {stock.error && (
        <div style={{ fontSize: 11, color: C.red, borderTop: '0.5px solid ' + C.border, paddingTop: 8, fontFamily: SANS }}>
          {'Error: ' + stock.error}
        </div>
      )}
    </div>
  );
}
 
export default function Home() {
  var inputState      = useState('');
  var input           = inputState[0];
  var setInput        = inputState[1];
  var resultsState    = useState([]);
  var results         = resultsState[0];
  var setResults      = resultsState[1];
  var scanningState   = useState(false);
  var scanning        = scanningState[0];
  var setScanning     = scanningState[1];
  var statusState     = useState('');
  var status          = statusState[0];
  var setStatus       = statusState[1];
  var progressState   = useState(0);
  var progress        = progressState[0];
  var setProgress     = progressState[1];
  var filterState     = useState('all');
  var filter          = filterState[0];
  var setFilter       = filterState[1];
  var updatedState    = useState('');
  var updatedAt       = updatedState[0];
  var setUpdatedAt    = updatedState[1];
  var presetState     = useState('');
  var activePreset    = presetState[0];
  var setActivePreset = presetState[1];
  var top3State       = useState(null);
  var top3            = top3State[0];
  var setTop3         = top3State[1];
  var top3LoadState   = useState(false);
  var top3Loading     = top3LoadState[0];
  var setTop3Loading  = top3LoadState[1];
  var timerRef        = useRef(null);
  var tickersRef      = useRef([]);
 
  var scan = useCallback(function(tickers) {
    setScanning(true);
    setStatus('Analysing ' + tickers.length + ' securities...');
    setProgress(10);
    return fetch('/api/analyse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers: tickers })
    }).then(function(res) {
      if (!res.ok) return res.json().then(function(e) { throw new Error(e.error || 'HTTP ' + res.status); });
      return res.json();
    }).then(function(data) {
      var arr = Object.values(data.results).filter(Boolean).sort(function(a, b) { return (b.score||0)-(a.score||0); });
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
    var tickers = input.split(/[\s,;]+/).map(function(t) { return t.toUpperCase().trim(); }).filter(Boolean).slice(0, 20);
    if (!tickers.length) return;
    tickersRef.current = tickers;
    clearInterval(timerRef.current);
    setResults([]);
    scan(tickers);
    timerRef.current = setInterval(function() { scan(tickersRef.current); }, 5*60*1000);
  }
 
  function doRefresh() { if (tickersRef.current.length) scan(tickersRef.current); }
 
  useEffect(function() { return function() { clearInterval(timerRef.current); }; }, []);
 
  useEffect(function() {
    setTop3Loading(true);
    fetch('/api/top3')
      .then(function(r) { return r.json(); })
      .then(function(d) { if (d.top3) setTop3(d); })
      .catch(function() {})
      .finally(function() { setTop3Loading(false); });
  }, []);
 
  var filtered = results.filter(function(r) {
    if (filter === 'strong') return (r.score||0) >= 5;
    if (filter === 'mod')    return (r.score||0) === 3 || (r.score||0) === 4;
    if (filter === 'weak')   return (r.score||0) <= 2;
    if (filter === 'us')     return US_SET.has(r.ticker);
    if (filter === 'intl')   return !US_SET.has(r.ticker);
    return true;
  });
 
  var stats = {
    total:    results.filter(function(r) { return r.score != null; }).length,
    strong:   results.filter(function(r) { return (r.score||0) >= 5; }).length,
    moderate: results.filter(function(r) { return (r.score||0) === 3 || (r.score||0) === 4; }).length,
    avg:      results.length ? (results.reduce(function(s,r){return s+(r.score||0);},0)/results.length).toFixed(1) : '--'
  };
 
  function exportCSV() {
    var hdr  = ['Rank','Ticker','Company','Score','Price','Change','MktCap','EPS','PE_hist','vs50dMA','Insider','Analyst','PE_peers','Summary'];
    var rows = filtered.map(function(r,i) {
      var g = r.signals||[];
      return [i+1,r.ticker,'"'+(r.company||'').replace(/"/g,'""')+'"',r.score||0,r.price||'',r.change||'',r.marketCap||'',
        g[0]?g[0].value||'':'',g[1]?g[1].value||'':'',g[2]?g[2].value||'':'',g[3]?g[3].value||'':'',g[4]?g[4].value||'':'',g[5]?g[5].value||'':'',
        '"'+(r.summary||'').replace(/"/g,'""')+'"'].join(',');
    });
    var blob = new Blob([[hdr.join(',')].concat(rows).join('\n')],{type:'text/csv'});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'signals_'+new Date().toISOString().slice(0,10)+'.csv';
    a.click();
  }
 
  var top3Stocks   = top3 && top3.top3        ? top3.top3        : [];
  var scannedTotal = top3 && top3.totalScanned ? top3.totalScanned : 0;
 
  return (
    <>
      <Head>
        <title>Signal Engine</title>
        <meta name="description" content="Institutional-grade equity value scanner"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;0,700;1,300;1,400&family=DM+Sans:wght@300;400;500&family=DM+Mono:wght@300;400&display=swap" rel="stylesheet"/>
        <style>{`
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { background: ${C.pageBg}; }
          ::selection { background: ${C.gold}; color: #2C2C2A; }
          input::placeholder { color: ${C.txLight}; }
          input:focus { outline: none; }
          button { cursor: pointer; }
          button:disabled { opacity: 0.4; cursor: not-allowed; }
          @keyframes fadeUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
          @keyframes spin { to { transform: rotate(360deg); } }
          @keyframes shimmer { 0%,100% { opacity: 0.4; } 50% { opacity: 0.8; } }
          .card-anim { animation: fadeUp 0.4s ease both; }
          .card-anim:nth-child(1) { animation-delay: 0.05s; }
          .card-anim:nth-child(2) { animation-delay: 0.12s; }
          .card-anim:nth-child(3) { animation-delay: 0.19s; }
        `}</style>
      </Head>
 
      <div style={{ background: C.pageBg, minHeight: '100vh', color: C.tx, fontFamily: SANS }}>
 
        {/* \u2500\u2500 Header \u2500\u2500 */}
        <div style={{ background: C.deepBg, borderBottom: '1px solid rgba(184,160,112,0.3)', padding: '0 32px' }}>
          <div style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 64 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div style={{ width: 32, height: 32, border: '1px solid ' + C.gold, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill={C.gold}><path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z"/></svg>
              </div>
              <div>
                <div style={{ fontSize: 18, fontFamily: FONTS, fontWeight: 600, color: '#F1EFE8', letterSpacing: '0.08em' }}>
                  SIGNAL ENGINE
                </div>
                <div style={{ fontSize: 9, color: C.gold, fontFamily: SANS, letterSpacing: '0.18em', textTransform: 'uppercase', marginTop: 1 }}>
                  Equity Undervalue Scanner
                </div>
              </div>
            </div>
            <div style={{ textAlign: 'right', fontSize: 10, color: C.txLight, fontFamily: MONO, lineHeight: 1.8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: scanning ? '#C8A870' : results.length ? '#80C080' : C.txLight }}/>
                <span style={{ color: '#F1EFE8' }}>{scanning ? 'Scanning...' : results.length ? 'Live' : 'Ready'}</span>
              </div>
              {updatedAt && <div>{'Updated ' + updatedAt}</div>}
            </div>
          </div>
        </div>
 
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 32px 80px' }}>
 
          {/* \u2500\u2500 Top 3 Picks \u2500\u2500 */}
          <div style={{ marginBottom: 40 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 20 }}>
              <h2 style={{ fontSize: 36, fontFamily: FONTS, fontWeight: 600, color: C.tx, letterSpacing: '0.02em' }}>
                Top Picks Today
              </h2>
              <div style={{ height: '0.5px', flex: 1, background: C.borderDk }}/>
              <div style={{ fontSize: 10, color: C.txLight, fontFamily: SANS, letterSpacing: '0.1em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                {top3Loading ? 'Scanning watchlist...' : scannedTotal > 0 ? scannedTotal + ' securities screened' : ''}
              </div>
            </div>
 
            {top3Loading && (
              <div style={{ display: 'flex', gap: 16 }}>
                {[0,1,2].map(function(i) {
                  return (
                    <div key={i} style={{ flex: 1, background: C.cardBg, border: '0.5px solid ' + C.border, borderTop: '3px solid ' + C.border, borderRadius: 2, padding: '24px 22px', animation: 'shimmer 1.5s infinite', animationDelay: (i*0.2)+'s' }}>
                      <div style={{ fontSize: 10, color: C.txLight, fontFamily: SANS, letterSpacing: '0.1em', marginBottom: 8 }}>Rank {['I','II','III'][i]}</div>
                      <div style={{ width: 80, height: 28, background: C.border, borderRadius: 2, marginBottom: 8 }}/>
                      <div style={{ width: 140, height: 12, background: C.border, borderRadius: 2 }}/>
                    </div>
                  );
                })}
              </div>
            )}
 
            {!top3Loading && top3Stocks.length > 0 && (
              <div style={{ display: 'flex', gap: 16 }}>
                {top3Stocks.map(function(stock, i) {
                  return (
                    <div key={stock.ticker} className="card-anim" style={{ flex: 1, minWidth: 0 }}>
                      <FeatureCard stock={stock} rank={i+1}/>
                    </div>
                  );
                })}
              </div>
            )}
 
            {!top3Loading && top3Stocks.length === 0 && (
              <div style={{ padding: '32px', background: C.cardBg, border: '0.5px solid ' + C.border, borderRadius: 2, textAlign: 'center', color: C.txLight, fontFamily: SANS, fontSize: 13 }}>
                Top picks are loading in the background. This scan covers ~60 securities and may take a minute.
              </div>
            )}
          </div>
 
          {/* \u2500\u2500 Custom Scan divider \u2500\u2500 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 32 }}>
            <h2 style={{ fontSize: 36, fontFamily: FONTS, fontWeight: 600, color: C.tx, letterSpacing: '0.02em', whiteSpace: 'nowrap' }}>
              Custom Scan
            </h2>
            <div style={{ height: '0.5px', flex: 1, background: C.borderDk }}/>
          </div>
 
          {/* \u2500\u2500 Search & Presets \u2500\u2500 */}
          <div style={{ background: C.cardBg, border: '0.5px solid ' + C.borderDk, padding: '20px 20px', marginBottom: 20 }}>
            <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
              <input type="text" value={input}
                onChange={function(e) { setInput(e.target.value); }}
                onKeyDown={function(e) { if (e.key === 'Enter') runScan(); }}
                placeholder="Enter ticker symbols: AAPL, MSFT, NVDA, TSM..."
                style={{ flex: 1, background: C.pageBg, border: '0.5px solid ' + C.borderDk, padding: '10px 14px',
                  fontSize: 13, fontFamily: MONO, color: C.tx, borderRadius: 0 }}/>
              <button onClick={runScan} disabled={scanning}
                style={{ padding: '10px 24px', background: C.darkBg, color: '#F1EFE8', border: 'none',
                  fontSize: 12, fontFamily: SANS, fontWeight: 500, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                {scanning ? 'Scanning...' : 'Scan'}
              </button>
              {results.length > 0 && (
                <button onClick={doRefresh} disabled={scanning}
                  style={{ padding: '10px 16px', background: 'transparent', color: C.txMid, border: '0.5px solid ' + C.borderDk, fontSize: 12, fontFamily: SANS }}>
                  Refresh
                </button>
              )}
              {results.length > 0 && (
                <button onClick={function() { setResults([]); tickersRef.current=[]; setUpdatedAt(''); }}
                  style={{ padding: '10px 16px', background: 'transparent', color: C.txMid, border: '0.5px solid ' + C.borderDk, fontSize: 12, fontFamily: SANS }}>
                  Clear
                </button>
              )}
            </div>
 
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 9, color: C.txLight, fontFamily: SANS, letterSpacing: '0.12em', textTransform: 'uppercase', marginRight: 4 }}>Sectors</span>
              {Object.keys(PRESETS).map(function(name) {
                var active = activePreset === name;
                return (
                  <button key={name} onClick={function() { setInput(PRESETS[name]); setActivePreset(name); }}
                    style={{ padding: '4px 12px', fontSize: 10, fontFamily: SANS, letterSpacing: '0.06em',
                      background: active ? C.darkBg : 'transparent',
                      color: active ? '#F1EFE8' : C.txMid,
                      border: '0.5px solid ' + (active ? C.darkBg : C.borderDk),
                      borderRadius: 0, whiteSpace: 'nowrap' }}>
                    {name}
                  </button>
                );
              })}
            </div>
          </div>
 
          {/* \u2500\u2500 Filters \u2500\u2500 */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
            <span style={{ fontSize: 9, color: C.txLight, fontFamily: SANS, letterSpacing: '0.12em', textTransform: 'uppercase', marginRight: 4 }}>Filter</span>
            {[['all','All'],['strong','Strong 5-6'],['mod','Moderate 3-4'],['weak','Weak 0-2'],['us','US'],['intl','International']].map(function(kl) {
              var active = filter === kl[0];
              return (
                <button key={kl[0]} onClick={function() { setFilter(kl[0]); }}
                  style={{ padding: '4px 12px', fontSize: 10, fontFamily: SANS, letterSpacing: '0.06em',
                    background: active ? C.accentDk : 'transparent',
                    color: active ? '#F1EFE8' : C.txMid,
                    border: '0.5px solid ' + (active ? C.accentDk : C.borderDk), borderRadius: 0 }}>
                  {kl[1]}
                </button>
              );
            })}
          </div>
 
          {/* \u2500\u2500 Progress \u2500\u2500 */}
          {scanning && (
            <div style={{ height: 2, background: C.border, marginBottom: 16, overflow: 'hidden' }}>
              <div style={{ height: '100%', background: C.gold, width: progress + '%', transition: 'width 0.4s' }}/>
            </div>
          )}
 
          {/* \u2500\u2500 Status \u2500\u2500 */}
          {status && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: status.startsWith('Error') ? C.red : C.txMid, fontFamily: MONO, marginBottom: 12 }}>
              {scanning && <div style={{ width: 11, height: 11, border: '1.5px solid ' + C.border, borderTopColor: C.gold, borderRadius: '50%', flexShrink: 0, animation: 'spin 0.7s linear infinite' }}/>}
              {status}
            </div>
          )}
 
          {/* \u2500\u2500 Results \u2500\u2500 */}
          {filtered.length === 0 && !scanning ? (
            <div style={{ textAlign: 'center', padding: '48px 16px', color: C.txLight, fontFamily: FONTS, fontSize: 18, fontStyle: 'italic', fontWeight: 300 }}>
              {results.length > 0 ? 'No results match this filter.' : 'Select a sector or enter tickers above to begin scanning.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {filtered.map(function(stock, i) {
                return <ResultCard key={stock.ticker} stock={stock} rank={i+1}/>;
              })}
            </div>
          )}
 
          {/* \u2500\u2500 Export \u2500\u2500 */}
          {results.length > 0 && (
            <div style={{ display: 'flex', gap: 8, marginTop: 24, paddingTop: 20, borderTop: '0.5px solid ' + C.borderDk, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: C.txLight, fontFamily: MONO, flex: 1, letterSpacing: '0.06em' }}>
                {filtered.length + ' securities ready to export'}
              </span>
              <button onClick={exportCSV}
                style={{ padding: '8px 18px', background: 'transparent', color: C.txMid, border: '0.5px solid ' + C.borderDk, fontSize: 11, fontFamily: SANS, letterSpacing: '0.06em' }}>
                Export CSV
              </button>
              <button onClick={function() {
                var out = filtered.map(function(r,i) { return Object.assign({rank:i+1},r); });
                var blob = new Blob([JSON.stringify(out,null,2)],{type:'application/json'});
                var a = document.createElement('a'); a.href=URL.createObjectURL(blob);
                a.download='signals_'+new Date().toISOString().slice(0,10)+'.json'; a.click();
              }} style={{ padding: '8px 18px', background: 'transparent', color: C.txMid, border: '0.5px solid ' + C.borderDk, fontSize: 11, fontFamily: SANS, letterSpacing: '0.06em' }}>
                Export JSON
              </button>
            </div>
          )}
 
        </div>
      </div>
    </>
  );
}
 
