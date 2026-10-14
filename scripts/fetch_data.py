#!/usr/bin/env python3
"""Pull every series in config/series.json from FRED and write data/stats.json.

FRED republishes the official BLS, EIA and Freddie Mac series unchanged, so one
source covers everything. Standard library only, so the GitHub Action needs no
installs.

Fetch order for each series:
  1. FRED API, if a FRED_API_KEY secret is set (most reliable).
  2. FRED's public CSV download (no key needed).
If both fail, the series keeps its previous values and is marked stale, so one
outage never blanks the page or swaps in bad numbers.

For tests, set FRED_FIXTURE_DIR to a folder of <SERIES_ID>.csv files.
"""

from __future__ import annotations

import csv
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "series.json"
OUT_PATH = ROOT / "data" / "stats.json"
CSV_PATH = ROOT / "data" / "summary.csv"

USER_AGENT = "affordability-tracker/1.0 (+https://github.com)"
MONTHS = ["January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December"]
SHORT_MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July",
                "Aug.", "Sept.", "Oct.", "Nov.", "Dec."]


# ---------------------------------------------------------------- fetching

def _get(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8")


def _parse_csv(text: str) -> list[tuple[str, float]]:
    rows = list(csv.reader(io.StringIO(text)))
    if not rows or len(rows[0]) < 2:
        raise ValueError("unexpected CSV shape")
    out = []
    for row in rows[1:]:
        if len(row) < 2 or row[1] in ("", "."):
            continue
        out.append((row[0], float(row[1])))
    return out


def fetch_observations(series_id: str, start: str) -> tuple[list[tuple[str, float]], str]:
    fixture_dir = os.environ.get("FRED_FIXTURE_DIR")
    if fixture_dir:
        text = (Path(fixture_dir) / f"{series_id}.csv").read_text()
        return [o for o in _parse_csv(text) if o[0] >= start], "fixture"

    errors = []
    api_key = os.environ.get("FRED_API_KEY", "").strip()
    if api_key:
        params = urllib.parse.urlencode({
            "series_id": series_id, "api_key": api_key,
            "file_type": "json", "observation_start": start,
        })
        try:
            data = json.loads(_get(f"https://api.stlouisfed.org/fred/series/observations?{params}"))
            obs = [(o["date"], float(o["value"])) for o in data["observations"]
                   if o["value"] not in ("", ".")]
            return obs, "fred-api"
        except Exception as exc:  # noqa: BLE001
            errors.append(f"api: {exc}")

    params = urllib.parse.urlencode({"id": series_id, "cosd": start})
    for attempt in range(3):
        try:
            text = _get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?{params}")
            return [o for o in _parse_csv(text) if o[0] >= start], "fred-csv"
        except Exception as exc:  # noqa: BLE001
            errors.append(f"csv attempt {attempt + 1}: {exc}")
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("; ".join(errors))


# ---------------------------------------------------------------- formatting

def period_label(d: str, frequency: str) -> str:
    dt = date.fromisoformat(d)
    if frequency == "monthly":
        return f"{MONTHS[dt.month - 1]} {dt.year}"
    return f"the week of {SHORT_MONTHS[dt.month - 1]} {dt.day}, {dt.year}"


def fmt_value(v: float, s: dict, decimals: int | None = None) -> str:
    d = s.get("decimals", 2) if decimals is None else decimals
    if s["kind"] == "price":
        return f"${v:,.{d}f}"
    if s["kind"] == "rate":
        return f"{v:.{d}f}%"
    return f"{v:,.1f}"


def monthly_payment(principal: float, annual_rate_pct: float, years: int = 30) -> float:
    r = annual_rate_pct / 100 / 12
    n = years * 12
    return principal * r / (1 - (1 + r) ** -n)


def find_year_ago(obs: list[tuple[str, float]], latest_date: str, frequency: str):
    target = date.fromisoformat(latest_date)
    target = target.replace(year=target.year - 1) if not (target.month == 2 and target.day == 29) \
        else target.replace(year=target.year - 1, day=28)
    tolerance = 0 if frequency == "monthly" else 4
    best = None
    for d, v in obs:
        gap = abs((date.fromisoformat(d) - target).days)
        if gap <= tolerance and (best is None or gap < best[0]):
            best = (gap, d, v)
    return (best[1], best[2]) if best else None


def build_sentence(s: dict, st: dict, baseline_label: str) -> str:
    pct = st["pct_change"]
    period = st["latest_period"]
    src = s["source"]
    direction = "up" if pct > 0 else "down"

    if s["kind"] == "index":
        verb = "rose" if pct > 0 else "fell"
        if abs(pct) < 0.05:
            return f"{s['phrase']} were essentially unchanged between {baseline_label} and {period} ({src}, {s['measure']})."
        return (f"{s['phrase']} {verb} {abs(pct):.1f}% between {baseline_label} and {period} "
                f"({src}, {s['measure']}).")

    if s["kind"] == "rate":
        pts = st["change"]
        text = (f"{s['phrase']} was {st['latest_display']} in {period}, "
                f"{'up' if pts > 0 else 'down'} {abs(pts):.2f} percentage points from "
                f"the {baseline_label} average of {st['baseline_display']} ({src}).")
        extra = st.get("mortgage")
        if extra and abs(extra["monthly_diff"]) >= 1:
            more = "more" if extra["monthly_diff"] > 0 else "less"
            text += (f" On a new ${extra['loan_amount']:,.0f} loan, that is about "
                     f"${abs(extra['monthly_diff']):,.0f} {more} a month, or "
                     f"${abs(extra['annual_diff']):,.0f} a year, in principal and interest.")
        return text

    base_word = f"the {baseline_label} average of" if s["frequency"] == "weekly" else baseline_label + ","
    if abs(pct) < 0.05:
        return (f"{s['phrase']} was {st['latest_display']} {s['unit']} in {period}, "
                f"essentially unchanged from {baseline_label} ({src}).")
    if s["frequency"] == "weekly":
        return (f"{s['phrase']} was {st['latest_display']} in {period}, {direction} "
                f"{abs(pct):.1f}% from {base_word} {st['baseline_display']} ({src}).")
    return (f"{s['phrase']} was {st['latest_display']} {s['unit']} in {period}, {direction} "
            f"{abs(pct):.1f}% from {st['baseline_display']} in {baseline_label} ({src}).")


# ---------------------------------------------------------------- stats

def compute(s: dict, obs: list[tuple[str, float]], baseline: dict) -> dict:
    base_obs = [v for d, v in obs if baseline["start"] <= d <= baseline["end"]]
    if not base_obs:
        raise ValueError("no observations in the baseline window")
    base = sum(base_obs) / len(base_obs)
    latest_date, latest = obs[-1]
    change = latest - base
    pct = change / base * 100

    decimals = s.get("decimals", 2)
    latest_disp = fmt_value(latest, s)
    base_disp = fmt_value(base, s)
    # If the rounded figures shown on the page would give a different percent
    # than the true one, show more precision so anyone re-checking gets the
    # same answer.
    if s["kind"] == "price":
        shown_pct = (round(latest, decimals) - round(base, decimals)) / round(base, decimals) * 100
        if round(shown_pct, 1) != round(pct, 1):
            # One more decimal; drop a trailing zero ($6.730 -> $6.73) since
            # that doesn't change the value anyone re-checks against.
            def trim(text: str) -> str:
                return text[:-1] if text.endswith("0") and len(text.split(".")[-1]) > decimals else text
            latest_disp = trim(fmt_value(latest, s, decimals + 1))
            base_disp = trim(fmt_value(base, s, decimals + 1))

    st = {
        "baseline_value": base,
        "baseline_points": len(base_obs),
        "baseline_display": base_disp,
        "latest_date": latest_date,
        "latest_period": period_label(latest_date, s["frequency"]),
        "latest_value": latest,
        "latest_display": latest_disp,
        "change": change,
        "pct_change": pct,
    }

    ya = find_year_ago(obs, latest_date, s["frequency"])
    if ya:
        st["year_ago_date"], st["year_ago_value"] = ya
        st["year_ago_pct_change"] = (latest - ya[1]) / ya[1] * 100
        st["year_ago_change"] = latest - ya[1]

    if s["kind"] == "rate" and s.get("loan_amount"):
        loan = s["loan_amount"]
        then = monthly_payment(loan, base)
        now = monthly_payment(loan, latest)
        st["mortgage"] = {
            "loan_amount": loan,
            "payment_baseline": then,
            "payment_latest": now,
            "monthly_diff": now - then,
            "annual_diff": (now - then) * 12,
        }

    st["sentence"] = build_sentence(s, st, baseline["label"])
    return st


def main() -> int:
    config = json.loads(CONFIG_PATH.read_text())
    baseline = config["baseline"]
    previous = {}
    if OUT_PATH.exists():
        try:
            previous = {s["id"]: s for s in json.loads(OUT_PATH.read_text()).get("series", [])}
        except (json.JSONDecodeError, KeyError):
            previous = {}

    now = datetime.now(timezone.utc).replace(microsecond=0)
    results, failures = [], []
    for s in config["series"]:
        entry = {k: v for k, v in s.items() if k != "phrase"}
        entry["fred_url"] = f"https://fred.stlouisfed.org/series/{s['id']}"
        try:
            obs, via = fetch_observations(s["id"], baseline["start"])
            if not obs:
                raise ValueError("no observations returned")
            entry.update(compute(s, obs, baseline))
            entry["observations"] = [[d, v] for d, v in obs]
            entry["fetched_via"] = via
            entry["fetched_at"] = now.isoformat()
            entry["stale"] = False
            print(f"ok    {s['id']:<15} {entry['latest_date']}  {entry['pct_change']:+.1f}%  via {via}")
        except Exception as exc:  # noqa: BLE001
            failures.append(s["id"])
            print(f"FAIL  {s['id']:<15} {exc}", file=sys.stderr)
            if s["id"] in previous:
                entry = {**previous[s["id"]], **{k: v for k, v in entry.items() if k not in previous[s['id']]}}
                entry["stale"] = True
                entry["error"] = str(exc)[:300]
            else:
                entry["stale"] = True
                entry["error"] = str(exc)[:300]
                entry["observations"] = []
        results.append(entry)

    if len(failures) == len(config["series"]):
        print("Every series failed; leaving data/stats.json untouched.", file=sys.stderr)
        return 1

    # Only bump the timestamp when data actually changed, so the daily job
    # doesn't create an empty commit every day.
    payload = {"baseline": baseline, "series": results}
    old_payload = json.loads(OUT_PATH.read_text()) if OUT_PATH.exists() else {}
    comparable = lambda p: json.dumps(  # noqa: E731
        [{k: v for k, v in s.items() if k != "fetched_at"} for s in p.get("series", [])], sort_keys=True)
    payload["generated_at"] = (old_payload.get("generated_at") if comparable(old_payload) == comparable(payload)
                               else now.isoformat())
    payload["series"] = results if comparable(old_payload) != comparable(payload) else old_payload["series"]

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, indent=1) + "\n")

    with CSV_PATH.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["stat", "measure", "latest_period", "latest_value", "baseline_jan_2025",
                    "change", "pct_change_since_jan_2025", "pct_change_year_over_year",
                    "source", "fred_series", "sentence"])
        for e in results:
            if "latest_value" not in e:
                continue
            w.writerow([e["name"], e["measure"], e["latest_period"], round(e["latest_value"], 4),
                        round(e["baseline_value"], 4), round(e["change"], 4), round(e["pct_change"], 2),
                        round(e["year_ago_pct_change"], 2) if "year_ago_pct_change" in e else "",
                        e["source"], e["id"], e["sentence"]])

    if failures:
        print(f"{len(failures)} series kept previous values: {', '.join(failures)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
