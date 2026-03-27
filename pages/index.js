import { useState, useEffect, useRef, useCallback } from 'react';
import Head from 'next/head';
 
// ── Top picks universe — pre-selected high-quality candidates across sectors
// These are analysed on page load. No scan phase. Cards appear as each resolves.
// Split into batches of 6 so /api/analyse (20 ticker limit) isn't exceeded.
// We run batches in parallel, rank by score, keep top 3.
const TOP_PICKS_UNIVERSE = [
  // Batch 1: large-cap value / profitable
  ['MSFT', 'AAPL', 'GOOGL', 'META', 'AMZN', 'NVDA'],
  // Batch 2: financials + healthcare
  ['JPM', 'BAC', 'GS', 'LLY', 'JNJ', 'UNH'],
  // Batch 3: energy + consumer + industrials
  ['XOM', 'CVX', 'HD', 'WMT', 'CAT', 'DE'],
  // Batch 4: dividend / value plays
  ['KO', 'PEP', 'MO', 'T', 'VZ', 'IBM'],
];
 
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
 
const SIG_LABELS = ['EPS & Rev beat', 'PE vs hist avg', 'Price vs 50d MA', 'Insider buying', 'Analyst +25% upside', 'PE vs peers'];
 
const US_SET = new Set('AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,JPM,XOM,UNH,LLY,AVGO,ORCL,AMD,INTC,QCOM,TXN,AMAT,MU,ADBE,BAC,WFC,GS,MS,BLK,C,AXP,SCHW,USB,PNC,TFC,JNJ,ABBV,MRK,PFE,TMO,ABT,AMGN,CVS,MDT,ISRG,COP,EOG,SLB,MPC,PSX,VLO,OXY,DVN,HAL,BKR,CVX,HD,MCD,NKE,SBUX,LOW,TGT,COST,WMT,T,VZ,MO,PM,KO,PEP,MMM,IBM,CAT,DE,GE,HON,RTX,LMT'.split(','));
 
const C = {
  pageBg:   '#F1EFE8',
  cardBg:   '#E8E5DC',
  darkBg:   '#2D2C28',
  deepBg:   '#1E1D1A',
  accent:   '#8B7D6B',
  accentDk: '#6B5D4F',
  gold:     '#B8A070',
  goldLt:   '#D4BC8C',
  border:   'rgba(95,94,86,0.18)',
  borderDk: 'rgba(95,94,86,0.35)',
  tx:       '#2C2C2A',
  txMid:    '#5F5E56',
  txLight:  '#9A9890',
  amber:    '#B8903A',
  amberBg:  '#F5EDD0',
  amberBd:  '#D4B870',
  green:    '#3D6B35',
  greenBg:  '#D8EAD4',
  greenBd:  '#96BA8E',
  red:      '#7A3A30',
  redBg:    '#EDD8D4',
  redBd:    '#C09088',
};
 
const FONTS = "'Cormorant Garamond', 'Georgia', serif";
const SANS  = "'DM Sans', 'Helvetica Neue', sans-serif";
const MONO  = "'DM Mono', 'Courier New', monospace";
 
function getRating(score) {
  if (score >= 5) return { label: 'Strong Buy', color: C.green,   bg: C.greenBg, border: C.greenBd };
  if (score === 4) return { label: 'Buy',        color: '#4A7040', bg: '#E2EED8', border: '#A8C8A0' };
  if (score === 3) return { label: 'Watch',      color: '#7A6030', bg: '#F0E8D0', border: '#C8A870' };
  return                  { label: 'Ignore',     color: C.txMid,   bg: C.cardBg,  border: C.border  };
}
 
function ScoreDots({ score, max = 6 }) {
  const color = score >= 5 ? C.gold : score >= 4 ? '#7AB068' : score >= 3 ? C.amber : C.txLight;
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      {Array.from({ length: max }).map((_, i) => (
        <div key={i} style={{
          width: 7, height: 7, borderRadius: '50%',
          background: i < score ? color : 'transparent',
          border: `1.5px solid ${i < score ? color : C.borderDk}`,
          transition: 'all 0.3s ease',
        }} />
      ))}
    </div>
  );
}
 
