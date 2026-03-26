// pages/api/top3.js
//
// This endpoint does ONE thing: return cached results instantly.
// It never does any heavy work itself.
//
// On first load (empty cache): kicks off a background refresh and returns
// a "computing" response so the UI can poll.
// On subsequent loads: returns cached data immediately (<50ms).
//
// The heavy scanning work lives in /api/top3-refresh.
// Vercel calls that endpoint via an internal fetch — it runs in its own
// function invocation with its own 10s timeout, separate from this one.
 
// Shared in-memory cache (persists across warm Lambda instances)
// We export it so top3-refresh.js can write to it
export const sharedCache = {
  data:      null,
  timestamp: 0,
  computing: false,
};
 
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
 
export default async function handler(req, res) {
  const now = Date.now();
  const cacheAge = now - sharedCache.timestamp;
  const cacheValid = sharedCache.data && cacheAge < CACHE_TTL;
 
  // Cache hit — return instantly
  if (cacheValid) {
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
    return res.status(200).json(sharedCache.data);
  }
 
  // Cache miss — trigger background refresh if not already running
  if (!sharedCache.computing) {
    sharedCache.computing = true;
    // Fire-and-forget: don't await this
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000';
    fetch(`${baseUrl}/api/top3-refresh`, {
      method: 'POST',
      headers: { 'x-internal-token': process.env.INTERNAL_TOKEN || 'signal-engine' },
    }).catch(() => { sharedCache.computing = false; });
  }
 
  // Return stale data if we have it, otherwise return computing status
  if (sharedCache.data) {
    res.setHeader('X-Cache', 'STALE');
    return res.status(200).json({ ...sharedCache.data, stale: true });
  }
 
  return res.status(200).json({ computing: true, top3: [], totalScanned: 0 });
}
 
