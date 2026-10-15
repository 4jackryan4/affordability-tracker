(function () {
  "use strict";

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var grid = document.getElementById("grid");
  var filtersEl = document.getElementById("filters");
  var metaEl = document.getElementById("meta");
  var tooltip = document.getElementById("tooltip");
  var charts = [];
  var activeCategory = "All";

  // ---------------------------------------------------------------- helpers
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function parseDate(d) { var p = d.split("-"); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function periodShort(d, freq) {
    var dt = parseDate(d);
    if (freq === "monthly") return MONTHS[dt.getUTCMonth()] + " " + dt.getUTCFullYear();
    return "Week of " + MONTHS[dt.getUTCMonth()] + " " + dt.getUTCDate() + ", " + dt.getUTCFullYear();
  }
  function signed(n, digits) {
    var v = Number(n).toFixed(digits);
    if (Number(v) === 0) return (0).toFixed(digits);
    return (n > 0 ? "+" : "−") + Math.abs(n).toFixed(digits);
  }
  function arrow(n) { return n > 0.0001 ? "▲" : n < -0.0001 ? "▼" : "■"; }
  function money(v, d) {
    return "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmt(s, v, decimals) {
    var d = decimals == null ? (s.decimals == null ? 2 : s.decimals) : decimals;
    if (s.kind === "price") return money(v, d);
    if (s.kind === "rate") return Number(v).toFixed(d) + "%";
    return Number(v).toFixed(1);
  }

  // ---------------------------------------------------------------- load
  fetch("data/stats.json", { cache: "no-cache" })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(render)
    .catch(function () {
      metaEl.textContent = "No data yet.";
      grid.innerHTML =
        '<div class="empty"><h2>The data hasn’t been pulled yet</h2>' +
        "<p>Open the repository’s <strong>Actions</strong> tab, choose <strong>Update data</strong>, and click <strong>Run workflow</strong>. " +
        "The page fills in once it finishes (about a minute).</p></div>";
    });

  function render(data) {
    var series = (data.series || []).filter(function (s) { return s.observations && s.observations.length; });
    if (!series.length) throw new Error("empty");

    var updated = data.generated_at ? new Date(data.generated_at) : null;
    metaEl.innerHTML =
      "Baseline: <strong>" + esc(data.baseline.label) + "</strong>" +
      (updated ? " · Data last changed <strong>" + updated.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) + "</strong>" : "") +
      " · Checked for new releases daily";

    var cats = ["All"];
    series.forEach(function (s) { if (cats.indexOf(s.category) < 0) cats.push(s.category); });
    filtersEl.innerHTML = cats.map(function (c) {
      return '<button class="chip" type="button" data-cat="' + esc(c) + '" aria-pressed="' + (c === activeCategory) + '">' + esc(c) + "</button>";
    }).join("");
    filtersEl.addEventListener("click", function (e) {
      var b = e.target.closest(".chip");
      if (!b) return;
      activeCategory = b.getAttribute("data-cat");
      Array.prototype.forEach.call(filtersEl.children, function (x) {
        x.setAttribute("aria-pressed", String(x === b));
      });
      Array.prototype.forEach.call(grid.children, function (card) {
        card.hidden = !(activeCategory === "All" || card.getAttribute("data-cat") === activeCategory);
      });
      charts.forEach(function (c) { c.draw(); });
    });

    grid.innerHTML = "";
    series.forEach(function (s) { grid.appendChild(card(s, data.baseline)); });
  }

  // ---------------------------------------------------------------- card
  function card(s, baseline) {
    var el = document.createElement("article");
    el.className = "card";
    el.setAttribute("data-cat", s.category);
    var base = baseline.label;
    var pct = s.pct_change;
    var headline, change, sub = [];

    if (s.kind === "index") {
      headline = signed(pct, 1) + "%<small>since " + esc(base) + "</small>";
      change = "";
      sub.push("Index level " + Number(s.latest_value).toFixed(1) + " vs. " + Number(s.baseline_value).toFixed(1) + " (1982–84 = 100)");
      if (s.year_ago_pct_change != null) sub.push(arrow(s.year_ago_pct_change) + " " + signed(s.year_ago_pct_change, 1) + "% vs. a year ago");
    } else if (s.kind === "rate") {
      headline = esc(s.latest_display);
      change = arrow(s.change) + " " + signed(s.change, 2) + " pts <span>since " + esc(base) + " (" + esc(s.baseline_display) + " avg.)</span>";
      if (s.mortgage) {
        sub.push(signed(s.mortgage.monthly_diff, 0).replace(/^([+−])/, "$1$") + "/month on a new $" +
          Math.round(s.mortgage.loan_amount / 1000) + "k loan (" + money(s.mortgage.payment_latest, 0) + " vs. " + money(s.mortgage.payment_baseline, 0) + ")");
      }
      if (s.year_ago_change != null) sub.push(arrow(s.year_ago_change) + " " + signed(s.year_ago_change, 2) + " pts vs. a year ago");
    } else {
      headline = esc(s.latest_display) + "<small>" + esc(s.unit) + "</small>";
      change = arrow(pct) + " " + signed(pct, 1) + "% <span>since " + esc(base) + " (" + esc(s.baseline_display) + (s.frequency === "weekly" ? " avg." : "") + ")</span>";
      if (s.year_ago_pct_change != null) sub.push(arrow(s.year_ago_pct_change) + " " + signed(s.year_ago_pct_change, 1) + "% vs. a year ago");
    }

    var latestPeriod = periodShort(s.latest_date, s.frequency);
    var notes = "";
    if (s.seasonal_warning) {
      notes += '<p class="note">Not seasonally adjusted, so it swings with the weather. The year-over-year change is the cleaner comparison.</p>';
    }
    if (s.stale) {
      notes += '<p class="stale">The latest update failed, so this shows the last successful pull' +
        (s.fetched_at ? " (" + esc(new Date(s.fetched_at).toLocaleDateString("en-US")) + ")" : "") + ".</p>";
    }

    el.innerHTML =
      '<div class="card-head"><h2>' + esc(s.name) + '</h2><span class="cat">' + esc(s.category) + "</span></div>" +
      '<p class="measure">' + esc(s.measure) + "</p>" +
      '<div class="figures"><div class="latest">' + headline + "</div>" +
      (change ? '<div class="change">' + change + "</div>" : "") + "</div>" +
      eventLines(s) +
      '<p class="period">Latest: ' + esc(latestPeriod) + "</p>" +
      sub.map(function (t) { return '<p class="sub">' + esc(t) + "</p>"; }).join("") +
      notes +
      '<div class="chart" role="img" aria-label="' + esc(chartLabel(s, base)) + '"></div>' +
      '<p class="quote">' + esc(s.sentence) + "</p>" +
      '<div class="actions"><button class="copy" type="button">Copy sentence</button>' +
      '<span class="sources">Source: <a href="' + esc(s.source_url) + '" target="_blank" rel="noopener">' + esc(s.source) + "</a> · " +
      '<a href="' + esc(s.fred_url) + '" target="_blank" rel="noopener">FRED ' + esc(s.id) + "</a></span></div>" +
      '<details class="data"><summary>Show the data</summary><div class="table-wrap">' + table(s) + "</div></details>";

    el.querySelector(".copy").addEventListener("click", function (e) { copyText(s.sentence, e.currentTarget); });
    var chart = makeChart(el.querySelector(".chart"), s, base);
    charts.push(chart);
    return el;
  }

  // One line per event (e.g. the Iran war), under the "since January 2025" line.
  function eventLines(s) {
    return (s.events || []).map(function (ev) {
      var amount = s.kind === "rate"
        ? arrow(ev.change) + " " + signed(ev.change, 2) + " pts"
        : arrow(ev.pct_change) + " " + signed(ev.pct_change, 1) + "%";
      var detail;
      if (ev.kind === "window") {
        detail = ev.label + ", " + ev.range_label +
          (s.kind === "index" ? "" : " (" + ev.from_display + " → " + ev.to_display + ")");
      } else if (s.frequency === "weekly") {
        detail = ev.label + " (" + ev.from_display + " the week before)";
      } else {
        detail = ev.label + " (from " + periodShort(ev.from_date, s.frequency) + ")";
      }
      return '<p class="event">' + amount + " <span>" + esc(detail) + "</span></p>";
    }).join("");
  }

  function chartLabel(s, base) {
    var first = s.observations[0], last = s.observations[s.observations.length - 1];
    return s.name + " from " + periodShort(first[0], s.frequency) + " to " + periodShort(last[0], s.frequency) +
      (s.kind === "index" ? ", " + signed(s.pct_change, 1) + "% since " + base
        : ", from " + fmt(s, first[1]) + " to " + fmt(s, last[1]));
  }

  function table(s) {
    var rows = s.observations.slice().reverse().map(function (o) {
      var p = (o[1] - s.baseline_value) / s.baseline_value * 100;
      var vs = s.kind === "rate" ? signed(o[1] - s.baseline_value, 2) + " pts" : signed(p, 1) + "%";
      return "<tr><td>" + esc(periodShort(o[0], s.frequency)) + '</td><td class="num">' + esc(fmt(s, o[1], s.kind === "index" ? null : (s.decimals || 2) + 1)) +
        '</td><td class="num">' + esc(vs) + "</td></tr>";
    }).join("");
    return "<table><thead><tr><th>Period</th><th class=\"num\">" + (s.kind === "index" ? "Index" : "Value") +
      '</th><th class="num">vs. Jan 2025</th></tr></thead><tbody>' + rows + "</tbody></table>";
  }

  function copyText(text, btn) {
    function done() {
      var old = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(function () { btn.textContent = old; }, 1400);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else { fallback(); }
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { /* ignore */ }
      document.body.removeChild(ta);
    }
  }

  // ---------------------------------------------------------------- chart
  var NS = "http://www.w3.org/2000/svg";
  function svgEl(name, attrs, parent) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function niceStep(range, count) {
    var raw = range / count;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
    return step * mag;
  }

  function makeChart(host, s, baseLabel) {
    var isIndex = s.kind === "index";
    // Index series are plotted as % change from the baseline; prices and
    // rates are plotted in their own units with the baseline as a reference line.
    var pts = s.observations.map(function (o) {
      return { d: o[0], t: parseDate(o[0]).getTime(), raw: o[1],
        v: isIndex ? (o[1] - s.baseline_value) / s.baseline_value * 100 : o[1] };
    });
    var ref = isIndex ? 0 : s.baseline_value;

    function yTick(v, step) {
      var dec = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
      if (isIndex) return (v > 0 ? "+" : "") + v.toFixed(dec) + "%";
      if (s.kind === "price") return "$" + v.toFixed(Math.max(dec, v < 10 ? 2 : 0));
      return v.toFixed(Math.max(dec, 1)) + "%";
    }

    var state = {};
    function draw() {
      var w = host.clientWidth, h = host.clientHeight;
      if (!w || !h) return;
      host.innerHTML = "";
      var m = { l: 46, r: 14, t: 10, b: 22 };
      var iw = w - m.l - m.r, ih = h - m.t - m.b;
      var svg = svgEl("svg", { width: w, height: h, viewBox: "0 0 " + w + " " + h, "aria-hidden": "true" }, host);

      var t0 = pts[0].t, t1 = pts[pts.length - 1].t;
      var lo = Math.min(ref, Math.min.apply(null, pts.map(function (p) { return p.v; })));
      var hi = Math.max(ref, Math.max.apply(null, pts.map(function (p) { return p.v; })));
      if (hi === lo) { hi += 1; lo -= 1; }
      var step = niceStep(hi - lo, 3);
      var y0 = Math.floor(lo / step) * step, y1 = Math.ceil(hi / step) * step;
      var x = function (t) { return m.l + (t1 === t0 ? iw / 2 : (t - t0) / (t1 - t0) * iw); };
      var y = function (v) { return m.t + ih - (v - y0) / (y1 - y0) * ih; };

      // grid + y ticks
      for (var v = y0; v <= y1 + step / 2; v += step) {
        var yy = Math.round(y(v)) + 0.5;
        svgEl("line", { class: "gridline", x1: m.l, x2: w - m.r, y1: yy, y2: yy }, svg);
        var tx = svgEl("text", { x: m.l - 8, y: yy + 4, "text-anchor": "end" }, svg);
        tx.textContent = yTick(v, step);
      }

      // x ticks: every 6 months from Jan 2025 (every 12 when narrow)
      var every = iw < 260 ? 12 : 6;
      var start = parseDate(pts[0].d);
      for (var k = 0; ; k += every) {
        var td = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + k, 1);
        if (td > t1) break;
        // weekly series start a few days into January; pin that tick to the first point
        var tx0 = td < t0 ? (t0 - td < 8 * 864e5 ? t0 : null) : td;
        if (tx0 === null) continue;
        var dt = new Date(td);
        var lbl = svgEl("text", { x: x(tx0), y: h - 4, "text-anchor": k === 0 ? "start" : "middle" }, svg);
        lbl.textContent = MONTHS[dt.getUTCMonth()] + " ’" + String(dt.getUTCFullYear()).slice(2);
      }

      // event markers: a shaded band for a date window, a line for a start date
      (s.events || []).forEach(function (ev) {
        var es = parseDate(ev.start).getTime();
        if (es < t0 || es > t1) return;
        var ex0 = x(es), lx;
        if (ev.kind === "window" && ev.end) {
          var ex1 = x(Math.min(parseDate(ev.end).getTime(), t1));
          svgEl("rect", { class: "evband", x: ex0, y: m.t, width: Math.max(1, ex1 - ex0), height: ih }, svg);
          lx = ex0 + 4;
        } else {
          var xx = Math.round(ex0) + 0.5;
          svgEl("line", { class: "evline", x1: xx, x2: xx, y1: m.t, y2: m.t + ih }, svg);
          lx = xx - 4; // label to the left: prices were lower before the event, so the top-left is clear
        }
        var lab = svgEl("text", { class: "evlabel", x: lx, y: m.t + 10, "text-anchor": ev.kind === "window" ? "start" : "end" }, svg);
        lab.textContent = ev.short || "";
      });

      // area + line
      var linePts = pts.map(function (p) { return x(p.t).toFixed(1) + "," + y(p.v).toFixed(1); });
      svgEl("path", { class: "area", d: "M" + x(t0) + "," + (m.t + ih) + " L" + linePts.join(" L") + " L" + x(t1) + "," + (m.t + ih) + " Z" }, svg);

      // baseline reference
      var ry = Math.round(y(ref)) + 0.5;
      svgEl("line", { class: "refline", x1: m.l, x2: w - m.r, y1: ry, y2: ry }, svg);
      var last = pts[pts.length - 1];
      var rl = svgEl("text", { class: "reflabel", x: m.l + 6, y: ry + 13, "text-anchor": "start" }, svg);
      rl.textContent = baseLabel + (s.frequency === "weekly" ? " avg." : "") + " level";
      // Place the label where the line (and end dot) crosses it least: try
      // left/right ends, above/below the reference line.
      var lw = rl.getComputedTextLength ? rl.getComputedTextLength() : 130;
      function lineYAt(px) {
        for (var i = 1; i < pts.length; i++) {
          var xa = x(pts[i - 1].t), xb = x(pts[i].t);
          if (px >= xa && px <= xb) {
            var f = xb === xa ? 0 : (px - xa) / (xb - xa);
            return y(pts[i - 1].v) + f * (y(pts[i].v) - y(pts[i - 1].v));
          }
        }
        return null;
      }
      var cands = [
        { x: m.l + 6, anchor: "start", y: ry + 13 }, { x: m.l + 6, anchor: "start", y: ry - 5 },
        { x: w - m.r - 12, anchor: "end", y: ry + 13 }, { x: w - m.r - 12, anchor: "end", y: ry - 5 }
      ];
      var bestC = cands[0], bestScore = Infinity;
      cands.forEach(function (c, ci) {
        var bx0 = c.anchor === "start" ? c.x : c.x - lw, bx1 = bx0 + lw;
        var by0 = c.y - 11, by1 = c.y + 3, score = 0;
        for (var px = bx0; px <= bx1; px += 3) {
          var ly = lineYAt(px);
          if (ly !== null && ly >= by0 - 3 && ly <= by1 + 3) score++;
        }
        var dx = x(last.t), dy = y(last.v);
        if (dx >= bx0 - 8 && dx <= bx1 + 8 && dy >= by0 - 8 && dy <= by1 + 8) score += 20;
        if (by0 < m.t || by1 > m.t + ih) score += 50;
        score += ci * 0.01; // stable preference order on ties
        if (score < bestScore) { bestScore = score; bestC = c; }
      });
      rl.setAttribute("x", bestC.x); rl.setAttribute("y", bestC.y); rl.setAttribute("text-anchor", bestC.anchor);

      svgEl("path", { class: "line", d: "M" + linePts.join(" L") }, svg);
      svgEl("circle", { class: "dot", cx: x(last.t), cy: y(last.v), r: 4.5 }, svg);

      // hover layer
      var cross = svgEl("line", { class: "cross", x1: 0, x2: 0, y1: m.t, y2: m.t + ih, visibility: "hidden" }, svg);
      var hdot = svgEl("circle", { class: "dot", r: 4.5, visibility: "hidden" }, svg);
      var hit = svgEl("rect", { x: m.l - 6, y: 0, width: iw + 12, height: h, fill: "transparent" }, svg);

      function show(evt) {
        var rect = svg.getBoundingClientRect();
        var px = evt.clientX - rect.left;
        var best = 0, bd = Infinity;
        for (var i = 0; i < pts.length; i++) {
          var dd = Math.abs(x(pts[i].t) - px);
          if (dd < bd) { bd = dd; best = i; }
        }
        var p = pts[best];
        var cx = x(p.t), cy = y(p.v);
        cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
        hdot.setAttribute("cx", cx); hdot.setAttribute("cy", cy); hdot.setAttribute("visibility", "visible");
        var vs = s.kind === "rate" ? signed(p.raw - s.baseline_value, 2) + " pts"
          : signed((p.raw - s.baseline_value) / s.baseline_value * 100, 1) + "%";
        tooltip.innerHTML = "<b>" + esc(periodShort(p.d, s.frequency)) + "</b><br>" +
          (isIndex ? "" : esc(fmt(s, p.raw)) + " · ") + esc(vs) + " vs. " + esc(baseLabel);
        tooltip.hidden = false;
        var tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
        var left = rect.left + cx + 12;
        if (left + tw > window.innerWidth - 8) left = rect.left + cx - tw - 12;
        tooltip.style.left = Math.max(8, left) + "px";
        tooltip.style.top = Math.max(8, rect.top + cy - th - 10) + "px";
      }
      function hide() {
        cross.setAttribute("visibility", "hidden");
        hdot.setAttribute("visibility", "hidden");
        tooltip.hidden = true;
      }
      hit.addEventListener("pointermove", show);
      hit.addEventListener("pointerdown", show);
      hit.addEventListener("pointerleave", hide);
    }

    state.draw = draw;
    if (window.ResizeObserver) new ResizeObserver(function () { draw(); }).observe(host);
    else window.addEventListener("resize", draw);
    requestAnimationFrame(draw);
    return state;
  }

  window.addEventListener("scroll", function () { tooltip.hidden = true; }, { passive: true });
})();