function SigPill({ sig, label }) {
  const bg    = sig.status === 'pass' ? C.greenBg  : sig.status === 'fail' ? C.redBg  : C.amberBg;
  const color = sig.status === 'pass' ? C.green    : sig.status === 'fail' ? C.red    : C.amber;
  const bd    = sig.status === 'pass' ? C.greenBd  : sig.status === 'fail' ? C.redBd  : C.amberBd;
  return (
    <div style={{ background: bg, border: `0.5px solid ${bd}`, borderRadius: 5, padding: '5px 7px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
        <div style={{ width: 5, height: 5, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <div style={{ fontSize: 8, color: C.txLight, fontFamily: SANS, textTransform: 'uppercase', letterSpacing: '0.05em', lineHeight: 1 }}>
          {label}
        </div>
      </div>
      <div style={{ fontSize: 10, fontWeight: 500, color, fontFamily: MONO, lineHeight: 1.3, wordBreak: 'break-word' }}>
        {sig.value || '--'}
      </div>
    </div>
  );
}
 
// Skeleton card — shows immediately, no layout shift when data arrives
function SkeletonCard({ rank }) {
  const medals = ['I', 'II', 'III'];
  return (
    <div style={{
      background: C.darkBg, border: `1px solid ${C.accent}`,
      borderTop: `3px solid rgba(184,160,112,0.3)`,
      borderRadius: 2, padding: '24px 22px', flex: 1, minWidth: 0,
      animation: 'shimmer 1.8s ease-in-out infinite',
    }}>
      <div style={{ fontSize: 10, color: 'rgba(184,160,112,0.5)', fontFamily: SANS, letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 10 }}>
        Rank {medals[rank - 1]}
      </div>
      <div style={{ width: 90, height: 30, background: 'rgba(255,255,255,0.06)', borderRadius: 3, marginBottom: 10 }} />
      <div style={{ width: 150, height: 12, background: 'rgba(255,255,255,0.04)', borderRadius: 2, marginBottom: 20 }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 5, marginBottom: 14 }}>
        {[0,1,2,3,4,5].map(i => (
          <div key={i} style={{ height: 52, background: 'rgba(255,255,255,0.04)', borderRadius: 5 }} />
        ))}
      </div>
      <div style={{ height: 36, background: 'rgba(255,255,255,0.03)', borderRadius: 2 }} />
    </div>
  );
}
 
function FeatureCard({ stock, rank }) {
  if (!stock) return <SkeletonCard rank={rank} />;
  const sc = Math.min(stock.score || 0, 6);
  const chgPos = stock.change && stock.change.startsWith('+');
  const medals = ['I', 'II', 'III'];
  const scoreColor = sc >= 5 ? C.gold : sc >= 4 ? '#8CC878' : sc >= 3 ? C.amber : C.txLight;
 
  return (
    <div style={{
      background: C.darkBg, border: `1px solid ${C.accent}`,
      borderTop: `3px solid ${C.gold}`, borderRadius: 2,
      padding: '24px 22px', flex: 1, minWidth: 0,
      animation: 'fadeUp 0.4s ease both',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 10, color: C.gold, fontFamily: SANS, letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 6 }}>
            Rank {medals[rank - 1]}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 26, fontWeight: 700, fontFamily: FONTS, color: '#F1EFE8', letterSpacing: '0.02em' }}>
              {stock.ticker}
            </span>
            <span style={{
              fontSize: 9, fontFamily: SANS, padding: '2px 6px', borderRadius: 2,
              letterSpacing: '0.08em', background: 'rgba(184,160,112,0.15)',
              color: C.gold, border: `0.5px solid ${C.gold}`,
            }}>
              {stock.exchange || 'NYSE'}
            </span>
          </div>
          <div style={{ fontSize: 11, color: C.txLight, fontFamily: SANS }}>{stock.company || ''}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 26, fontWeight: 700, fontFamily: FONTS, letterSpacing: '0.04em', color: scoreColor, lineHeight: 1 }}>
            {sc}/6
          </div>
          <div style={{ marginTop: 6, display: 'flex', justifyContent: 'flex-end' }}>
            <ScoreDots score={sc} />
          </div>
        </div>
      </div>
 
      <div style={{ marginBottom: 14 }}>
        <span style={{ fontSize: 18, fontFamily: SANS, fontWeight: 500, color: '#F1EFE8' }}>{stock.price || '--'}</span>
        {stock.change && (
          <span style={{ fontSize: 12, marginLeft: 8, color: chgPos ? '#7EC87E' : '#D07070' }}>{stock.change}</span>
        )}
        {stock.marketCap && (
          <span style={{ fontSize: 11, marginLeft: 8, color: C.txLight }}>{stock.marketCap}</span>
        )}
      </div>
 
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 5, marginBottom: 14 }}>
        {SIG_LABELS.map((label, i) => {
          const sig = (stock.signals || [])[i] || {};
          return <SigPill key={i} sig={{ status: sig.status, value: sig.value }} label={label} />;
        })}
      </div>
 
      <div style={{ padding: '10px 12px', background: 'rgba(241,239,232,0.04)', borderRadius: 2, border: `0.5px solid rgba(184,160,112,0.2)` }}>
        <span style={{ fontSize: 11, color: C.txLight, fontFamily: SANS, lineHeight: 1.55 }}>
          {stock.summary || ''}
        </span>
      </div>
 
      <div style={{ position: 'absolute', top: 14, right: 18, fontSize: 9, color: 'rgba(154,152,144,0.4)', fontFamily: MONO }}>
        {stock.updatedAt ? new Date(stock.updatedAt).toLocaleTimeString() : ''}
      </div>
    </div>
  );
}
 
