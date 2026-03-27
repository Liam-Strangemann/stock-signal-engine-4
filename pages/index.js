import { useState, useEffect, useRef, useCallback } from 'react';
import Head from 'next/head';
 
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
 
const SIG_LABELS = ['EPS & Rev beat', 'PE vs hist avg', 'Price vs 50d MA', 'Insider buying', 'Analyst upside', 'PE vs peers'];
 
const US_SET = new Set('AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,JPM,XOM,UNH,LLY,AVGO,ORCL,AMD,INTC,QCOM,TXN,AMAT,MU,ADBE,BAC,WFC,GS,MS,BLK,C,AXP,SCHW,USB,PNC,TFC,JNJ,ABBV,MRK,PFE,TMO,ABT,AMGN,CVS,MDT,ISRG,COP,EOG,SLB,MPC,PSX,VLO,OXY,DVN,HAL,BKR,CVX,HD,MCD,NKE,SBUX,LOW,TGT,COST,WMT,T,VZ,MO,PM,KO,PEP,MMM,IBM,CAT,DE,GE,HON,RTX,LMT,NOW,CRM,PANW,INTU,CSCO,MA,V,BKNG,CME,SPGI'.split(','));
 
// ── Colour system ─────────────────────────────────────────────────────────────
const C = {
  // Page & card surfaces (warm cream/taupe)
  pageBg:    '#F1EFE8',
  cardBg:    '#E8E5DC',
  insetBg:   '#E0DDD4',
  // Feature card = same dark as header
  featureBg: '#3A3832',
  featureBd: '#4A4840',
  headerBg:  '#3A3832',
  // Accent gold
  gold:      '#B8A070',
  goldDk:    '#8A7448',
  goldLt:    '#D4BC8C',
  // Borders
  border:    'rgba(90,85,75,0.14)',
  borderMd:  'rgba(90,85,75,0.26)',
  borderDk:  'rgba(90,85,75,0.40)',
  // Text
  tx:        '#2C2A24',
  txMid:     '#5C5848',
  txLight:   '#9A9280',
  // Feature card text
  ftx:       '#F1EFE8',
  ftxMid:    '#B8B0A0',
  ftxLight:  '#7A7268',
  // Signal — olive green pass
  green:     '#45602C',
  greenBg:   '#DAE8C8',
  greenBd:   '#92B470',
  greenTx:   '#2E4018',
  // Signal — terracotta fail
  red:       '#7A3A28',
  redBg:     '#EDD8CC',
  redBd:     '#C09080',
  redTx:     '#5E2A1C',
  // Signal — amber neutral
  amber:     '#856420',
  amberBg:   '#EEE0B8',
  amberBd:   '#C4A048',
  amberTx:   '#624A18',
};
 
// Feature card signal pills are darker (on dark bg)
const FC = {
  greenBg:  'rgba(90,140,60,0.18)',
  greenBd:  'rgba(130,180,80,0.35)',
  greenTx:  '#A8D080',
  redBg:    'rgba(160,70,50,0.18)',
  redBd:    'rgba(200,110,90,0.35)',
  redTx:    '#D09080',
  amberBg:  'rgba(160,130,40,0.18)',
  amberBd:  'rgba(200,170,70,0.35)',
  amberTx:  '#C8AA60',
};
 
const FONTS = "'Cormorant Garamond', 'Georgia', serif";
const SANS  = "'DM Sans', 'Helvetica Neue', sans-serif";
const MONO  = "'DM Mono', 'Courier New', monospace";
 
function getRating(score) {
  if (score >= 5) return { label: 'Strong Buy', color: C.greenTx, bg: C.greenBg, border: C.greenBd };
  if (score === 4) return { label: 'Buy',        color: '#3A5824', bg: '#E0ECCC', border: '#9EC078' };
  if (score === 3) return { label: 'Watch',      color: C.amberTx, bg: C.amberBg, border: C.amberBd };
  return                  { label: 'Ignore',     color: C.txLight,  bg: C.insetBg, border: C.borderMd };
}
 
function ScoreDots({ score, max = 6, dark = false }) {
  const color = score >= 5 ? C.gold : score >= 4 ? (dark ? '#7AB060' : C.green) : score >= 3 ? (dark ? C.gold : C.amber) : (dark ? C.ftxLight : C.borderDk);
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      {Array.from({ length: max }).map((_, i) => (
        <div key={i} style={{
          width: 7, height: 7, borderRadius: '50%',
          background: i < score ? color : 'transparent',
          border: `1.5px solid ${i < score ? color : (dark ? 'rgba(184,160,112,0.25)' : C.borderDk)}`,
          transition: 'all 0.3s ease',
        }} />
      ))}
    </div>
  );
}
 
