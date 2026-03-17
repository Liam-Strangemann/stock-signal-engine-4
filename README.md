# Stock Signal Engine

5-factor undervalue stock scanner — live data from Finnhub, deployed on Vercel.

---

## How to deploy (no coding knowledge needed — takes ~10 minutes)

### Step 1 — Get a free Finnhub API key

1. Go to https://finnhub.io
2. Click **Get free API key** — sign up with your email (no credit card)
3. Verify your email, then copy the API key from the dashboard
4. Keep it handy — you'll need it in Step 3

---

### Step 2 — Put the code on GitHub

1. Go to https://github.com and sign up for a free account (if you don't have one)
2. Click the **+** button top-right → **New repository**
3. Name it `stock-signal-engine`, leave everything else default, click **Create repository**
4. On the next page, click **uploading an existing file**
5. Drag and drop ALL the files from this folder into the upload area
   - Make sure to upload the folder structure: `pages/`, `styles/`, etc.
   - The easiest way: zip this whole folder, then use GitHub's upload
6. Click **Commit changes**

---

### Step 3 — Deploy on Vercel (free)

1. Go to https://vercel.com and sign up with your GitHub account
2. Click **Add New Project**
3. Find and select your `stock-signal-engine` repository, click **Import**
4. On the configuration screen, click **Environment Variables**
5. Add one variable:
   - **Name:** `FINNHUB_KEY`
   - **Value:** paste your Finnhub API key from Step 1
6. Click **Deploy**
7. Wait ~2 minutes — Vercel builds and deploys your app
8. You'll get a live URL like `stock-signal-engine-xxx.vercel.app` — that's your app!

---

## How to use the app

- Open your Vercel URL in any browser
- Click a preset (Mega-cap, Tech, Finance, etc.) or type any ticker symbols
- Click **▶ Scan** — results load in seconds
- Cards are ranked by score (0–5 signals met) with a colour-coded bar
- Use the filter bar to show only strong/moderate/weak signals
- Click **Export CSV** or **Export JSON** to download results
- The app auto-refreshes data every 5 minutes

---

## The 5 signals explained

| Signal | Pass condition |
|---|---|
| EPS & Revenue beat | Company beat analyst EPS estimates in most recent quarter |
| PE vs historical avg | Current P/E ratio is below the stock's historical average (52wk midpoint proxy) |
| Price vs 50-day MA | Current price is at or below the 50-day moving average |
| Insider buying | Net insider purchases in the last 30 days |
| Analyst +25% upside | Median analyst 12-month price target is ≥25% above current price |

---

## Free tier limits

- **Finnhub:** 60 API requests/minute — sufficient for up to 10 stocks scanned in parallel
- **Vercel:** Free tier covers unlimited personal projects with generous bandwidth

---

## Updating the app

If you want to change the list of preset tickers or anything else, edit the files on GitHub directly (click the file → pencil icon) and Vercel will automatically redeploy within 2 minutes.