// Compact card for custom scan
function ResultCard({ stock, rank }) {
  const sc = Math.min(stock.score || 0, 6);
  const rating = getRating(sc);
  const chgPos = stock.change && stock.change.startsWith('+');
  const scoreColor = sc >= 5 ? C.gold : sc >= 4 ? C.green : sc >= 3 ? C.amber : C.txLight;
  const rankColors = [
    { bg: C.gold, color: '#2C2C2A' },
    { bg: C.accent, color: '#F1EFE8' },
    { bg: C.accentDk, color: '#F1EFE8' },
  ];
  const rnk = rankColors[rank - 1] || { bg: C.border, color: C.txMid };
 
  return (
    <div style={{
      background: C.cardBg, borderRadius: 2,
      border: `0.5px solid ${C.borderDk}`,
      borderLeft: `3px solid ${sc >= 5 ? C.gold : sc >= 4 ? C.green : sc >= 3 ? C.amber : C.borderDk}`,
      padding: '14px 16px',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 26, height: 26, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 600, fontFamily: MONO, flexShrink: 0,
            background: rnk.bg, color: rnk.color,
          }}>
            {rank}
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 16, fontWeight: 700, fontFamily: FONTS, letterSpacing: '0.02em', color: C.tx }}>
                {stock.ticker}
              </span>
              <span style={{ fontSize: 8, fontFamily: SANS, padding: '2px 5px', borderRadius: 2, letterSpacing: '0.06em', background: C.darkBg, color: '#F1EFE8' }}>
                {stock.exchange || (US_SET.has(stock.ticker) ? 'NYSE' : 'INTL')}
              </span>
              <span style={{
                fontSize: 9, fontFamily: SANS, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                background: rating.bg, color: rating.color, border: `0.5px solid ${rating.border}`,
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
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: FONTS, letterSpacing: '0.04em', color: scoreColor }}>
            {sc}/6
          </div>
          <ScoreDots score={sc} />
        </div>
      </div>
 
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 4, marginBottom: 8 }}>
        {SIG_LABELS.map((label, i) => {
          const sig = (stock.signals || [])[i] || {};
          return <SigPill key={i} sig={{ status: sig.status, value: sig.value }} label={label} />;
        })}
      </div>
 
      {stock.summary && (
        <div style={{ fontSize: 11, color: C.txMid, borderTop: `0.5px solid ${C.border}`, paddingTop: 8, lineHeight: 1.55, fontFamily: SANS }}>
          {stock.summary}
          <span style={{ marginLeft: 8, fontSize: 9, color: C.txLight, fontFamily: MONO }}>
            Finnhub · {stock.updatedAt ? new Date(stock.updatedAt).toLocaleTimeString() : ''}
          </span>
        </div>
      )}
      {stock.error && (
        <div style={{ fontSize: 11, color: C.red, borderTop: `0.5px solid ${C.border}`, paddingTop: 8, fontFamily: SANS }}>
          Error: {stock.error}
        </div>
      )}
    </div>
  );
}
 