// Signal pill — two variants: light (custom scan) and dark (feature card)
function SigPill({ sig, label, dark = false }) {
  const isPas  = sig.status === 'pass';
  const isFail = sig.status === 'fail';
  const bg    = dark ? (isPas ? FC.greenBg  : isFail ? FC.redBg    : FC.amberBg)
                     : (isPas ? C.greenBg   : isFail ? C.redBg     : C.amberBg);
  const color = dark ? (isPas ? FC.greenTx  : isFail ? FC.redTx    : FC.amberTx)
                     : (isPas ? C.greenTx   : isFail ? C.redTx     : C.amberTx);
  const bd    = dark ? (isPas ? FC.greenBd  : isFail ? FC.redBd    : FC.amberBd)
                     : (isPas ? C.greenBd   : isFail ? C.redBd     : C.amberBd);
  const dotC  = dark ? color : (isPas ? C.green : isFail ? C.red : C.amber);
 
  return (
    <div style={{ background: bg, border: `0.5px solid ${bd}`, borderRadius: 4, padding: '5px 7px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
        <div style={{ width: 4, height: 4, borderRadius: '50%', background: dotC, flexShrink: 0 }} />
        <div style={{ fontSize: 7.5, color: dark ? C.ftxLight : C.txLight, fontFamily: SANS, textTransform: 'uppercase', letterSpacing: '0.06em', lineHeight: 1 }}>
          {label}
        </div>
      </div>
      <div style={{ fontSize: 10, fontWeight: 500, color, fontFamily: MONO, lineHeight: 1.3, wordBreak: 'break-word' }}>
        {sig.value || '--'}
      </div>
    </div>
  );
}
 
// ── Skeleton for feature card (dark, same bg as loaded card) ─────────────────
function SkeletonCard({ rank }) {
  const medals = ['I', 'II', 'III'];
  const pulse = { animation: 'shimmer 1.8s ease-in-out infinite' };
  return (
    <div style={{
      background: C.featureBg,
      border: `1px solid ${C.featureBd}`,
      borderTop: `3px solid rgba(184,160,112,0.4)`,
      borderRadius: 2, padding: '24px 22px', flex: 1, minWidth: 0,
    }}>
      <div style={{ fontSize: 9, color: 'rgba(184,160,112,0.5)', fontFamily: SANS, letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: 10 }}>
        Rank {medals[rank - 1]}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div>
          <div style={{ ...pulse, width: 80, height: 28, background: 'rgba(255,255,255,0.07)', borderRadius: 2, marginBottom: 8 }} />
          <div style={{ ...pulse, width: 150, height: 11, background: 'rgba(255,255,255,0.04)', borderRadius: 2 }} />
        </div>
        <div style={{ ...pulse, width: 52, height: 28, background: 'rgba(255,255,255,0.05)', borderRadius: 2 }} />
      </div>
      <div style={{ ...pulse, width: 110, height: 11, background: 'rgba(255,255,255,0.04)', borderRadius: 2, marginBottom: 16 }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 5, marginBottom: 14 }}>
        {[0,1,2,3,4,5].map(i => (
          <div key={i} style={{ ...pulse, height: 52, background: 'rgba(255,255,255,0.04)', borderRadius: 4, animationDelay: `${i * 0.1}s` }} />
        ))}
      </div>
      <div style={{ ...pulse, height: 38, background: 'rgba(255,255,255,0.03)', borderRadius: 2 }} />
    </div>
  );
}
 
// ── Feature card — dark bg matching header ────────────────────────────────────
function FeatureCard({ stock, rank }) {
  if (!stock) return <SkeletonCard rank={rank} />;
 
  const sc = Math.min(stock.score || 0, 6);
  const chgPos = stock.change && stock.change.startsWith('+');
  const medals = ['I', 'II', 'III'];
  // Score colour: gold for 5+, muted green for 4, amber for 3, grey for ≤2
  const scoreColor = sc >= 5 ? C.gold : sc >= 4 ? '#8CC870' : sc >= 3 ? '#C8AA60' : C.ftxLight;
 
  return (
    <div style={{
      background: C.featureBg,
      border: `1px solid ${C.featureBd}`,
      borderTop: `3px solid ${C.gold}`,
      borderRadius: 2, padding: '24px 22px',
      flex: 1, minWidth: 0, position: 'relative',
      animation: 'fadeUp 0.4s ease both',
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 9, color: 'rgba(184,160,112,0.7)', fontFamily: SANS, letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: 7 }}>
            Rank {medals[rank - 1]}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 26, fontWeight: 700, fontFamily: FONTS, color: C.ftx, letterSpacing: '0.02em' }}>
              {stock.ticker}
            </span>
            <span style={{
              fontSize: 8.5, fontFamily: SANS, padding: '2px 6px', borderRadius: 2,
              letterSpacing: '0.08em', background: 'rgba(184,160,112,0.12)',
              color: C.goldLt, border: `0.5px solid rgba(184,160,112,0.3)`,
            }}>
              {stock.exchange || 'NYSE'}
            </span>
          </div>
          <div style={{ fontSize: 11, color: C.ftxMid, fontFamily: SANS }}>{stock.company || ''}</div>
        </div>
 
        {/* Score — DM Mono for equal-width digits */}
        <div style={{ textAlign: 'right' }}>
          <div style={{
            fontSize: 28, fontWeight: 400, fontFamily: MONO,
            color: scoreColor, lineHeight: 1, letterSpacing: '0.02em',
          }}>
            {sc}<span style={{ color: C.ftxLight }}>/6</span>
          </div>
          <div style={{ marginTop: 7, display: 'flex', justifyContent: 'flex-end' }}>
            <ScoreDots score={sc} dark />
          </div>
        </div>
      </div>
 
      {/* Price row */}
      <div style={{ marginBottom: 16, paddingBottom: 14, borderBottom: `0.5px solid rgba(255,255,255,0.07)` }}>
        <span style={{ fontSize: 19, fontFamily: MONO, fontWeight: 400, color: C.ftx }}>{stock.price || '--'}</span>
        {stock.change && (
          <span style={{ fontSize: 12, marginLeft: 8, color: chgPos ? '#7EC870' : '#D08070', fontFamily: MONO }}>
            {stock.change}
          </span>
        )}
        {stock.marketCap && (
          <span style={{ fontSize: 11, marginLeft: 8, color: C.ftxLight, fontFamily: SANS }}>
            {stock.marketCap}
          </span>
        )}
      </div>
 
      {/* 6 signal pills in 3×2 grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 5, marginBottom: 14 }}>
        {SIG_LABELS.map((label, i) => {
          const sig = (stock.signals || [])[i] || {};
          return <SigPill key={i} sig={{ status: sig.status, value: sig.value }} label={label} dark />;
        })}
      </div>
 
      {/* Summary */}
      <div style={{ padding: '10px 12px', background: 'rgba(0,0,0,0.15)', borderRadius: 2, border: `0.5px solid rgba(255,255,255,0.06)` }}>
        <span style={{ fontSize: 11, color: C.ftxMid, fontFamily: SANS, lineHeight: 1.6 }}>
          {stock.summary || ''}
        </span>
      </div>
 
      {/* Timestamp */}
      <div style={{ position: 'absolute', top: 14, right: 18, fontSize: 9, color: C.ftxLight, fontFamily: MONO }}>
        {stock.updatedAt ? new Date(stock.updatedAt).toLocaleTimeString() : ''}
      </div>
    </div>
  );
}
 
