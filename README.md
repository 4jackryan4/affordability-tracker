# Affordability Tracker

A one-page site showing the latest official numbers on what families pay for groceries, housing and energy, each measured against **January 2025**, with a chart of every reading since then.

The data refreshes itself. A GitHub Action runs every morning, pulls each series from FRED (which republishes BLS, EIA and Freddie Mac figures unchanged), recalculates every change, and commits the result. The page then reads that file. There is no server and nothing to pay for.

## What it tracks

| Stat | Measure | Source | Frequency |
|---|---|---|---|
| Overall prices | CPI-U, all items | BLS | Monthly |
| Groceries | CPI-U, food at home | BLS | Monthly |
| Ground beef | Average price per pound | BLS | Monthly |
| Coffee | Average price per pound | BLS | Monthly |
| Chicken | Average price per pound, fresh whole | BLS | Monthly |
| Milk | Average price per gallon, fresh whole | BLS | Monthly |
| Bananas | Average price per pound | BLS | Monthly |
| Rent | CPI-U, rent of primary residence | BLS | Monthly |
| Mortgage rates | 30-year fixed, weekly average | Freddie Mac PMMS | Weekly |
| Electricity | Average price per kWh | BLS | Monthly |
| Natural gas (utility) | Average price per therm | BLS | Monthly |
| Gasoline | Regular, weekly retail | EIA | Weekly |
| Diesel | On-highway, weekly retail | EIA | Weekly |

Each card shows the latest value, the change since January 2025, the change from a year earlier, a chart, a ready-to-paste sentence with its source, and a table of every reading.

## How the numbers are calculated

- **Baseline:** the January 2025 reading for monthly series; the average of all weeks in January 2025 for weekly series.
- **Percent change:** (latest − baseline) ÷ baseline. If the rounded prices on the page would give a different percent than the true one, the page shows one more decimal so anyone re-checking gets the same answer.
- **Since the Iran war began** (gas, diesel, mortgage rates, overall prices): change from the last reading before Feb. 28, 2026 to the latest. Shown only where war-driven fuel and oil costs are a documented driver.
  The event is defined in `config/series.json` under `events`; add its ID to a series' `events` list to show it on that card.
- **Mortgage payment:** new 30-year fixed loan of $400,000, principal and interest only.
- **Electricity and utility gas** are not seasonally adjusted, so their cards point to the year-over-year change as the cleaner comparison.
- **If a source is down,** that stat keeps its last good numbers and is flagged as stale on the page. Nothing is ever filled in or estimated.

## Setup (one time, about five minutes)

1. **Let the Action save data.** Settings → Actions → General → *Workflow permissions* → choose **Read and write permissions** → Save.
2. **Turn on the website.** Settings → Pages → *Source: Deploy from a branch* → Branch **main**, folder **/ (root)** → Save.
3. **Pull the first data.** Actions tab → **Update data** → **Run workflow**. It takes about a minute.
4. Open the site at `https://<your-username>.github.io/<repo-name>/`.

**Optional but recommended:** get a free FRED API key at <https://fred.stlouisfed.org/docs/api/api_key.html>, then add it under Settings → Secrets and variables → Actions → **New repository secret**, named `FRED_API_KEY`. The tracker works without it, but the API is the more reliable route.

## Files

```
config/series.json             which stats to track, labels, sources (edit this to add or remove a stat)
scripts/fetch_data.py          pulls the data and does all the math (standard-library Python, no installs)
.github/workflows/update-data.yml   runs the script daily and commits new data
data/stats.json                generated: every series, every reading, every calculation
data/summary.csv               generated: one row per stat, for spreadsheets
index.html, assets/            the page
```

## Adding a stat

Find the series on [FRED](https://fred.stlouisfed.org), copy its ID (e.g. `APU0000711211` for bananas), and add an entry to `config/series.json` following the others. Set `kind` to `price` for dollar amounts, `index` for CPI indexes (shown as percent change), or `rate` for percentages. Then run the workflow.

## Running it locally

```
python3 scripts/fetch_data.py
python3 -m http.server 8000     # then open http://localhost:8000
```

## A note on use

If this runs under an official office, keep the page factual and the repository separate from any campaign activity. Before citing a number, confirm the period and source shown on its card.
