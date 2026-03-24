// pages/api/top3.js

const TICKERS = [
  'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','AVGO','ORCL','ADBE',
  'CRM','AMD','QCOM','TXN','INTC','MU','AMAT','KLAC','LRCX','MCHP',
  'ADI','NXPI','CDNS','SNPS','FTNT','PANW','CRWD','NOW','SNOW','PLTR',
  'JPM','BAC','WFC','GS','MS','BLK','C','AXP','SCHW','USB',
  'PNC','TFC','COF','MET','PRU','AFL','ALL','TRV','AIG','MCO',
  'SPGI','ICE','CME','MSCI','CBOE',
  'LLY','JNJ','UNH','ABBV','MRK','PFE','TMO','ABT','AMGN','CVS',
  'MDT','ISRG','GILD','REGN','VRTX','BSX','SYK','EW','DXCM','IDXX',
  'IQV','MCK','ELV','CI','HUM','HCA',
  'HD','MCD','NKE','SBUX','LOW','TGT','COST','BKNG','MAR','HLT',
  'YUM','CMG','DPZ','ROST','TJX','GM','F','UBER',
  'WMT','KO','PEP','PG','PM','MO','MDLZ','CL','KMB','GIS','STZ',
  'XOM','CVX','COP','EOG','SLB','OXY','DVN','HAL','MPC','PSX','VLO','BKR',
  'GE','HON','CAT','DE','BA','LMT','RTX','NOC','GD','UPS',
  'FDX','MMM','EMR','ETN','PH','ITW','ROK','NSC','UNP','CSX',
  'LIN','APD','SHW','ECL','NEM','FCX','NUE','VMC','MLM','DOW',
  'NEE','DUK','SO','D','AEP','EXC','SRE','CEG',
  'PLD','AMT','EQIX','CCI','PSA','O','WELL','AVB','DLR',
  'NFLX','DIS','CMCSA','T','VZ','TMUS','CHTR',
  'V','MA','PYPL','ACN','IBM','FICO','ROP','VRSK',
  'DHR','SPGI','ZTS','IDXX','MTD','BIO','A','ILMN',
  'NKE','LULU','PVH','HBI','RL','TPR','VFC',
  'ABNB','EXPE','LYFT','UAL','DAL','AAL','LUV','CCL','RCL','NCLH',
];

const UNIQ_TICKERS = [...new Set(TICKERS)].filter(t => t && t.length <= 5);

// ✅ SAFE FETCH (fixes AbortSignal issues on Vercel)
async function safeFetch(url, options = {}, timeout = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

async function yahooQuoteBatch(tickers) {
  const fields = 'symbol,shortName,regularMarketPrice,regularMarketChangePercent,marketCap,trailingPE,fiftyDayAverage,fiftyTwoWeekHigh,fiftyTwoWeekLow,epsTrailingTwelveMonths,averageAnalystRating';

  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickers.join(',')}&fields=${fields}`;

  const res = await safeFetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json',
      'Referer': 'https://finance.yahoo.com',
    }
  });

  if (!res.ok) throw new Error('Yahoo ' + res.status);

  const json = await res.json();
  return json?.quoteResponse?.result || [];
}

function scoreQuote(q) {
  if (!q?.symbol) return null;

  const px = q.regularMarketPrice;
  const pe = q.trailingPE;
  const ma50 = q.fiftyDayAverage;
  const hi = q.fiftyTwoWeekHigh;
  const lo = q.fiftyTwoWeekLow;
  const eps = q.epsTrailingTwelveMonths;

  if (!px || px <= 0) return null;

  let score = 0;

  if (pe && pe > 0 && pe < 200 && eps && eps > 0 && hi && lo) {
    const histPE = ((hi + lo) / 2) / eps;
    if (pe < histPE * 0.92) score++;
  }

  if (ma50 && px <= ma50) score++;
  if (pe && pe > 0 && pe < 25) score++;

  if (hi && lo) {
    const mid = (hi + lo) / 2;
    if (px < mid) score++;
  }

  return {
    ticker: q.symbol,
    company: q.shortName || q.symbol,
    score,
    px,
    pe,
    ma50,
    chg: q.regularMarketChangePercent,
    mc: q.marketCap,
    hi52: hi,
    lo52: lo,
    eps,
    analystRating: q.averageAnalystRating || null,
  };
}

async function getTargetPrice(ticker) {
  try {
    const res = await safeFetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData`);
    if (!res.ok) return null;

    const j = await res.json();
    const fd = j?.quoteSummary?.result?.[0]?.financialData;

    return fd?.targetMedianPrice?.raw || fd?.targetMeanPrice?.raw || null;
  } catch {
    return null;
  }
}

async function buildFullResult(q) {
  const ticker = q.ticker;
  const px = q.px;

  const tgt = await getTargetPrice(ticker);

  return {
    ticker,
    company: q.company,
    price: `$${px.toFixed(2)}`,
    pe: q.pe,
    score: q.score,
    target: tgt,
    upside: tgt ? ((tgt - px) / px * 100).toFixed(1) + '%' : null,
    updatedAt: new Date().toISOString()
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const batchSize = 80;
    const batches = [];

    for (let i = 0; i < UNIQ_TICKERS.length; i += batchSize) {
      batches.push(UNIQ_TICKERS.slice(i, i + batchSize));
    }

    const batchResults = await Promise.allSettled(batches.map(yahooQuoteBatch));

    let allQuotes = [];
    batchResults.forEach(r => {
      if (r.status === 'fulfilled') {
        allQuotes = allQuotes.concat(r.value);
      }
    });

    if (!allQuotes.length) {
      return res.status(200).json({ top3: [], error: 'No data' });
    }

    const scored = allQuotes
      .map(scoreQuote)
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    const top3 = await Promise.all(
      scored.slice(0, 3).map(buildFullResult)
    );

    return res.status(200).json({
      top3,
      totalScanned: scored.length,
      updatedAt: new Date().toISOString()
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
