# PinkShazam | Crypto Market Intelligence

**Long-Term Market Research & Data Analytics**

An interactive research dashboard for Bitcoin and Ethereum built on **monthly** historical data from CoinMarketCap. It covers long-term price trends, market cycles, risk and BTC-versus-ETH performance, and states the method behind every number.

Built with React, TypeScript, Vite, Tailwind CSS and Recharts.

> Historical analysis only. Nothing in this project is a forecast or investment advice.

## Quick start

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev
```

Open the address Vite prints (normally http://localhost:5173). The dashboard opens with the bundled BTC and ETH datasets already loaded.

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run build` | Create a production build in `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run typecheck` | Run the TypeScript compiler without emitting files |

## What is in the dashboard

| Section | Contents |
| --- | --- |
| Market overview | 12-month returns, distance from record monthly close, ETH/BTC ratio, correlation, rebased performance, market capitalization |
| Bitcoin technicals | Monthly price (line or candles, linear or log), SMA 12 and SMA 24, monthly RSI 14, monthly returns, rolling 12-month return and volatility, drawdown, volume, calendar-year returns |
| Ethereum technicals | The same set for ETH, plus a BTC-versus-ETH cumulative return comparison |
| Risk & performance | Cumulative return, rolling volatility and correlation, Sharpe, Sortino and Calmar ratios, asset and month-range filters, adjustable risk-free rate |
| Research & insights | A written research note generated from the loaded data and recomputed for each timeframe |
| Data sources | CSV upload with validation: frequency, coverage, missing months, complete-month check, columns found |
| Methodology | Every formula, minimum sample size and limitation |

Timeframes: 6M, 12M, 24M, 36M, 5Y and ALL. Charts export as PNG and tables as CSV.

## Data

The two files in `src/data/` are monthly historical exports from [CoinMarketCap](https://coinmarketcap.com), included unchanged:

| Asset | File | Coverage | Records |
| --- | --- | --- | --- |
| Bitcoin | `Bitcoin_10_11_2024-10_11_2026_historical_data_coinmarketcap.csv` | Apr 2013 to Oct 2026 | 163 months |
| Ethereum | `Ethereum_10_11_2024-10_11_2026_historical_data_coinmarketcap.csv` | Sep 2015 to Oct 2026 | 134 months |

Each row is one calendar month (UTC) with open, high, low, close, volume, market capitalization and circulating supply, quoted in USD.

Things to know about these files:

- The file names mention 2024 to 2026, but the contents cover each asset's full history.
- Bitcoin's first record (April 2013) probably covers only the last days of that month, because the source's history starts on 28 April 2013. Its close is still a month-end close.
- Bitcoin's volume is reported as zero for 8 early months. It is shown as supplied.
- The dashboard contains no synthetic or demo data, and never fills or interpolates missing months.

### Updating the data

Either upload newer files on the **Data sources** page (they apply for the current session), or replace the files in `src/data/` and update the two import lines and the `BUNDLED` constant in `src/App.tsx`.

To export from CoinMarketCap: open the asset's *Historical Data* page, choose **Monthly**, set the date range, load all rows, then download the CSV. Daily and weekly files are rejected by the uploader rather than resampled.

Before publishing this repository, check that CoinMarketCap's terms allow you to redistribute the exported files. If in doubt, remove `src/data/*.csv` from the public repository and load the files through the uploader instead.

## Methodology in brief

All calculations use one observation per calendar month. The only annualization factor is 12.

| Measure | Method |
| --- | --- |
| Monthly return | `close / previous month-end close - 1` |
| SMA 12, SMA 24 | Mean of the last 12 or 24 monthly closes |
| RSI 14 | Wilder smoothing over 14 monthly price changes |
| Volatility | Sample standard deviation of monthly returns; annualized by `x sqrt(12)` |
| Maximum drawdown | Largest peak-to-trough decline between monthly closes |
| Correlation | Pearson correlation of monthly returns over months both assets share |
| Sharpe ratio | `(mean monthly return - monthly risk-free rate) / st. dev. x sqrt(12)` |
| CAGR | `(end close / start close) ^ (12 / months) - 1` |

The risk-free rate is an assumption set on the Risk & performance page. It defaults to 0%. The full list, with minimum sample sizes, is on the in-app Methodology page.

### Limits of monthly data

- Drawdowns are measured between month-end closes, so lows reached inside a month were deeper.
- A 12-month window holds only 12 returns, so short-window volatility, correlation and Sharpe ratios are imprecise.
- Monthly RSI and moving averages move slowly and are not timing tools.

## Project structure

```
pinkshazam-crypto-dashboard/
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
├── public/
│   └── favicon.svg
└── src/
    ├── main.tsx          entry point
    ├── App.tsx           dashboard: analytics, charts, sections, uploader
    ├── index.css         Tailwind import and page-level styles
    ├── vite-env.d.ts
    └── data/             CoinMarketCap monthly CSV exports
```

`src/App.tsx` is organised in labelled blocks: design tokens, types, analytics (pure functions), formatting, UI atoms, the five sections, data sources, methodology and the app shell.

## Deploying

`npm run build` writes a static site to `dist/`. The build uses relative asset paths, so it can be hosted at a domain root or under a sub-path such as GitHub Pages (`https://<user>.github.io/<repo>/`). Any static host works: GitHub Pages, Netlify, Vercel, Cloudflare Pages.

## Verification status

- The calculations were checked against an independent pandas recomputation from the raw CSV files (1,217 values, no mismatches).
- Navigation, filters, CSV upload and exports were exercised in headless Chromium using these sources, with stand-ins for the chart and icon libraries.
- **Not yet verified:** `npm install`, `npm run build` and `npm run typecheck` have not been run on this exact package, and the charts have not been viewed with the real Recharts library. Check the price chart's log scale and candles first.

## Credits

Research & Data Visualization by PinkShazam. Market data from CoinMarketCap.