// ── Compact result card for custom scan ───────────────────────────────────────
function ResultCard({ stock, rank }) {
  const sc = Math.min(stock.score || 0, 6);
  const rating = getRating(sc);
  const chgPos = stock.change && stock.change.startsWith('+');
  const scoreColor = sc >= 5 ? C.goldDk : sc >= 4 ? C.green : sc >= 3 ? C.amber : C.txLight;
  const accentL = sc >= 5 ? C.gold : sc >= 4 ? C.greenBd : sc >= 3 ? C.amberBd : C.borderMd;
  const rnk = rank === 1 ? { bg: C.gold, color: '#2C2A24' }
            : rank === 2 ? { bg: C.headerBg, color: C.goldLt }
            : rank === 3 ? { bg: '#5C5848', color: '#F1EFE8' }
            :               { bg: C.border, color: C.txMid };
 
  return (
    <div style={{
      background: C.cardBg, borderRadius: 2,
      border: `0.5px solid ${C.borderMd}`,
      borderLeft: `3px solid ${accentL}`,
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
              <span style={{ fontSize: 8, fontFamily: SANS, padding: '2px 5px', borderRadius: 2, letterSpacing: '0.06em', background: C.headerBg, color: C.goldLt }}>
                {stock.exchange || (US_SET.has(stock.ticker) ? 'NYSE' : 'INTL')}
              </span>
              <span style={{
                fontSize: 9, fontFamily: SANS, fontWeight: 500, padding: '2px 8px', borderRadius: 20,
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
                {stock.marketCap && <span style={{ marginLeft: 6, color: C.txLight }}>{stock.marketCap}</span>}
              </div>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 7 }}>
          {/* DM Mono score — equal-width digits */}
          <div style={{ fontSize: 22, fontWeight: 400, fontFamily: MONO, color: scoreColor, lineHeight: 1 }}>
            {sc}<span style={{ color: C.txLight }}>/6</span>
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
        <div style={{ fontSize: 11, color: C.txMid, borderTop: `0.5px solid ${C.border}`, paddingTop: 8, lineHeight: 1.6, fontFamily: SANS }}>
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
 
// ── Main page ─────────────────────────────────────────────────────────────────
export default function Home() {
  const [input, setInput]               = useState('');
  const [results, setResults]           = useState([]);
  const [scanning, setScanning]         = useState(false);
  const [status, setStatus]             = useState('');
  const [filter, setFilter]             = useState('all');
  const [updatedAt, setUpdatedAt]       = useState('');
  const [activePreset, setActivePreset] = useState('');
 
  // Top picks state — 3 slots, start as null (shows skeletons immediately)
  const [topPicks, setTopPicks]         = useState([null, null, null]);
  const [topScanned, setTopScanned]     = useState(0);
  const [topDone, setTopDone]           = useState(false);
  const [topTotal, setTopTotal]         = useState(180);
 
  const timerRef   = useRef(null);
  const tickersRef = useRef([]);
 
  // ── Top picks flow:
  // 1. GET /api/top3 → get ~180-stock Yahoo scan → returns top 8 candidates
  // 2. POST /api/analyse with those 8 → get full signal data
  // 3. Sort by score, fill top 3 slots
  // Skeletons show immediately; cards fill in as data arrives (~8-12s total)
  useEffect(() => {
    let cancelled = false;
 
    async function loadTopPicks() {
      try {
        // Step 1: get candidates from Yahoo broad scan
        const scanRes = await fetch('/api/top3');
        if (!scanRes.ok || cancelled) return;
        const scanData = await scanRes.json();
        const candidates = scanData.candidates || [];
        if (scanData.totalScanned) setTopTotal(scanData.totalScanned);
        if (!candidates.length || cancelled) return;
 
        setTopScanned(candidates.length); // show progress
 
        // Step 2: full signal analysis on candidates
        const analyseRes = await fetch('/api/analyse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tickers: candidates }),
        });
        if (!analyseRes.ok || cancelled) return;
        const analyseData = await analyseRes.json();
 
        if (cancelled) return;
 
        const stocks = Object.values(analyseData.results || {})
          .filter(s => s && !s.error && s.score != null)
          .sort((a, b) => (b.score || 0) - (a.score || 0));
 
        setTopPicks([stocks[0] || null, stocks[1] || null, stocks[2] || null]);
        setTopDone(true);
      } catch (_) {
        // Silent fail — skeletons remain, not a hard error
      }
    }
 
    loadTopPicks();
    return () => { cancelled = true; };
  }, []);
 
  // ── Custom scan ─────────────────────────────────────────────────────────────
  const scan = useCallback(async (tickers) => {
    setScanning(true);
    setStatus(`Analysing ${tickers.length} securities…`);
    try {
      const res = await fetch('/api/analyse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || `HTTP ${res.status}`); }
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
 
  const topStatusText = topDone
    ? `${topTotal} securities screened`
    : topScanned > 0
      ? `Analysing top candidates…`
      : 'Scanning watchlist…';
 
  return (
    <>
      <Head>
        <title>Signal Engine</title>
        <meta name="description" content="Institutional-grade equity value scanner" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,300&family=DM+Sans:wght@300;400;500&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet" />
        <style>{`
          * { box-sizing: border-box; margin: 0; padding: 0; }
          html { -webkit-font-smoothing: antialiased; }
          body { background: ${C.pageBg}; }
          ::selection { background: ${C.gold}; color: #2C2A24; }
          input::placeholder { color: ${C.txLight}; }
          input:focus { outline: none; }
          button { cursor: pointer; transition: opacity 0.14s; }
          button:not(:disabled):hover { opacity: 0.75; }
          button:disabled { opacity: 0.38; cursor: not-allowed; }
          @keyframes fadeUp {
            from { opacity: 0; transform: translateY(8px); }
            to   { opacity: 1; transform: translateY(0); }
          }
          @keyframes shimmer {
            0%, 100% { opacity: 0.5; }
            50%       { opacity: 0.85; }
          }
          @keyframes spin { to { transform: rotate(360deg); } }
        `}</style>
      </Head>
 
      <div style={{ background: C.pageBg, minHeight: '100vh', color: C.tx, fontFamily: SANS }}>
 
        {/* ── Header ── */}
        <div style={{ background: C.headerBg, borderBottom: `1px solid rgba(184,160,112,0.18)`, padding: '0 32px' }}>
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
            <div style={{ textAlign: 'right', fontSize: 10, fontFamily: MONO, lineHeight: 1.8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: scanning ? C.gold : results.length ? '#7AB068' : 'rgba(184,160,112,0.35)' }} />
                <span style={{ color: '#F1EFE8' }}>{scanning ? 'Scanning…' : results.length ? 'Live' : 'Ready'}</span>
              </div>
              {updatedAt && <div style={{ color: 'rgba(241,239,232,0.4)' }}>Updated {updatedAt}</div>}
            </div>
          </div>
        </div>
 
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '36px 32px 80px' }}>
 
          {/* ── Top Picks ── */}
          <div style={{ marginBottom: 44 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 22 }}>
              <h2 style={{ fontSize: 38, fontFamily: FONTS, fontWeight: 600, color: C.tx, letterSpacing: '0.01em' }}>
                Top Picks Today
              </h2>
              <div style={{ height: '0.5px', flex: 1, background: C.borderDk }} />
              <div style={{ fontSize: 9.5, color: C.txLight, fontFamily: SANS, letterSpacing: '0.12em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                {topStatusText}
              </div>
            </div>
 
            {/* 3 cards — skeleton or data, no layout shift */}
            <div style={{ display: 'flex', gap: 16 }}>
              {[0, 1, 2].map(i => (
                <div key={i} style={{ flex: 1, minWidth: 0 }}>
                  <FeatureCard stock={topPicks[i]} rank={i + 1} />
                </div>
              ))}
            </div>
          </div>
 
          {/* ── Custom Scan ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 28 }}>
            <h2 style={{ fontSize: 38, fontFamily: FONTS, fontWeight: 600, color: C.tx, letterSpacing: '0.01em', whiteSpace: 'nowrap' }}>
              Custom Scan
            </h2>
            <div style={{ height: '0.5px', flex: 1, background: C.borderDk }} />
          </div>
 
          <div style={{ background: C.cardBg, border: `0.5px solid ${C.borderDk}`, padding: '20px', marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
              <input
                type="text" value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && runScan()}
                placeholder="Enter ticker symbols: AAPL, MSFT, NVDA, TSM…"
                style={{ flex: 1, background: C.pageBg, border: `0.5px solid ${C.borderDk}`, padding: '10px 14px', fontSize: 13, fontFamily: MONO, color: C.tx, borderRadius: 0 }}
              />
              <button onClick={runScan} disabled={scanning} style={{ padding: '10px 26px', background: C.headerBg, color: '#F1EFE8', border: 'none', fontSize: 12, fontFamily: SANS, fontWeight: 500, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                {scanning ? 'Scanning…' : 'Scan'}
              </button>
              {results.length > 0 && (
                <button onClick={() => scan(tickersRef.current)} disabled={scanning} style={{ padding: '10px 16px', background: 'transparent', color: C.txMid, border: `0.5px solid ${C.borderDk}`, fontSize: 12, fontFamily: SANS }}>
                  Refresh
                </button>
              )}
              {results.length > 0 && (
                <button onClick={() => { setResults([]); tickersRef.current = []; setUpdatedAt(''); }} style={{ padding: '10px 16px', background: 'transparent', color: C.txMid, border: `0.5px solid ${C.borderDk}`, fontSize: 12, fontFamily: SANS }}>
                  Clear
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 9, color: C.txLight, fontFamily: SANS, letterSpacing: '0.14em', textTransform: 'uppercase', marginRight: 4 }}>Sectors</span>
              {Object.keys(PRESETS).map(name => {
                const active = activePreset === name;
                return (
                  <button key={name} onClick={() => { setInput(PRESETS[name]); setActivePreset(name); }} style={{
                    padding: '4px 12px', fontSize: 10, fontFamily: SANS, letterSpacing: '0.06em',
                    background: active ? C.headerBg : 'transparent',
                    color: active ? '#F1EFE8' : C.txMid,
                    border: `0.5px solid ${active ? C.headerBg : C.borderDk}`,
                    borderRadius: 0, whiteSpace: 'nowrap',
                  }}>
                    {name}
                  </button>
                );
              })}
            </div>
          </div>
 
          {/* Filters */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
            <span style={{ fontSize: 9, color: C.txLight, fontFamily: SANS, letterSpacing: '0.14em', textTransform: 'uppercase', marginRight: 4 }}>Filter</span>
            {[['all','All'],['strong','Strong 5–6'],['mod','Moderate 3–4'],['weak','Weak 0–2'],['us','US'],['intl','International']].map(([k, l]) => {
              const active = filter === k;
              return (
                <button key={k} onClick={() => setFilter(k)} style={{
                  padding: '4px 12px', fontSize: 10, fontFamily: SANS, letterSpacing: '0.06em',
                  background: active ? C.headerBg : 'transparent',
                  color: active ? '#F1EFE8' : C.txMid,
                  border: `0.5px solid ${active ? C.headerBg : C.borderDk}`,
                  borderRadius: 0,
                }}>
                  {l}
                </button>
              );
            })}
          </div>
 
          {/* Status */}
          {scanning && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: C.txMid, fontFamily: MONO, marginBottom: 12 }}>
              <div style={{ width: 11, height: 11, border: `1.5px solid ${C.borderMd}`, borderTopColor: C.goldDk, borderRadius: '50%', animation: 'spin 0.7s linear infinite', flexShrink: 0 }} />
              {status}
            </div>
          )}
          {!scanning && status && (
            <div style={{ fontSize: 11, color: C.red, fontFamily: MONO, marginBottom: 12 }}>{status}</div>
          )}
 
          {/* Results */}
          {filtered.length === 0 && !scanning ? (
            <div style={{ textAlign: 'center', padding: '52px 16px', color: C.txLight, fontFamily: FONTS, fontSize: 20, fontStyle: 'italic', fontWeight: 300 }}>
              {results.length > 0 ? 'No results match this filter.' : 'Select a sector or enter tickers above to begin scanning.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {filtered.map((stock, i) => <ResultCard key={stock.ticker} stock={stock} rank={i + 1} />)}
            </div>
          )}
 
          {/* Export */}
          {results.length > 0 && (
            <div style={{ display: 'flex', gap: 8, marginTop: 24, paddingTop: 20, borderTop: `0.5px solid ${C.borderDk}`, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: C.txLight, fontFamily: MONO, flex: 1, letterSpacing: '0.06em' }}>
                {filtered.length} securities ready to export
              </span>
              <button onClick={() => {
                const hdr = ['Rank','Ticker','Company','Score','Price','Change','MktCap','EPS','PE_hist','vs50dMA','Insider','Analyst','PE_peers','Summary'];
                const rows = filtered.map((r,i) => { const g=r.signals||[]; return [i+1,r.ticker,`"${(r.company||'').replace(/"/g,'""')}"`,r.score||0,r.price||'',r.change||'',r.marketCap||'',g[0]?.value||'',g[1]?.value||'',g[2]?.value||'',g[3]?.value||'',g[4]?.value||'',g[5]?.value||'',`"${(r.summary||'').replace(/"/g,'""')}"`].join(','); });
                const blob=new Blob([[hdr.join(',')].concat(rows).join('\n')],{type:'text/csv'});
                const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`signals_${new Date().toISOString().slice(0,10)}.csv`;a.click();
              }} style={{ padding: '8px 18px', background: 'transparent', color: C.txMid, border: `0.5px solid ${C.borderDk}`, fontSize: 11, fontFamily: SANS, letterSpacing: '0.06em' }}>
                Export CSV
              </button>
              <button onClick={() => {
                const blob=new Blob([JSON.stringify(filtered.map((r,i)=>({rank:i+1,...r})),null,2)],{type:'application/json'});
                const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`signals_${new Date().toISOString().slice(0,10)}.json`;a.click();
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
 