export default function Home() {
  const [input, setInput]             = useState('');
  const [results, setResults]         = useState([]);
  const [scanning, setScanning]       = useState(false);
  const [status, setStatus]           = useState('');
  const [filter, setFilter]           = useState('all');
  const [updatedAt, setUpdatedAt]     = useState('');
  const [activePreset, setActivePreset] = useState('');
 
  // Top picks state — starts as 3 nulls (skeletons), fills in as data arrives
  const [topPicks, setTopPicks]       = useState([null, null, null]);
  const [topPicksDone, setTopPicksDone] = useState(false);
  const [topScanned, setTopScanned]   = useState(0);
 
  const timerRef   = useRef(null);
  const tickersRef = useRef([]);
 
  // ── Top picks: fetch all batches in parallel, slot top 3 by score ──────────
  useEffect(() => {
    let cancelled = false;
    const allResults = [];
 
    async function fetchBatch(tickers) {
      const res = await fetch('/api/analyse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers }),
      });
      if (!res.ok) return;
      const data = await res.json();
      const stocks = Object.values(data.results || {})
        .filter(s => s && !s.error && s.score != null);
 
      if (cancelled) return;
 
      // Merge into allResults and re-rank top 3
      allResults.push(...stocks);
      allResults.sort((a, b) => (b.score || 0) - (a.score || 0));
      setTopScanned(prev => prev + tickers.length);
 
      // Fill slots: top 3 by score, rest null (skeleton)
      const top3 = allResults.slice(0, 3);
      setTopPicks([top3[0] || null, top3[1] || null, top3[2] || null]);
    }
 
    // Fire all batches simultaneously
    Promise.allSettled(TOP_PICKS_UNIVERSE.map(fetchBatch))
      .then(() => { if (!cancelled) setTopPicksDone(true); });
 
    return () => { cancelled = true; };
  }, []);
 
  // ── Custom scan ─────────────────────────────────────────────────────────────
  const scan = useCallback(async (tickers) => {
    setScanning(true);
    setStatus(`Analysing ${tickers.length} securities...`);
    try {
      const res = await fetch('/api/analyse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers }),
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const arr = Object.values(data.results)
        .filter(Boolean)
        .sort((a, b) => (b.score || 0) - (a.score || 0));
      setResults(arr);
      setUpdatedAt(new Date().toLocaleTimeString());
      setStatus('');
    } catch (e) {
      setStatus(`Error: ${e.message}`);
    } finally {
      setScanning(false);
    }
  }, []);
 
  function runScan() {
    const tickers = input.split(/[\s,;]+/).map(t => t.toUpperCase().trim()).filter(Boolean).slice(0, 20);
    if (!tickers.length) return;
    tickersRef.current = tickers;
    clearInterval(timerRef.current);
    setResults([]);
    scan(tickers);
    timerRef.current = setInterval(() => scan(tickersRef.current), 5 * 60 * 1000);
  }
 
  useEffect(() => () => clearInterval(timerRef.current), []);
 
  const filtered = results.filter(r => {
    if (filter === 'strong') return (r.score || 0) >= 5;
    if (filter === 'mod')    return (r.score || 0) === 3 || (r.score || 0) === 4;
    if (filter === 'weak')   return (r.score || 0) <= 2;
    if (filter === 'us')     return US_SET.has(r.ticker);
    if (filter === 'intl')   return !US_SET.has(r.ticker);
    return true;
  });
 
  function exportCSV() {
    const hdr = ['Rank', 'Ticker', 'Company', 'Score', 'Price', 'Change', 'MktCap', 'EPS', 'PE_hist', 'vs50dMA', 'Insider', 'Analyst', 'PE_peers', 'Summary'];
    const rows = filtered.map((r, i) => {
      const g = r.signals || [];
      return [i + 1, r.ticker, `"${(r.company || '').replace(/"/g, '""')}"`, r.score || 0, r.price || '', r.change || '', r.marketCap || '',
        g[0]?.value || '', g[1]?.value || '', g[2]?.value || '', g[3]?.value || '', g[4]?.value || '', g[5]?.value || '',
        `"${(r.summary || '').replace(/"/g, '""')}"`].join(',');
    });
    const blob = new Blob([[hdr.join(',')].concat(rows).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `signals_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }
 
  const loadedCount = topPicks.filter(Boolean).length;
  const totalUniverse = TOP_PICKS_UNIVERSE.flat().length;
 
  return (
    <>
      <Head>
        <title>Signal Engine</title>
        <meta name="description" content="Institutional-grade equity value scanner" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600;700&family=DM+Sans:wght@300;400;500&family=DM+Mono:wght@300;400&display=swap" rel="stylesheet" />
        <style>{`
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { background: ${C.pageBg}; }
          ::selection { background: ${C.gold}; color: #2C2C2A; }
          input::placeholder { color: ${C.txLight}; }
          input:focus { outline: none; }
          button { cursor: pointer; }
          button:disabled { opacity: 0.4; cursor: not-allowed; }
          @keyframes fadeUp {
            from { opacity: 0; transform: translateY(10px); }
            to   { opacity: 1; transform: translateY(0); }
          }
          @keyframes shimmer {
            0%, 100% { opacity: 0.5; }
            50%       { opacity: 0.8; }
          }
          @keyframes spin { to { transform: rotate(360deg); } }
        `}</style>
      </Head>
 
      <div style={{ background: C.pageBg, minHeight: '100vh', color: C.tx, fontFamily: SANS }}>
 
        {/* Header */}
        <div style={{ background: C.deepBg, borderBottom: `1px solid rgba(184,160,112,0.25)`, padding: '0 32px' }}>
          <div style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 64 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div style={{ width: 32, height: 32, border: `1px solid ${C.gold}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill={C.gold}>
                  <path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z" />
                </svg>
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
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: scanning ? C.amber : results.length ? '#6BC06B' : C.txLight }} />
                <span style={{ color: '#F1EFE8' }}>{scanning ? 'Scanning...' : results.length ? 'Live' : 'Ready'}</span>
              </div>
              {updatedAt && <div>Updated {updatedAt}</div>}
            </div>
          </div>
        </div>
 
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 32px 80px' }}>
 
          {/* Top Picks */}
          <div style={{ marginBottom: 40 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 20 }}>
              <h2 style={{ fontSize: 36, fontFamily: FONTS, fontWeight: 600, color: C.tx, letterSpacing: '0.02em' }}>
                Top Picks Today
              </h2>
              <div style={{ height: '0.5px', flex: 1, background: C.borderDk }} />
              <div style={{ fontSize: 10, color: C.txLight, fontFamily: SANS, letterSpacing: '0.1em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                {topPicksDone
                  ? `${totalUniverse} securities screened`
                  : loadedCount > 0
                    ? `${topScanned}/${totalUniverse} screened…`
                    : 'Scanning watchlist…'}
              </div>
            </div>
 
            <div style={{ display: 'flex', gap: 16, position: 'relative' }}>
              {[0, 1, 2].map(i => (
                <div key={i} style={{ flex: 1, minWidth: 0, position: 'relative' }}>
                  <FeatureCard stock={topPicks[i]} rank={i + 1} />
                </div>
              ))}
            </div>
          </div>
 
          {/* Custom Scan divider */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 32 }}>
            <h2 style={{ fontSize: 36, fontFamily: FONTS, fontWeight: 600, color: C.tx, letterSpacing: '0.02em', whiteSpace: 'nowrap' }}>
              Custom Scan
            </h2>
            <div style={{ height: '0.5px', flex: 1, background: C.borderDk }} />
          </div>
 
          {/* Search + presets */}
          <div style={{ background: C.cardBg, border: `0.5px solid ${C.borderDk}`, padding: '20px', marginBottom: 20 }}>
            <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
              <input
                type="text" value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && runScan()}
                placeholder="Enter ticker symbols: AAPL, MSFT, NVDA, TSM..."
                style={{ flex: 1, background: C.pageBg, border: `0.5px solid ${C.borderDk}`, padding: '10px 14px', fontSize: 13, fontFamily: MONO, color: C.tx, borderRadius: 0 }}
              />
              <button onClick={runScan} disabled={scanning}
                style={{ padding: '10px 24px', background: C.darkBg, color: '#F1EFE8', border: 'none', fontSize: 12, fontFamily: SANS, fontWeight: 500, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                {scanning ? 'Scanning...' : 'Scan'}
              </button>
              {results.length > 0 && (
                <button onClick={() => scan(tickersRef.current)} disabled={scanning}
                  style={{ padding: '10px 16px', background: 'transparent', color: C.txMid, border: `0.5px solid ${C.borderDk}`, fontSize: 12, fontFamily: SANS }}>
                  Refresh
                </button>
              )}
              {results.length > 0 && (
                <button onClick={() => { setResults([]); tickersRef.current = []; setUpdatedAt(''); }}
                  style={{ padding: '10px 16px', background: 'transparent', color: C.txMid, border: `0.5px solid ${C.borderDk}`, fontSize: 12, fontFamily: SANS }}>
                  Clear
                </button>
              )}
            </div>
 
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 9, color: C.txLight, fontFamily: SANS, letterSpacing: '0.12em', textTransform: 'uppercase', marginRight: 4 }}>Sectors</span>
              {Object.keys(PRESETS).map(name => (
                <button key={name} onClick={() => { setInput(PRESETS[name]); setActivePreset(name); }}
                  style={{
                    padding: '4px 12px', fontSize: 10, fontFamily: SANS, letterSpacing: '0.06em',
                    background: activePreset === name ? C.darkBg : 'transparent',
                    color: activePreset === name ? '#F1EFE8' : C.txMid,
                    border: `0.5px solid ${activePreset === name ? C.darkBg : C.borderDk}`,
                    borderRadius: 0, whiteSpace: 'nowrap',
                  }}>
                  {name}
                </button>
              ))}
            </div>
          </div>
 
          {/* Filters */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
            <span style={{ fontSize: 9, color: C.txLight, fontFamily: SANS, letterSpacing: '0.12em', textTransform: 'uppercase', marginRight: 4 }}>Filter</span>
            {[['all', 'All'], ['strong', 'Strong 5–6'], ['mod', 'Moderate 3–4'], ['weak', 'Weak 0–2'], ['us', 'US'], ['intl', 'International']].map(([k, l]) => (
              <button key={k} onClick={() => setFilter(k)}
                style={{
                  padding: '4px 12px', fontSize: 10, fontFamily: SANS, letterSpacing: '0.06em',
                  background: filter === k ? C.accentDk : 'transparent',
                  color: filter === k ? '#F1EFE8' : C.txMid,
                  border: `0.5px solid ${filter === k ? C.accentDk : C.borderDk}`, borderRadius: 0,
                }}>
                {l}
              </button>
            ))}
          </div>
 
          {/* Scanning indicator */}
          {scanning && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: C.txMid, fontFamily: MONO, marginBottom: 12 }}>
              <div style={{ width: 11, height: 11, border: `1.5px solid ${C.border}`, borderTopColor: C.gold, borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              {status}
            </div>
          )}
          {!scanning && status && (
            <div style={{ fontSize: 11, color: C.red, fontFamily: MONO, marginBottom: 12 }}>{status}</div>
          )}
 
          {/* Results */}
          {filtered.length === 0 && !scanning ? (
            <div style={{ textAlign: 'center', padding: '48px 16px', color: C.txLight, fontFamily: FONTS, fontSize: 18, fontStyle: 'italic', fontWeight: 300 }}>
              {results.length > 0
                ? 'No results match this filter.'
                : 'Select a sector or enter tickers above to begin scanning.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {filtered.map((stock, i) => (
                <ResultCard key={stock.ticker} stock={stock} rank={i + 1} />
              ))}
            </div>
          )}
 
          {/* Export */}
          {results.length > 0 && (
            <div style={{ display: 'flex', gap: 8, marginTop: 24, paddingTop: 20, borderTop: `0.5px solid ${C.borderDk}`, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: C.txLight, fontFamily: MONO, flex: 1, letterSpacing: '0.06em' }}>
                {filtered.length} securities ready to export
              </span>
              <button onClick={exportCSV}
                style={{ padding: '8px 18px', background: 'transparent', color: C.txMid, border: `0.5px solid ${C.borderDk}`, fontSize: 11, fontFamily: SANS, letterSpacing: '0.06em' }}>
                Export CSV
              </button>
              <button onClick={() => {
                const out = filtered.map((r, i) => ({ rank: i + 1, ...r }));
                const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
                const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
                a.download = `signals_${new Date().toISOString().slice(0, 10)}.json`; a.click();
              }} style={{ padding: '8px 18px', background: 'transparent', color: C.txMid, border: `0.5px solid ${C.borderDk}`, fontSize: 11, fontFamily: SANS, letterSpacing: '0.06em' }}>
                Export JSON
              </button>
            </div>
          )}
 
        </div>
      </div>
    </>
  );
}
 
