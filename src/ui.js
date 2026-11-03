"use strict";
(function () {
  const E = ENGINE;
  const fmt = E.fmt, pct = E.pct, clamp = E.clamp;
  const app = document.getElementById("app");
  const SAVE_KEY = "leconseil.partie.v2";
  const SHORT = { emb: "Emballages", mac: "Machines-outils", cmp: "Composants", bat: "Batteries", pmt: "Pièces thermiques", cap: "Capteurs", med: "Médical",
    gvfr: "GV France", gvde: "GV Allemagne", gves: "GV Espagne", gvit: "GV Italie", icfr: "IC France", icde: "IC Allemagne", icsud: "IC Sud", car: "Autocars",
    mfr: "Meubles FR", mde: "Meubles DACH", msud: "Meubles Sud", muk: "Meubles UK", co2: "Centrales CO₂", hfc: "Vitrines HFC", srv: "Services", chf: "Chambres froides" };
  const QUAD = { vedette: "Vedette", vache: "Vache à lait", dilemme: "Dilemme", poids: "Poids mort" };
  const TABS = [
    ["conseil", "Séance du conseil"], ["divisions", "Divisions"], ["marches", "Marchés"], ["matrice", "Matrice BCG"],
    ["comptes", "Comptes"], ["rivaux", "Concurrents"], ["journal", "Journal"], ["regles", "Règles"]
  ];

  const S = {
    G: null, draft: null, q: {}, tab: "conseil", result: null, matrixCo: "P", confirmRisk: false,
    sel: { scenario: "industrie", years: 15, timer: 0, name: "", seed: "" }, deadline: 0
  };

  /* ---------------- utilitaires ---------------- */
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const M = x => fmt(x) + " M€";
  const EUR = x => fmt(x, 2) + " €";
  const sign = (x, f) => (x > 0 ? "+" : x < 0 ? "−" : "") + f(Math.abs(x));
  const player = () => S.G.companies.find(c => c.player);
  const yearOf = t => S.G.startYear + t - 1;
  const lastH = E.lastH;
  const segOf = id => E.segById(S.G, id);
  function rankOf(co) {
    const r = S.G.companies.map(c => ({ c, s: lastH(c).score })).sort((a, b) => b.s - a.s);
    return r.findIndex(x => x.c === co) + 1;
  }
  function quadOf(co, sid) {
    const d = co.div[sid];
    return E.quadrant(S.G, segOf(sid), d && d.share > 0 ? d.rs : 0, true);
  }
  function sdFlag(r) {
    if (r > 1.06) return '<span class="sd-flag sd-over">surcapacité</span>';
    if (r < 0.95) return '<span class="sd-flag sd-under">pénurie</span>';
    return '<span class="sd-flag sd-eq">équilibre</span>';
  }

  /* ---------------- sauvegarde ---------------- */
  function save() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify({ G: S.G, draft: S.draft, q: S.q, sel: S.sel, deadline: S.deadline })); } catch (e) { /* stockage indisponible */ }
  }
  function loadSaved() {
    try {
      const s = localStorage.getItem(SAVE_KEY);
      const sv = s ? JSON.parse(s) : null;
      return sv && sv.G && sv.G.v === E.VERSION ? sv : null;
    } catch (e) { return null; }
  }
  function clearSaved() { try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* rien */ } }

  /* ---------------- brouillon de décisions ---------------- */
  function freshDraft() {
    const co = player();
    const d = E.defaultDecision(S.G, co);
    d.loan = null; d.issuePct = 0; d.buybackPct = 0; d.bids = {}; d.disinvest = {};
    S.q = {};
    for (const sid in co.div) S.q[sid] = "maint";
    S.confirmRisk = false;
    return d;
  }

  // montant d'actifs effectivement cédés et trésorerie récupérée pour une demande donnée
  function disAssets(co, sid, v) { return Math.min(Math.max(0, v), S.G.params.maxDisinv * co.div[sid].A); }
  function disCash(co, sid, v) { return E.disinvestRate(S.G, segOf(sid)) * disAssets(co, sid, v); }

  function hasListing(co, sid) { return S.G.listings.some(l => l.seller === co.id && l.seg === sid); }

  function estimate() {
    const G = S.G, co = player(), h = lastH(co), d = S.draft, p = G.params;
    let cash = co.cash, inv = 0, dep = 0, liq = 0, bids = 0;
    for (const sid in d.invest) inv += +d.invest[sid] || 0;
    for (const sid in co.div) {
      const dv = d.divest[sid];
      if (dv && dv.mode === "liq") liq += p.recov * co.div[sid].A;
    }
    for (const lid in d.bids) bids += +d.bids[lid] || 0;
    let dis = 0;
    for (const sid in (d.disinvest || {})) if (co.div[sid]) dis += disCash(co, sid, +d.disinvest[sid] || 0);
    const issue = d.issuePct > 0 ? co.shares * d.issuePct * h.price * (1 - p.issueDisc) : 0;
    const buy = d.buybackPct > 0 ? co.shares * d.buybackPct * h.price * 1.05 : 0;
    const divEst = d.payout * Math.max(0, h.npRec);
    const repay = co.loan ? Math.min(co.loan.ann, co.loan.out) : 0;
    cash += issue - buy - bids + liq + dis + h.npRec + h.dep - inv - divEst - repay;
    const ml = E.maxLoan(G, co);
    const loanIn = d.loan ? Math.min(+d.loan.amount || 0, ml) : 0;
    const end = cash + loanIn;
    const limit = p.overdraft * Math.max(h.rev, 0.5 * co.hist[0].rev);
    const lvl = end < -limit ? "bad" : end < 0 ? "warn" : "good";
    return { inv, dis, end, limit, lvl, divEst, issue, buy, loanIn, ml };
  }

  /* ---------------- graphiques SVG ---------------- */
  function niceTicks(min, max, n) {
    if (!isFinite(min) || !isFinite(max)) return [0, 1];
    if (min === max) { max = min + 1; min = min - 1; }
    const span = max - min, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(s => span / s <= n) || 10 * mag;
    const t = [];
    for (let v = Math.floor(min / step) * step; v <= max + step * 0.001; v += step) t.push(+v.toFixed(10));
    if (t[t.length - 1] < max) t.push(t[t.length - 1] + step);
    return t;
  }
  function lineChart(series, o) {
    o = o || {};
    const W = o.w || 640, H = o.h || 220, ml = o.ml || 46, mr = 70, mt = 12, mb = 26;
    const all = series.flatMap(s => s.pts);
    if (!all.length) return "";
    const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    let yt = niceTicks(o.y0 != null ? Math.min(o.y0, ...ys) : Math.min(...ys), Math.max(...ys), 4);
    const y0 = yt[0], y1 = yt[yt.length - 1];
    const X = x => ml + (x1 === x0 ? 0.5 : (x - x0) / (x1 - x0)) * (W - ml - mr);
    const Y = y => mt + (1 - (y - y0) / (y1 - y0 || 1)) * (H - mt - mb);
    let g = "";
    yt.forEach(v => { g += `<line x1="${ml}" x2="${W - mr}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${ml - 6}" y="${Y(v) + 4}" text-anchor="end" font-size="11">${esc(o.fy ? o.fy(v) : fmt(v, Math.abs(y1 - y0) < 5 ? 1 : 0))}</text>`; });
    const xstep = Math.max(1, Math.ceil((x1 - x0) / 8));
    for (let x = x0; x <= x1; x += xstep) g += `<text x="${X(x)}" y="${H - 8}" text-anchor="middle" font-size="11">${esc(o.fx ? o.fx(x) : x)}</text>`;
    const ends = [];
    series.forEach(s => {
      if (!s.pts.length) return;
      const d = s.pts.map((p, i) => (i ? "L" : "M") + X(p[0]).toFixed(1) + " " + Y(p[1]).toFixed(1)).join("");
      g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.w || 2}" ${s.dash ? 'stroke-dasharray="4 4"' : ""} stroke-linejoin="round" stroke-linecap="round"/>`;
      const lp = s.pts[s.pts.length - 1];
      g += `<circle cx="${X(lp[0])}" cy="${Y(lp[1])}" r="${s.w > 2 ? 4 : 3}" fill="${s.color}"/>`;
      ends.push({ y: Y(lp[1]), x: X(lp[0]), label: s.label || "", color: s.color });
    });
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
    ends.forEach(e => { if (e.label) g += `<text x="${e.x + 7}" y="${Math.min(H - mb, e.y) + 4}" font-size="11" style="fill:${e.color}">${esc(e.label)}</text>`; });
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria || "Graphique")}">${g}</svg>`;
  }
  function spark(vals, color) {
    if (vals.length < 2) return "";
    const W = 84, H = 24, mn = Math.min(...vals), mx = Math.max(...vals), sp = mx - mn || 1;
    const pts = vals.map((v, i) => [(i / (vals.length - 1)) * (W - 4) + 2, H - 3 - ((v - mn) / sp) * (H - 6)]);
    const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join("");
    const l = pts[pts.length - 1];
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true" style="vertical-align:middle"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"/><circle cx="${l[0]}" cy="${l[1]}" r="2.4" fill="${color}"/></svg>`;
  }

  function bcgChart(co) {
    const G = S.G, W = 640, H = 430, ml = 50, mr = 16, mt = 16, mb = 44;
    const items = [];
    for (const sid in co.div) {
      const d = co.div[sid], seg = segOf(sid);
      items.push({ seg, d, rs: clamp(d.share > 0 ? d.rs : 0.1, 0.1, 10), g: E.forecastGrowth(G, seg, G.year + 1), rev: d.rev || 0 });
    }
    const gs = G.segments.map(s => E.forecastGrowth(G, s, G.year + 1)).concat([G.params.bcgG]);
    let gmin = Math.min(-0.05, ...gs) - 0.02, gmax = Math.max(0.15, ...gs) + 0.02;
    const yt = niceTicks(gmin * 100, gmax * 100, 6);
    gmin = yt[0] / 100; gmax = yt[yt.length - 1] / 100;
    const lx = v => Math.log10(v);
    const X = rs => ml + (1 - (lx(rs) + 1) / 2) * (W - ml - mr);
    const Y = g => mt + (1 - (g - gmin) / (gmax - gmin)) * (H - mt - mb);
    const maxRev = Math.max(1, ...G.companies.flatMap(c => Object.values(c.div).map(d => d.rev || 0)));
    let s = "";
    s += `<rect x="${ml}" y="${mt}" width="${X(1) - ml}" height="${Y(G.params.bcgG) - mt}" fill="var(--good)" opacity="0.06"/>`;
    s += `<rect x="${X(1)}" y="${Y(G.params.bcgG)}" width="${W - mr - X(1)}" height="${H - mb - Y(G.params.bcgG)}" fill="var(--bad)" opacity="0.06"/>`;
    yt.forEach(v => { s += `<line x1="${ml}" x2="${W - mr}" y1="${Y(v / 100)}" y2="${Y(v / 100)}" stroke="var(--line)"/><text x="${ml - 6}" y="${Y(v / 100) + 4}" text-anchor="end" font-size="11">${fmt(v)} %</text>`; });
    [10, 5, 2, 1, 0.5, 0.2, 0.1].forEach(v => { s += `<line x1="${X(v)}" x2="${X(v)}" y1="${mt}" y2="${H - mb}" stroke="var(--line)" stroke-dasharray="${v === 1 ? "0" : "2 3"}"/><text x="${X(v)}" y="${H - mb + 15}" text-anchor="middle" font-size="11">${fmt(v, v < 1 ? 1 : 0)}×</text>`; });
    s += `<line x1="${X(1)}" x2="${X(1)}" y1="${mt}" y2="${H - mb}" stroke="var(--ink)" stroke-width="1.2"/>`;
    s += `<line x1="${ml}" x2="${W - mr}" y1="${Y(G.params.bcgG)}" y2="${Y(G.params.bcgG)}" stroke="var(--ink)" stroke-width="1.2"/>`;
    s += `<text x="${W / 2}" y="${H - 6}" text-anchor="middle" font-size="11">Part de marché relative (échelle log, leader à gauche)</text>`;
    const ql = (x, y, t, a) => `<text x="${x}" y="${y}" text-anchor="${a}" font-size="12" font-weight="700" style="fill:var(--muted);letter-spacing:.08em">${t}</text>`;
    s += ql(ml + 8, mt + 16, "VEDETTES", "start") + ql(W - mr - 8, mt + 16, "DILEMMES", "end") + ql(ml + 8, H - mb - 8, "VACHES À LAIT", "start") + ql(W - mr - 8, H - mb - 8, "POIDS MORTS", "end");
    const boxes = [[ml + 4, mt + 2, ml + 110, mt + 22], [W - mr - 100, mt + 2, W - mr - 4, mt + 22], [ml + 4, H - mb - 22, ml + 130, H - mb - 2], [W - mr - 110, H - mb - 22, W - mr - 4, H - mb - 2]];
    const hit = b => boxes.some(o => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
    const circles = [], labels = [];
    items.sort((a, b) => b.rev - a.rev).forEach(it => {
      const r = 6 + 30 * Math.sqrt(it.rev / maxRev);
      const cx = X(it.rs), cy = clamp(Y(it.g), mt, H - mb);
      circles.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${co.color}" fill-opacity="0.28" stroke="${co.color}" stroke-width="1.6"/>`);
      boxes.push([cx - r * 0.7, cy - r * 0.7, cx + r * 0.7, cy + r * 0.7]);
      it.cx = cx; it.cy = cy; it.r = r;
    });
    items.forEach(it => {
      const txt = SHORT[it.seg.id] || it.seg.name, w = txt.length * 6.4 + 4, hgt = 14;
      const cands = [[0, -it.r - 6], [0, it.r + 15], [it.r + 4 + w / 2, 4], [-it.r - 4 - w / 2, 4], [0, -it.r - 20], [0, it.r + 29]];
      let pos = cands[0];
      for (const c of cands) {
        const x = clamp(it.cx + c[0], ml + w / 2, W - mr - w / 2), y = it.cy + c[1];
        const b = [x - w / 2, y - hgt + 3, x + w / 2, y + 3];
        if (!hit(b) && y > mt + 10 && y < H - mb) { pos = [x - it.cx, c[1]]; break; }
      }
      const x = clamp(it.cx + pos[0], ml + w / 2, W - mr - w / 2), y = it.cy + pos[1];
      boxes.push([x - w / 2, y - hgt + 3, x + w / 2, y + 3]);
      labels.push(`<text x="${x}" y="${y}" text-anchor="middle" font-size="11" style="fill:var(--ink)">${esc(txt)}</text>`);
    });
    s += circles.join("") + labels.join("");
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Matrice part de marché relative et croissance de ${esc(co.name)}">${s}</svg>`;
  }

  /* ---------------- guilloche ---------------- */
  function drawGuilloche() {
    const cv = document.getElementById("guill");
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.max(1, r.width * dpr); cv.height = Math.max(1, r.height * dpr);
    const ctx = cv.getContext("2d");
    ctx.scale(dpr, dpr);
    const col = getComputedStyle(document.documentElement).getPropertyValue("--brass").trim() || "#8C6E22";
    ctx.strokeStyle = col; ctx.lineWidth = 0.6; ctx.globalAlpha = 0.5;
    const cx = r.width - Math.min(170, r.width * 0.22), cy = r.height / 2;
    const Rb = Math.min(150, r.height * 0.62);
    for (let k = 0; k < 3; k++) {
      const R = Rb - k * 26, rr = 13 + k * 4, d = 24 - k * 5, n = 2600;
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * Math.PI * 2 * rr;
        const x = cx + (R - rr) * Math.cos(t) + d * Math.cos(((R - rr) / rr) * t);
        const y = cy + (R - rr) * Math.sin(t) - d * Math.sin(((R - rr) / rr) * t);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 0.25;
    for (let j = 0; j < 7; j++) {
      ctx.beginPath();
      for (let x = 0; x <= r.width; x += 3) {
        const y = 10 + j * 5 + 4 * Math.sin(x / 19 + j * 0.9);
        x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
  }

  /* ================================================================
     ACCUEIL
     ================================================================ */
  function renderHome() {
    const saved = loadSaved();
    const sc = E.SCENARIOS;
    app.innerHTML = `
<header class="cert"><canvas id="guill"></canvas><div class="wrap"><div class="frame">
  <div class="serial"><span>Société anonyme à conseil d'administration</span><span>Valeur de départ 10,00 € par action</span></div>
  <h1 class="brand">Le <em>Conseil</em></h1>
  <p class="lede">Vous présidez le conseil d'administration d'un groupe présent sur plusieurs créneaux. À chaque exercice, vous répartissez les ressources entre vos divisions, fixez le dividende et choisissez vos financements, face à quatre concurrents qui font de même. Les actionnaires vous jugent sur la valeur de l'action, dividendes compris.</p>
</div></div></header>
<main class="wrap home">
  ${saved && saved.G && !saved.G.over ? `<section class="panel row" style="justify-content:space-between">
    <div><div class="eyebrow">Partie en cours</div><p><b>${esc(saved.G.title)}</b> · exercice ${saved.G.year + 1} sur ${saved.G.T}</p></div>
    <div class="row"><button class="btn primary" data-act="resume">Reprendre la séance</button><button class="btn ghost" data-act="discard">Abandonner</button></div></section>` : ""}
  <section class="section">
    <div class="section-head"><h2>Choisir le dossier</h2><span class="muted small">Sociétés et chiffres fictifs</span></div>
    <div class="scen-grid">${sc.map(s => `
      <button class="scen" data-act="pick" data-id="${s.id}" aria-pressed="${S.sel.scenario === s.id}">
        <span class="eyebrow">${esc(s.kicker)}</span>
        <h3>${esc(s.title)}</h3>
        <p class="small">${esc(s.pitch)}</p>
        <span class="chips"><span class="chip">${s.segments.length} créneaux</span><span class="chip">4 concurrents</span><span class="chip">Seuil antitrust ${pct(s.params.cap, 0)}</span></span>
      </button>`).join("")}</div>
  </section>
  <section class="section">
    <div class="section-head"><h2>Conditions de séance</h2></div>
    <div class="opts">
      <div class="field"><label for="o-years">Durée du mandat</label><select id="o-years" data-o="years">${[10, 15, 20].map(y => `<option value="${y}" ${S.sel.years === y ? "selected" : ""}>${y} exercices</option>`).join("")}</select></div>
      <div class="field"><label for="o-timer">Temps par exercice</label><select id="o-timer" data-o="timer">${[[0, "Illimité"], [180, "3 minutes"], [300, "5 minutes"]].map(([v, l]) => `<option value="${v}" ${S.sel.timer === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="field"><label for="o-name">Nom de votre société</label><input id="o-name" type="text" data-o="name" maxlength="32" placeholder="${esc(sc.find(s => s.id === S.sel.scenario).companies[0].name)}" value="${esc(S.sel.name)}"></div>
      <div class="field"><label for="o-seed">Graine (facultatif)</label><input id="o-seed" type="number" data-o="seed" inputmode="numeric" placeholder="Aléatoire" value="${esc(S.sel.seed)}"></div>
    </div>
    <p class="small muted">Une même graine rejoue exactement la même conjoncture : utile pour comparer deux stratégies.</p>
  </section>
  <div class="row"><button class="btn seal" data-act="start">Prendre la présidence</button></div>
</main>`;
    requestAnimationFrame(drawGuilloche);
  }

  /* ================================================================
     JEU
     ================================================================ */
  function renderGame() {
    const G = S.G, co = player(), h = lastH(co);
    const over = G.over;
    const t = over ? G.year : G.year + 1;
    const tabs = over ? [["bilan", "Bilan final"]].concat(TABS.filter(x => x[0] !== "conseil")) : TABS;
    if (!tabs.some(x => x[0] === S.tab)) S.tab = tabs[0][0];
    app.innerHTML = `
<div class="topbar"><div class="wrap">
  <div class="topline">
    <div class="row" style="gap:8px"><span class="mini-brand">Le <em>Conseil</em></span><span class="muted small">${esc(co.name)} · ${esc(G.title)}</span></div>
    <div class="exercise">${over ? "Mandat achevé" : `Exercice <b>${yearOf(t)}</b> · ${t}/${G.T}`}</div>
  </div>
  <div class="kpis">
    <span>Score<b>${fmt(h.score, 2)}</b></span><span>Cours<b>${EUR(h.price)}</b></span><span>Trésorerie<b class="${co.cash < 0 ? "bad" : ""}">${M(co.cash)}</b></span>
    <span>Dette<b>${M(co.loan ? co.loan.out : 0)}</b></span><span>Taux directeur<b>${pct(G.params.rate, 1)}</b></span><span>Rang<b>${rankOf(co)}/${G.companies.length}</b></span>
    ${S.sel.timer && !over ? `<span>Temps<b class="timer" id="timer">—</b></span>` : ""}
  </div>
  <nav class="tabs" role="tablist" aria-label="Rubriques">${tabs.map(([id, l]) => `<button class="tab" role="tab" id="tab-${id}" aria-selected="${S.tab === id}" data-act="tab" data-tab="${id}">${l}</button>`).join("")}</nav>
</div></div>
<main class="wrap" id="panel" role="tabpanel" aria-labelledby="tab-${S.tab}">${renderTab()}</main>
${over ? `<div class="footer-bar"><div class="wrap"><div class="sum"><span>Partie terminée. Score final <b>${fmt(h.score, 2)}</b>.</span></div><div class="row"><button class="btn ghost" data-act="replay">Rejouer cette graine</button><button class="btn primary" data-act="new">Nouvelle partie</button></div></div></div>`
        : `<div class="footer-bar"><div class="wrap"><div class="sum" id="sum"></div><div class="row"><button class="btn ghost" data-act="reset" title="Revenir aux décisions par défaut">Annuler</button><button class="btn seal" id="validate" data-act="validate">Valider l'exercice ${yearOf(t)}</button></div></div></div>`}
${S.result ? renderSheet() : ""}`;
    if (!over) updateDerived();
    tickTimer();
  }

  function renderTab() {
    switch (S.tab) {
      case "conseil": return tabConseil();
      case "divisions": return tabDivisions();
      case "marches": return tabMarches();
      case "matrice": return tabMatrice();
      case "comptes": return tabComptes();
      case "rivaux": return tabRivaux();
      case "journal": return tabJournal();
      case "regles": return tabRegles();
      case "bilan": return tabBilan();
    }
    return "";
  }

  /* ---------------- Séance du conseil ---------------- */
  function tabConseil() {
    const G = S.G, co = player(), h = lastH(co), p = G.params, d = S.draft, t = G.year + 1;
    const news = G.news.length ? G.news.map(n => `<div class="news-item"><div class="eyebrow">${esc(n.kind)}</div><p>${esc(n.text)}</p></div>`).join("")
      : `<div class="news-item"><div class="eyebrow">Conjoncture</div><p>Aucun fait marquant annoncé pour cet exercice.</p></div>`;
    const own = Object.keys(co.div).sort((a, b) => (co.div[b].rev || 0) - (co.div[a].rev || 0));
    const others = G.segments.filter(s => !co.div[s.id]);
    return `
<section class="section">
  <div class="section-head"><h2>Ordre du jour</h2><span class="muted small">Comptes de l'exercice ${yearOf(G.year)}</span></div>
  <div class="news">${news}</div>
  <p class="small muted">Régulateur : taux directeur ${pct(p.rate, 1)} · endettement plafonné à ${fmt(p.maxDE, 1)} × fonds propres et ${fmt(p.ebitdaMult)} × EBITDA · dilution maximale ${pct(p.maxDil, 0)} par an · seuil de position dominante ${pct(p.cap, 0)}.</p>
  <div class="statgrid">
    ${stat("Chiffre d'affaires", M(h.rev))}${stat("Résultat net courant", M(h.npRec), h.npRec < 0 ? "bad" : "")}
    ${stat("Autofinancement (RN + amort.)", M(h.npRec + h.dep))}${stat("Trésorerie", M(co.cash), co.cash < 0 ? "bad" : "")}
    ${stat("Dette bancaire", M(co.loan ? co.loan.out : 0))}${stat("Découvert autorisé", M(p.overdraft * Math.max(h.rev, 0.5 * co.hist[0].rev)))}
  </div>
</section>
<section class="section">
  <div class="section-head"><h2>Allocation des ressources</h2><span class="muted small">Montants en M€ ; « maintien » compense l'usure des actifs</span></div>
  <div class="cards">${own.map(sid => divCard(co, sid)).join("") || '<p class="muted">Vous n\'avez plus aucune division.</p>'}</div>
</section>
<section class="section">
  <div class="section-head"><h2>Entrer sur un créneau</h2><span class="muted small">Un entrant part avec peu d'expérience, donc des coûts élevés</span></div>
  <div class="entry-list">${others.map(s => entryRow(co, s)).join("") || '<p class="muted">Vous êtes présent sur tous les créneaux.</p>'}</div>
</section>
<section class="section">
  <div class="section-head"><h2>Financement</h2></div>
  <div class="fin-grid">${payoutPanel(co, h)}${loanPanel(co, h)}${capitalPanel(co, h)}</div>
</section>
<section class="section">
  <div class="section-head"><h2>Croissance externe</h2><span class="muted small">Offres examinées à la clôture ; la meilleure offre au-dessus du prix minimal l'emporte</span></div>
  ${listingsBlock(co)}
</section>`;
  }
  const stat = (k, v, cls) => `<div class="stat"><span class="k">${k}</span><span class="v ${cls || ""}">${v}</span></div>`;

  function divCard(co, sid) {
    const G = S.G, d = co.div[sid], seg = segOf(sid), p = G.params, dr = S.draft;
    const hint = E.investHints(G, co, sid);
    const q = quadOf(co, sid);
    const dv = dr.divest[sid] || { mode: "" };
    const listed = hasListing(co, sid);
    const margin = d.rev > 0 ? d.ebit / d.rev : 0;
    const cur = dr.invest[sid] != null ? dr.invest[sid] : 0;
    const dis = (dr.disinvest || {})[sid] || 0;
    const canDis = !listed && !dv.mode;
    const dq = (f, label) => `<button type="button" data-act="dq" data-sid="${sid}" data-f="${f}">${label} <span class="num">${fmt(f * d.A)}</span></button>`;
    const dRate = E.disinvestRate(G, seg);
    const dominant = d.share >= p.cap;
    const qb = (k, label, v) => `<button type="button" class="${S.q[sid] === k ? "on" : ""}" data-act="q" data-sid="${sid}" data-k="${k}" data-v="${v}">${label} <span class="num">${fmt(v)}</span></button>`;
    return `
<article class="seg-card q-${q} ${listed ? "selling" : ""}" data-sid="${sid}">
  <header><h3>${esc(seg.name)}</h3><span class="qpill">${QUAD[q]}</span></header>
  <dl class="facts">
    <div><dt>Croissance prévue</dt><dd class="${hint.gF < 0 ? "bad" : ""}">${pct(hint.gF)}</dd></div>
    <div><dt>Part de marché</dt><dd>${pct(d.share)}</dd></div>
    <div><dt>Part relative</dt><dd>${fmt(d.rs, 2)}×</dd></div>
    <div><dt>Chiffre d'affaires</dt><dd>${M(d.rev)}</dd></div>
    <div><dt>Marge opérationnelle</dt><dd class="${margin < 0 ? "bad" : ""}">${pct(margin)}</dd></div>
    <div><dt>Offre / demande</dt><dd>${fmt(seg.r, 2)}</dd></div>
  </dl>
  ${listed ? `<p class="small"><b>En vente.</b> Les offres seront examinées à la clôture de cet exercice.</p>` : ""}
  ${dominant ? `<p class="small warn">Position dominante (${pct(d.share)}) : l'investissement est plafonné au maintien.</p>` : ""}
  <div class="inv">
    <div class="inv-line"><label for="inv-${sid}">Investissement de l'exercice</label><input id="inv-${sid}" type="number" min="0" step="1" inputmode="decimal" data-k="inv" data-sid="${sid}" value="${Math.round(cur)}" ${dv.mode === "liq" || dis > 0 ? "disabled" : ""}></div>
    <div class="quick">${qb("zero", "Rien", 0)}${qb("maint", "Maintien", hint.maint)}${qb("follow", "Suivre le marché", hint.follow)}${qb("plus5", "+5 pts de part", hint.plus5)}</div>
    ${canDis ? `<div class="inv-line"><label for="dis-${sid}">Désinvestir (actifs cédés, M€)</label><input id="dis-${sid}" type="number" min="0" max="${Math.floor(p.maxDisinv * d.A)}" step="1" inputmode="decimal" data-k="dis" data-sid="${sid}" value="${Math.round(dis)}"></div>
    <div class="quick">${dq(0.25, "25 %")}${dq(p.maxDisinv, "Maximum " + pct(p.maxDisinv, 0))}${dis > 0 ? `<button type="button" data-act="dq" data-sid="${sid}" data-f="0">Annuler</button>` : ""}</div>
    <p class="small muted">Actifs repris à ${pct(dRate, 0)} de leur valeur${dRate < p.disRecov ? " (décote aggravée par la surcapacité du créneau)" : ""}.</p>` : ""}
    <p class="effect" id="eff-${sid}"></p>
  </div>
  ${listed ? "" : `<div class="dv">
    <div class="field"><label for="dv-${sid}">Portefeuille</label><select id="dv-${sid}" data-k="dvmode" data-sid="${sid}">
      <option value="" ${!dv.mode ? "selected" : ""}>Conserver</option>
      <option value="auction" ${dv.mode === "auction" ? "selected" : ""}>Mettre en vente</option>
      <option value="liq" ${dv.mode === "liq" ? "selected" : ""}>Fermer (${pct(p.recov, 0)} des actifs)</option></select></div>
    ${dv.mode === "auction" ? `<div class="field"><label for="dvmin-${sid}">Prix minimal (M€)</label><input id="dvmin-${sid}" type="number" min="0" step="1" inputmode="decimal" data-k="dvmin" data-sid="${sid}" value="${Math.round(dv.min || 0)}"></div>`
          : `<div class="field"><label>Valeur des actifs</label><div class="num" style="padding:9px 0">${M(d.A)}</div></div>`}
  </div>`}
</article>`;
  }

  function entryRow(co, seg) {
    const G = S.G, hint = E.investHints(G, co, seg.id);
    const players = G.companies.filter(c => c.alive && c.div[seg.id]);
    const lead = players.reduce((m, c) => Math.max(m, c.div[seg.id].share), 0);
    const mkt = E.sum(players, c => c.div[seg.id].rev || 0);
    const cur = S.draft.invest[seg.id] || 0;
    return `<div class="entry">
  <div><b>${esc(seg.name)}</b><div class="meta">Marché ${M(mkt)} · croissance prévue <span class="${hint.gF < 0 ? "bad" : ""}">${pct(hint.gF)}</span> · ${players.length} acteur${players.length > 1 ? "s" : ""} · leader ${pct(lead, 0)} · offre/demande ${fmt(seg.r, 2)}</div>
  <div class="quick" style="margin-top:6px"><button type="button" data-act="q" data-sid="${seg.id}" data-k="entry" data-v="${hint.entry}" class="${S.q[seg.id] === "entry" ? "on" : ""}">Ticket pour 8 % du marché <span class="num">${fmt(hint.entry)}</span></button>${cur > 0 ? `<button type="button" data-act="q" data-sid="${seg.id}" data-k="zero" data-v="0">Annuler</button>` : ""}</div></div>
  <div class="field"><label for="inv-${seg.id}">Investir (M€)</label><input id="inv-${seg.id}" type="number" min="0" step="1" inputmode="decimal" data-k="inv" data-sid="${seg.id}" value="${Math.round(cur)}"></div>
</div>`;
  }

  function payoutPanel(co, h) {
    const d = S.draft;
    return `<div class="panel">
  <div class="slider-head"><label for="payout"><b>Dividende</b></label><b id="payout-v">${pct(d.payout, 0)}</b></div>
  <input id="payout" type="range" min="0" max="100" step="5" value="${Math.round(d.payout * 100)}" data-k="payout">
  <p class="small muted">Part du résultat net courant de l'exercice versée aux actionnaires. Les dividendes cumulés entrent dans le score à hauteur de ce qu'ils retirent de la trésorerie : distribuer n'est payant que si l'argent ne trouve pas de meilleur emploi.</p>
  <div class="kv"><span>Dividende indicatif (sur RN ${yearOf(S.G.year)})</span><span class="num" id="payout-amt"></span></div>
</div>`;
  }

  function loanPanel(co, h) {
    const G = S.G, p = G.params;
    if (co.loan) {
      const l = co.loan;
      return `<div class="panel"><b>Emprunt bancaire</b>
  <div class="kv"><span>Encours</span><span class="num">${M(l.out)}</span></div>
  <div class="kv"><span>Taux fixe</span><span class="num">${pct(l.rate, 2)}</span></div>
  <div class="kv"><span>Échéances restantes</span><span class="num">${l.left} an${l.left > 1 ? "s" : ""}</span></div>
  <div class="kv"><span>Remboursement de l'exercice</span><span class="num">${M(Math.min(l.ann, l.out))} + intérêts ${M(l.out * l.rate)}</span></div>
  <p class="small muted">La banque n'accorde un nouvel emprunt qu'une fois celui-ci entièrement remboursé.</p></div>`;
    }
    const ml = E.maxLoan(G, co);
    if (ml < 1) return `<div class="panel"><b>Emprunt bancaire</b><p class="small">La banque refuse tout nouvel emprunt : EBITDA ou fonds propres insuffisants.</p></div>`;
    const l = S.draft.loan || { amount: 0, years: 5 };
    return `<div class="panel"><b>Emprunt bancaire</b>
  <div class="kv"><span>Montant maximal accordé</span><span class="num">${M(ml)}</span></div>
  <div class="inv-line"><label for="loan-amt">Montant demandé (M€)</label><input id="loan-amt" type="number" min="0" max="${Math.floor(ml)}" step="1" inputmode="decimal" data-k="loanAmt" value="${Math.round(l.amount || 0)}"></div>
  <div class="inv-line"><label for="loan-yrs">Durée</label><select id="loan-yrs" data-k="loanYears">${Array.from({ length: p.maxLoanYears - 1 }, (_, i) => i + 2).map(n => `<option value="${n}" ${n === (l.years || 5) ? "selected" : ""}>${n} ans</option>`).join("")}</select></div>
  <div class="kv"><span>Taux proposé</span><span class="num" id="loan-rate">—</span></div>
  <div class="kv"><span>Total à rembourser</span><span class="num" id="loan-tot">—</span></div>
  <p class="small muted">Fonds versés à la clôture de l'exercice, disponibles pour le suivant. Remboursement linéaire, intérêts sur l'encours. Une seule ligne à la fois.</p></div>`;
  }

  function capitalPanel(co, h) {
    const p = S.G.params, d = S.draft;
    return `<div class="panel"><b>Capital</b>
  <div class="slider-head"><label for="issue">Augmentation de capital</label><b id="issue-v">${pct(d.issuePct, 0)}</b></div>
  <input id="issue" type="range" min="0" max="${Math.round(p.maxDil * 100)}" step="1" value="${Math.round(d.issuePct * 100)}" data-k="issue">
  <div class="kv"><span>Fonds levés (décote ${pct(p.issueDisc, 0)})</span><span class="num" id="issue-amt"></span></div>
  <div class="slider-head"><label for="buyback">Rachat d'actions</label><b id="buyback-v">${pct(d.buybackPct, 0)}</b></div>
  <input id="buyback" type="range" min="0" max="${Math.round(p.maxBuyback * 100)}" step="1" value="${Math.round(d.buybackPct * 100)}" data-k="buyback">
  <div class="kv"><span>Coût (prime de 5 %)</span><span class="num" id="buyback-amt"></span></div>
  <p class="small muted">L'émission apporte du cash immédiatement mais dilue le cours (décote). Le rachat coûte une prime : il ne crée pas de valeur, il rend de la trésorerie sans utilité. Cours de référence : ${EUR(h.price)} · ${fmt(co.shares, 1)} M d'actions.</p></div>`;
  }

  function listingsBlock(co) {
    const G = S.G, p = G.params;
    const mine = G.listings.filter(l => l.seller === co.id);
    const theirs = G.listings.filter(l => l.seller !== co.id && E.coById(G, l.seller).alive && E.coById(G, l.seller).div[l.seg]);
    let html = "";
    mine.forEach(l => { html += `<div class="news-item"><div class="eyebrow">Votre cession</div><p>« ${esc(segOf(l.seg).name)} » est en vente avec un prix minimal de ${M(l.minPrice)}. Résultat à la clôture.</p></div>`; });
    if (!theirs.length) html += `<p class="muted small">Aucune division concurrente n'est à vendre actuellement.</p>`;
    else html += `<div class="cards">${theirs.map(l => {
      const seller = E.coById(G, l.seller), d = seller.div[l.seg], seg = segOf(l.seg);
      const own = co.div[l.seg];
      const comb = (own ? own.share : 0) + d.share;
      const blocked = comb > p.cap;
      const margin = d.rev > 0 ? d.ebit / d.rev : 0;
      return `<article class="seg-card"><header><h3>${esc(seg.name)}</h3><span class="chip">${esc(seller.name)}</span></header>
        <dl class="facts"><div><dt>Part</dt><dd>${pct(d.share)}</dd></div><div><dt>Marge op.</dt><dd class="${margin < 0 ? "bad" : ""}">${pct(margin)}</dd></div><div><dt>Actifs</dt><dd>${M(d.A)}</dd></div>
        <div><dt>Prix minimal</dt><dd>${M(l.minPrice)}</dd></div><div><dt>Croissance</dt><dd>${pct(seg.g)}</dd></div><div><dt>Part cumulée</dt><dd class="${blocked ? "bad" : ""}">${pct(comb)}</dd></div></dl>
        ${blocked ? `<p class="small bad">Rachat interdit : la part cumulée dépasserait le seuil de ${pct(p.cap, 0)}.</p>` : `<div class="inv-line"><label for="bid-${l.id}">Votre offre (M€)</label><input id="bid-${l.id}" type="number" min="0" step="1" inputmode="decimal" data-k="bid" data-lid="${l.id}" value="${Math.round(S.draft.bids[l.id] || 0)}"></div>
        <p class="small muted">L'offre est débitée à la clôture si elle l'emporte. Les actifs rejoignent votre division du même créneau, avec leur expérience.</p>`}
      </article>`;
    }).join("")}</div>`;
    return html;
  }

  /* ---------------- valeurs dérivées (sans re-rendu) ---------------- */
  function setText(id, txt, cls) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = txt;
    if (cls != null) el.className = cls;
  }
  function updateDerived() {
    const G = S.G, co = player(), h = lastH(co), d = S.draft, p = G.params;
    if (!d) return;
    // effets par division
    for (const sid in co.div) {
      const dv = co.div[sid], seg = segOf(sid);
      const dis = disAssets(co, sid, +((d.disinvest || {})[sid]) || 0);
      const inv = dis > 0 ? 0 : (+d.invest[sid] || 0);
      const K1 = ((dv.A - dis) * (1 - seg.dep) + inv) / seg.capex;
      const share = K1 / Math.max(1e-9, seg.S - dv.K + K1);
      const c = E.unitCost(G, co, seg);
      setText("eff-" + sid, (dis > 0 ? `Trésorerie récupérée ${M(disCash(co, sid, dis))} (moins-value ${M(dis - disCash(co, sid, dis))}) · ` : "") + `Capacité ${fmt(dv.K)} → ${fmt(K1)} (${sign(K1 / Math.max(1e-9, dv.K) - 1, x => pct(x, 0))}) · part potentielle ≈ ${pct(share, 0)} · coût unitaire ${fmt(c, 3)} pour un prix de ${fmt(seg.P, 3)}`);
    }
    setText("payout-v", pct(d.payout, 0));
    setText("payout-amt", M(d.payout * Math.max(0, h.npRec)));
    if (!co.loan) {
      const ml = E.maxLoan(G, co);
      const amt = d.loan ? Math.min(+d.loan.amount || 0, ml) : 0;
      const yrs = d.loan ? d.loan.years : 5;
      if (amt > 0) {
        const r = E.loanRate(G, co, amt);
        setText("loan-rate", pct(r, 2));
        setText("loan-tot", M(E.loanTotal(amt, r, yrs)) + " sur " + yrs + " ans");
      } else { setText("loan-rate", pct(E.loanRate(G, co, Math.max(1, ml * 0.5)), 2) + " (indicatif)"); setText("loan-tot", "—"); }
    }
    const est = estimate();
    setText("issue-v", pct(d.issuePct, 0)); setText("issue-amt", M(est.issue));
    setText("buyback-v", pct(d.buybackPct, 0)); setText("buyback-amt", M(est.buy));
    const sum = document.getElementById("sum");
    if (sum) {
      const msg = est.lvl === "bad" ? "Risque de cessation de paiements" : est.lvl === "warn" ? "Découvert utilisé" : "Trésorerie positive";
      sum.innerHTML = `<span>Investissements <b>${M(est.inv)}</b></span>${est.dis > 0 ? `<span>Désinvestissements <b>${M(est.dis)}</b></span>` : ""}<span><i class="sig ${est.lvl === "good" ? "" : est.lvl}"></i>Trésorerie fin ${yearOf(G.year + 1)} estimée <b class="${est.lvl === "good" ? "" : est.lvl}">${M(est.end)}</b></span><span class="muted">${msg} · découvert autorisé ${M(est.limit)}</span>`;
    }
    const btn = document.getElementById("validate");
    if (btn) btn.textContent = S.confirmRisk ? "Confirmer malgré le risque" : "Valider l'exercice " + yearOf(G.year + 1);
    // surbrillance des boutons rapides
    document.querySelectorAll('.quick button[data-act="q"]').forEach(b => b.classList.toggle("on", S.q[b.dataset.sid] === b.dataset.k));
  }

  /* ---------------- Divisions ---------------- */
  function tabDivisions() {
    const co = player();
    const ids = Object.keys(co.div).sort((a, b) => (co.div[b].rev || 0) - (co.div[a].rev || 0));
    if (!ids.length) return `<p class="muted">Aucune division.</p>`;
    const rows = ids.map(sid => {
      const d = co.div[sid], seg = segOf(sid), m = d.rev > 0 ? d.ebit / d.rev : 0, roce = d.A > 0 ? d.ebit / d.A : 0;
      const sh = d.hist.map(x => x.share);
      return `<tr><td>${esc(seg.name)}</td><td>${M(d.rev)}</td><td>${pct(d.share)} ${spark(sh, co.color)}</td><td>${fmt(d.rs, 2)}×</td><td class="${seg.g < 0 ? "bad" : ""}">${pct(seg.g)}</td>
        <td>${fmt(seg.r, 2)}</td><td>${fmt(seg.P, 3)}</td><td>${fmt(d.c, 3)}</td><td class="${m < 0 ? "bad" : ""}">${pct(m)}</td><td class="${roce < 0 ? "bad" : ""}">${pct(roce)}</td>
        <td>${fmt(d.K)}</td><td>${pct(seg.u, 0)}</td><td>${M(d.A)}</td><td>${M(d.inv || 0)}</td><td>${QUAD[quadOf(co, sid)]}</td></tr>`;
    }).join("");
    return `<section class="section"><div class="section-head"><h2>Vos divisions</h2><span class="muted small">Exercice ${yearOf(S.G.year)}</span></div>
<div class="tbl-wrap"><table><thead><tr><th>Division</th><th>CA</th><th>Part</th><th>Part relative</th><th>Croissance</th><th>Offre/dem.</th><th>Prix unit.</th><th>Coût unit.</th><th>Marge op.</th><th>ROCE</th><th>Capacité</th><th>Utilisation</th><th>Actifs</th><th>Investi</th><th>Position</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="small muted">Le coût unitaire baisse avec la production cumulée (courbe d'expérience) ; le prix suit le coût moyen du secteur et l'équilibre offre/demande. Une part relative supérieure à 1 signifie que vous êtes leader.</p></section>`;
  }

  /* ---------------- Marchés ---------------- */
  function tabMarches() {
    const G = S.G;
    return `<section class="section"><div class="section-head"><h2>Les créneaux</h2><span class="muted small">Indices base 100 au départ</span></div>
<div class="mk-grid">${G.segments.map(seg => {
      const pl = G.companies.filter(c => c.alive && c.div[seg.id]).sort((a, b) => b.div[seg.id].share - a.div[seg.id].share);
      const mkt = E.sum(pl, c => c.div[seg.id].rev || 0);
      const P0 = seg.hist[0].P, D0 = seg.hist[0].D;
      const chart = lineChart([
        { label: "Demande", color: "var(--ink)", pts: seg.hist.map(x => [yearOf(x.t), 100 * x.D / D0]) },
        { label: "Prix", color: "var(--brass)", pts: seg.hist.map(x => [yearOf(x.t), 100 * x.P / P0]), dash: true }
      ], { h: 170, aria: "Évolution de la demande et du prix, " + seg.name, fx: x => String(x).slice(2) });
      return `<article class="mk">
  <header class="row" style="justify-content:space-between"><h3>${esc(seg.name)}</h3>${sdFlag(seg.r)}</header>
  <dl class="facts"><div><dt>Marché</dt><dd>${M(mkt)}</dd></div><div><dt>Croissance</dt><dd class="${seg.g < 0 ? "bad" : ""}">${pct(seg.g)}</dd></div><div><dt>Prévision</dt><dd>${pct(E.forecastGrowth(G, seg, G.year + 1))}</dd></div>
  <div><dt>Offre / demande</dt><dd>${fmt(seg.r, 2)}</dd></div><div><dt>PER du secteur</dt><dd>${fmt(E.segPER(seg), 1)}</dd></div><div><dt>Intensité capitalistique</dt><dd>${fmt(seg.capex, 1)}</dd></div></dl>
  <div class="sharebar" role="img" aria-label="Parts de marché">${pl.map(c => `<span style="width:${(c.div[seg.id].share * 100).toFixed(2)}%;background:${c.color}" title="${esc(c.name)} ${pct(c.div[seg.id].share)}"></span>`).join("")}</div>
  <div class="legend">${pl.map(c => `<span class="${c.player ? "" : "muted"}"><i class="dot" style="background:${c.color}"></i>${esc(c.name)} ${pct(c.div[seg.id].share, 0)}</span>`).join("")}</div>
  ${chart}
</article>`;
    }).join("")}</div></section>`;
  }

  /* ---------------- Matrice ---------------- */
  function tabMatrice() {
    const G = S.G;
    let co = E.coById(G, S.matrixCo);
    if (!co || !co.alive) { co = player(); S.matrixCo = co.id; }
    const rows = Object.keys(co.div).map(sid => {
      const d = co.div[sid], seg = segOf(sid);
      return `<tr><td><i class="dot" style="background:${co.color}"></i>${esc(seg.name)}</td><td>${fmt(d.rs, 2)}×</td><td>${pct(E.forecastGrowth(G, seg, G.year + 1))}</td><td>${M(d.rev)}</td><td>${QUAD[quadOf(co, sid)]}</td></tr>`;
    }).join("");
    return `<section class="section"><div class="section-head"><h2>Matrice part de marché / croissance</h2><span class="muted small">Exercice ${yearOf(G.year)} · taille des bulles proportionnelle au CA</span></div>
<div class="co-pick" role="group" aria-label="Société affichée">${G.companies.filter(c => c.alive).map(c => `<button data-act="mco" data-id="${c.id}" aria-pressed="${c.id === co.id}"><i class="dot" style="background:${c.color}"></i>${esc(c.name)}</button>`).join("")}</div>
<div class="matrix-panel">${bcgChart(co)}</div>
<div class="tbl-wrap"><table><thead><tr><th>Division</th><th>Part relative</th><th>Croissance prévue</th><th>CA</th><th>Position</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="small muted">Ordonnée : croissance prévue pour le prochain exercice ; seuil ${pct(G.params.bcgG, 0)}. Les vedettes demandent du cash pour suivre le marché ; les vaches à lait en dégagent ; les dilemmes exigent un choix entre investir massivement ou sortir ; les poids morts consomment des ressources sans perspective.</p></section>`;
  }

  /* ---------------- Comptes ---------------- */
  function tabComptes() {
    const co = player(), H = co.hist;
    const lines = [
      ["Chiffre d'affaires", x => M(x.rev)], ["Résultat opérationnel", x => M(x.ebit), x => x.ebit < 0],
      ["Marge opérationnelle", x => pct(x.rev ? x.ebit / x.rev : 0), null, true], ["Charges financières nettes", x => M(x.intInc - x.interest)],
      ["Impôt", x => M(-x.tax)], ["Résultat net courant", x => M(x.npRec), x => x.npRec < 0], ["Résultat exceptionnel", x => M(x.exc), x => x.exc < 0],
      ["Dividendes versés", x => M(x.dividends)], ["Investissements", x => M(x.inv)], ["Désinvestissements d'actifs", x => M(x.disinv || 0)], ["Cessions / acquisitions", x => M(x.ma || 0)],
      ["Émission / rachat d'actions", x => M((x.issue || 0) - (x.buyback || 0))], ["Trésorerie de clôture", x => M(x.cash), x => x.cash < 0],
      ["Dette bancaire", x => M(x.debt)], ["Fonds propres", x => M(x.equity)], ["PER retenu", x => fmt(x.PER, 1), null, true], ["Valeur de la société", x => M(x.value)],
      ["Nombre d'actions (M)", x => fmt(x.shares, 1), null, true], ["Cours", x => EUR(x.price)], ["Dividende par action", x => EUR(x.dps)], ["Score", x => fmt(x.score, 2)]
    ];
    const head = H.map(x => `<th>${yearOf(x.t)}</th>`).join("");
    const body = lines.map(([l, f, bad, sub]) => `<tr><td class="${sub ? "sub" : ""}">${l}</td>${H.map(x => `<td class="${bad && bad(x) ? "bad" : ""} ${sub ? "sub" : ""}">${f(x)}</td>`).join("")}</tr>`).join("");
    const chart = lineChart([
      { label: "Score", color: co.color, w: 2.6, pts: H.map(x => [yearOf(x.t), x.score]) },
      { label: "Cours", color: "var(--muted)", dash: true, pts: H.map(x => [yearOf(x.t), x.price]) }
    ], { aria: "Évolution du score et du cours", fy: v => fmt(v, 0) });
    return `<section class="section"><div class="section-head"><h2>Comptes consolidés</h2><span class="muted small">M€ sauf mention ; ${esc(yearOf(0))} = situation de départ</span></div>
<div class="panel">${chart}</div>
<div class="tbl-wrap"><table><thead><tr><th>Poste</th>${head}</tr></thead><tbody>${body}</tbody></table></div></section>`;
  }

  /* ---------------- Concurrents ---------------- */
  function tabRivaux() {
    const G = S.G;
    const list = G.companies.slice().sort((a, b) => lastH(b).score - lastH(a).score);
    const rows = list.map((c, i) => {
      const h = lastH(c), m = h.rev ? h.ebit / h.rev : 0, de = h.equity > 0 ? h.debt / h.equity : 0;
      return `<tr class="${c.player ? "me" : ""} ${c.alive ? "" : "dead"}"><td>${i + 1}. <i class="dot" style="background:${c.color}"></i>${esc(c.name)}</td><td>${fmt(h.score, 2)}</td><td>${EUR(h.price)}</td><td>${EUR(E.sum(c.dps))}</td>
      <td>${M(h.rev)}</td><td class="${h.npRec < 0 ? "bad" : ""}">${M(h.npRec)}</td><td>${pct(m)}</td><td>${M(h.cash)}</td><td>${fmt(de, 2)}</td><td>${Object.keys(c.div).length}</td><td>${c.alive ? "" : "Faillite " + yearOf(c.bankrupt)}</td></tr>`;
    }).join("");
    const chart = lineChart(G.companies.map(c => ({ label: c.name.split(" ")[0], color: c.color, w: c.player ? 2.8 : 1.6, pts: c.hist.map(x => [yearOf(x.t), x.score]) })), { aria: "Évolution des scores", h: 260, fy: v => fmt(v, 0) });
    return `<section class="section"><div class="section-head"><h2>Classement</h2><span class="muted small">Score = cours + dividendes cumulés par action</span></div>
<div class="tbl-wrap"><table><thead><tr><th>Société</th><th>Score</th><th>Cours</th><th>Div. cumulés</th><th>CA</th><th>RN courant</th><th>Marge op.</th><th>Trésorerie</th><th>Dette / FP</th><th>Divisions</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="panel">${chart}</div>
<p class="small muted">Les concurrents sont pilotés par des stratégies différentes, révélées au bilan final. Observez leurs investissements dans l'onglet Marchés pour anticiper les surcapacités.</p></section>`;
  }

  /* ---------------- Journal ---------------- */
  function tabJournal() {
    const G = S.G, by = {};
    G.log.forEach(e => { (by[e.t] = by[e.t] || []).push(e); });
    const ts = Object.keys(by).map(Number).sort((a, b) => b - a);
    return `<section class="section"><div class="section-head"><h2>Journal des séances</h2></div><div class="log">${ts.map(t => `<div class="log-year"><h3>Exercice ${yearOf(t)}</h3><ul>${by[t].map(e => `<li><span class="eyebrow">${esc(e.kind)}</span> ${esc(e.text)}</li>`).join("")}</ul></div>`).join("") || '<p class="muted">Rien à signaler pour l\'instant.</p>'}</div></section>`;
  }

  /* ---------------- Règles ---------------- */
  function tabRegles() {
    const p = S.G ? S.G.params : { cap: 0.55, overdraft: 0.12, maxDE: 1.5, ebitdaMult: 3, maxDil: 0.2, maxBuyback: 0.1, recov: 0.4, issueDisc: 0.1, disRecov: 0.75, disFloor: 0.5, maxDisinv: 0.5 };
    return `<section class="rules">
<div><h2>Règles du jeu</h2><p class="muted">Le modèle est volontairement simple : il illustre des mécanismes de stratégie, il ne prétend pas reproduire un marché réel.</p></div>
<div><h3>Objectif et score</h3><p>Chaque exercice, le score de chaque société vaut son cours de bourse plus les dividendes par action versés depuis le premier exercice : c'est ce qu'a gagné un actionnaire présent depuis le début. Toutes les sociétés démarrent à 10,00 €.</p>
<p class="formula">score = cours + dividendes cumulés par action</p>
<p class="formula">valeur = Σ divisions max(PER × résultat opérationnel normatif après impôt ; plancher × actifs) + trésorerie − dette</p>
<p>Le marché valorise chaque division séparément. Son PER va de 10 à 45 selon la croissance du créneau sur les trois derniers exercices, avec une prime pour certains métiers peu cycliques. Le résultat normatif est la moyenne des deux derniers exercices. Une division peu ou pas rentable vaut au moins une fraction de ses actifs : de 40 % dans un créneau stagnant ou en déclin à 100 % dans un créneau en forte croissance, car des capacités installées sur un marché porteur ont une valeur même avant d'être rentables. La trésorerie compte pour sa valeur, la dette en moins : distribuer ou thésauriser ne change pas le score, investir le change selon ce que l'investissement rapporte. Cours = valeur ÷ nombre d'actions.</p></div>
<div><h3>Marchés et prix</h3><ul>
<li>Chaque créneau suit un cycle de vie (émergence, croissance, maturité, déclin), perturbé par la conjoncture et des événements annoncés en début d'exercice.</li>
<li>La capacité d'une division vaut ses actifs divisés par l'intensité capitalistique du créneau. Les actifs s'usent de 5 à 15 % par an : sans investissement, la capacité décroît.</li>
<li>En surcapacité, chacun vend au prorata de sa capacité et le prix baisse. En pénurie, chacun vend toute sa capacité et le prix monte.</li></ul>
<p class="formula">prix = (coût moyen du secteur + amortissement unitaire) × (1 + marge du secteur) × (offre ÷ demande)<sup>−ε</sup></p></div>
<div><h3>Courbe d'expérience</h3><p>Le coût unitaire d'une division baisse d'un pourcentage fixe (15 à 28 % selon le créneau) à chaque doublement de sa production cumulée. Le leader, qui a produit le plus, a les coûts les plus bas : la part de marché relative se traduit en marge. Une division bénéficie aussi d'un quart de l'expérience des autres divisions du groupe dans le même métier. Un entrant démarre avec une expérience réduite, donc des coûts élevés tant qu'il n'a pas pris de volume.</p></div>
<div><h3>Décisions annuelles</h3><ul>
<li><b>Investissements</b> par division, et entrée sur de nouveaux créneaux. La capacité est disponible dès l'exercice.</li>
<li><b>Dividende</b> : part du résultat net courant distribuée.</li>
<li><b>Emprunt</b> : une ligne à la fois, plafonnée à ${fmt(p.ebitdaMult)} × EBITDA et ${fmt(p.maxDE, 1)} × fonds propres. Taux = taux directeur + 1,5 point + prime de levier. Fonds versés à la clôture, remboursement linéaire.</li>
<li><b>Capital</b> : augmentation jusqu'à ${pct(p.maxDil, 0)} des actions par an, avec une décote de ${pct(p.issueDisc, 0)} ; rachat jusqu'à ${pct(p.maxBuyback, 0)}, avec une prime de 5 %.</li>
<li><b>Désinvestissement</b> : cession d'une partie des actifs d'une division, au plus ${pct(p.maxDisinv, 0)} par exercice, reprise à ${pct(p.disRecov, 0)} de sa valeur comptable (jusqu'à ${pct(p.disFloor, 0)} seulement quand le créneau est en surcapacité). La moins-value passe en résultat exceptionnel. La capacité baisse d'autant, l'expérience acquise est conservée. Pour sortir d'un coup, il faut vendre ou fermer la division.</li>
<li><b>Cessions de division</b> : mise en vente avec un prix minimal (offres examinées l'année suivante) ou fermeture immédiate qui récupère ${pct(p.recov, 0)} de la valeur des actifs.</li>
<li><b>Acquisitions</b> : offres sur les divisions mises en vente par les concurrents. La division achetée fusionne avec la vôtre, actifs et expérience compris.</li></ul></div>
<div><h3>Régulation et risques</h3><ul>
<li>Au-delà du seuil de position dominante (${pct(p.cap, 0)} ici), l'investissement d'une division est limité au maintien de ses actifs, tout rachat qui ferait franchir ce seuil est interdit, et ses tarifs sont régulés : en pénurie, elle vend au prix d'équilibre, sans la hausse dont profitent ses concurrents.</li>
<li>Le banquier accorde un découvert d'environ ${pct(p.overdraft, 0)} du chiffre d'affaires. Si la trésorerie de clôture passe en dessous, la société est en cessation de paiements : la partie s'arrête.</li>
<li>La banque centrale fait évoluer son taux directeur ; les emprunts en cours restent à taux fixe.</li></ul></div>
<div><h3>Concurrents</h3><p>Quatre sociétés pilotées par l'ordinateur, chacune avec sa propre philosophie (défense du métier, conquête de parts, rente, diversification, opportunisme). Elles réagissent aux pénuries, aux surcapacités et aux mises en vente. Leurs profils sont révélés à la fin de la partie.</p></div>
<div><h3>Lire la matrice</h3><p>En abscisse, la part de marché relative (votre part divisée par celle du premier concurrent ; 1 = égalité avec le leader). En ordonnée, la croissance du créneau. Elle sert à équilibrer le portefeuille : les vaches à lait financent les vedettes et les dilemmes que l'on a choisi de transformer en vedettes.</p></div>
</section>`;
  }

  /* ---------------- Bilan final ---------------- */
  function tabBilan() {
    const G = S.G, co = player(), h = lastH(co);
    const list = G.companies.slice().sort((a, b) => lastH(b).score - lastH(a).score);
    const rank = list.indexOf(co) + 1;
    const tsr = (h.price + E.sum(co.dps)) / 10 - 1;
    const years = Math.max(1, G.year);
    const cagr = G.bankrupt ? -1 : Math.pow(Math.max(1e-9, (h.price + E.sum(co.dps)) / 10), 1 / years) - 1;
    const verdict = G.bankrupt ? `Cessation de paiements à l'exercice ${yearOf(co.bankrupt)}. Le tribunal de commerce met fin à votre mandat.`
      : rank === 1 ? `Premier sur ${list.length}. L'assemblée générale renouvelle votre mandat par acclamation.`
        : rank <= 2 ? `Deuxième sur ${list.length}. Les actionnaires saluent une gestion solide.`
          : `${rank}e sur ${list.length}. L'assemblée générale vote contre le renouvellement de votre mandat.`;
    const rows = list.map((c, i) => {
      const hh = lastH(c);
      const prof = c.player ? "Vous" : (E.PERSONAS[c.persona] ? E.PERSONAS[c.persona].label : "");
      return `<tr class="${c.player ? "me" : ""} ${c.alive ? "" : "dead"}"><td>${i + 1}. <i class="dot" style="background:${c.color}"></i>${esc(c.name)}</td><td style="text-align:left">${esc(prof)}</td><td>${fmt(hh.score, 2)}</td><td>${EUR(hh.price)}</td><td>${EUR(E.sum(c.dps))}</td><td>${M(hh.rev)}</td><td>${M(hh.npRec)}</td><td>${c.alive ? "" : "Faillite " + yearOf(c.bankrupt)}</td></tr>`;
    }).join("");
    const byQ = { vedette: 0, vache: 0, dilemme: 0, poids: 0 };
    let entries = 0;
    (G.pinv || []).forEach(x => { byQ[x.quad] += x.inv; if (x.entry) entries++; });
    const totInv = E.sum(Object.values(byQ)) || 1;
    const qbar = Object.keys(byQ).map(k => `<div class="kv"><span>${QUAD[k]}</span><span class="num">${M(byQ[k])} · ${pct(byQ[k] / totInv, 0)}</span></div>`).join("");
    const exits = G.log.filter(e => e.text.indexOf(co.name) === 0 && (/ferme/.test(e.text) || /quitte le créneau/.test(e.text))).length + G.log.filter(e => e.kind === "cession" && e.text.indexOf("à " + co.name + " pour") >= 0).length;
    const chart = lineChart(G.companies.map(c => ({ label: c.name.split(" ")[0], color: c.color, w: c.player ? 2.8 : 1.6, pts: c.hist.map(x => [yearOf(x.t), x.score]) })), { aria: "Évolution des scores", h: 260, fy: v => fmt(v, 0) });
    return `<section class="section podium">
  <div><div class="eyebrow">Assemblée générale de clôture · ${esc(G.title)} · graine ${G.seed}</div><p class="verdict">${verdict}</p></div>
  <div class="statgrid">${stat("Score final", fmt(h.score, 2))}${stat("Rendement total pour l'actionnaire", pct(tsr, 0), tsr < 0 ? "bad" : "good")}${stat("Rendement annuel moyen", pct(cagr, 1), cagr < 0 ? "bad" : "")}${stat("Chiffre d'affaires final", M(h.rev))}${stat("Résultat net courant final", M(h.npRec), h.npRec < 0 ? "bad" : "")}${stat("Dette finale", M(h.debt))}</div>
  <div class="tbl-wrap"><table><thead><tr><th>Société</th><th style="text-align:left">Profil</th><th>Score</th><th>Cours</th><th>Div. cumulés</th><th>CA final</th><th>RN final</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
  <div class="panel">${chart}</div>
  <div class="fin-grid">
    <div class="panel"><b>Où sont allés vos investissements</b>${qbar}<p class="small muted">Position de la division au moment de chaque décision. Total investi : ${M(totInv)} ; ${entries} entrée${entries > 1 ? "s" : ""} sur un nouveau créneau, ${exits} sortie${exits > 1 ? "s" : ""}.</p></div>
    <div class="panel"><b>Profils des concurrents</b>${G.companies.filter(c => !c.player).map(c => `<p class="small"><b>${esc(c.name)}</b> — ${esc(E.PERSONAS[c.persona].label)} : ${esc(E.PERSONAS[c.persona].desc)}</p>`).join("")}</div>
  </div>
</section>`;
  }

  /* ---------------- Feuille de résultats ---------------- */
  function renderSheet() {
    const G = S.G, R = S.result, co = player();
    const h = lastH(co), h0 = co.hist[co.hist.length - 2] || h;
    const dScore = h.score - h0.score;
    const rk = R.ranking;
    const pos = rk.findIndex(x => x.player) + 1;
    const ma = R.ma.filter(m => m.player).map(m => m.buyer ? `${m.buyer} rachète « ${m.seg} » à ${m.seller} pour ${M(m.amt)}.` : null).filter(Boolean);
    const notes = R.notes.concat(ma).concat(R.bankrupt.filter(n => n !== co.name).map(n => `${n} fait faillite : ses capacités quittent le marché.`));
    const nextNews = !G.over ? G.news : [];
    const bankrupt = G.bankrupt;
    return `<div class="sheet-back"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="rs-title">
  <div class="stamp ${S.stampFx ? "fx" : ""}">${bankrupt ? "Cessation<br>de paiements" : "Exercice<br>" + yearOf(R.t) + "<br>clos"}</div>
  <div style="padding-right:110px"><div class="eyebrow">Procès-verbal · exercice ${yearOf(R.t)}</div><h2 id="rs-title">${bankrupt ? "Votre trésorerie a dépassé l'autorisation de découvert" : "Résultats de l'exercice"}</h2></div>
  <div class="row" style="align-items:flex-end;gap:28px">
    <div><div class="muted small">Score</div><div class="big-score">${fmt(h.score, 2)}</div><div class="delta ${dScore >= 0 ? "good" : "bad"}">${sign(dScore, x => fmt(x, 2))} (${sign(h0.score ? dScore / h0.score : 0, x => pct(x, 1))})</div></div>
    <div><div class="muted small">Rang</div><div class="big-score" style="font-size:1.8rem">${pos}<span class="muted" style="font-size:1rem">/${rk.length}</span></div></div>
  </div>
  <div class="statgrid">${stat("Chiffre d'affaires", M(h.rev))}${stat("Résultat opérationnel", M(h.ebit), h.ebit < 0 ? "bad" : "")}${stat("Résultat net", M(h.np), h.np < 0 ? "bad" : "")}${stat("Dividendes", M(h.dividends))}${stat("Investissements", M(h.inv))}${stat("Trésorerie", M(h.cash), h.cash < 0 ? "bad" : "")}${stat("Dette", M(h.debt))}${stat("Cours", EUR(h.price))}</div>
  ${notes.length ? `<div><b>À noter</b><ul class="notes">${notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul></div>` : ""}
  <div><b>Classement</b><div class="rank-list">${rk.map((x, i) => { const c = E.coById(G, x.id); return `<div class="rank-row ${x.player ? "me" : ""}"><span>${i + 1}.</span><span><i class="dot" style="background:${c.color}"></i>${esc(x.name)}${x.alive ? "" : ' <span class="bad small">faillite</span>'}</span><span class="num">${fmt(x.score, 2)}</span></div>`; }).join("")}</div></div>
  ${nextNews.length ? `<div><b>À l'ordre du jour de ${yearOf(G.year + 1)}</b><div class="news" style="margin-top:6px">${nextNews.map(n => `<div class="news-item"><div class="eyebrow">${esc(n.kind)}</div><p>${esc(n.text)}</p></div>`).join("")}</div></div>` : ""}
  <div class="row" style="justify-content:flex-end"><button class="btn primary" data-act="close-sheet" id="close-sheet">${G.over ? "Voir le bilan final" : "Ouvrir l'exercice " + yearOf(G.year + 1)}</button></div>
</div></div>`;
  }

  /* ================================================================
     ACTIONS
     ================================================================ */
  function startGame(opts) {
    clearInterval(timerH); timerH = null;
    const seed = opts.seed ? (Math.abs(parseInt(opts.seed, 10)) >>> 0) || 1 : ((Math.random() * 4294967295) >>> 0) || 7;
    S.G = E.newGame(opts.scenario, { seed, years: opts.years, playerName: (opts.name || "").trim() || undefined });
    S.draft = freshDraft();
    S.tab = "conseil"; S.result = null; S.matrixCo = "P";
    openYear();
    save();
    render();
    window.scrollTo(0, 0);
  }
  function openYear() { S.deadline = S.sel.timer ? Date.now() + S.sel.timer * 1000 : 0; }

  /* Temps écoulé sur une décision qui mène à la cessation de paiements : le directeur
     financier annule les offres de rachat puis réduit les investissements au prorata. */
  function cfoTrim() {
    const d = S.draft, notes = [];
    if (Object.keys(d.bids).some(k => d.bids[k] > 0)) { d.bids = {}; notes.push("annulé vos offres de rachat"); }
    let est = estimate();
    if (est.lvl === "bad" && est.inv > 0) {
      // viser une trésorerie de clôture nulle : l'estimation repose sur le résultat de l'an dernier
      const cut = Math.min(est.inv, -est.end);
      const k = Math.max(0, 1 - cut / est.inv);
      for (const sid in d.invest) d.invest[sid] = Math.floor((+d.invest[sid] || 0) * k);
      notes.push("réduit les investissements de " + pct(1 - k, 0));
    }
    return notes.length ? "Temps écoulé : pour éviter la cessation de paiements, le directeur financier a " + notes.join(" et ") + "." : null;
  }

  function validate(force) {
    if (!S.G || S.G.over || S.result) return;
    const est = estimate();
    if (est.lvl === "bad" && !S.confirmRisk && !force) { S.confirmRisk = true; updateDerived(); return; }
    const cfo = force && est.lvl === "bad" ? cfoTrim() : null;
    const dec = JSON.parse(JSON.stringify(S.draft));
    if (dec.loan && !(dec.loan.amount > 0)) dec.loan = null;
    const R = E.simulateYear(S.G, dec);
    if (cfo) R.notes.unshift(cfo);
    S.result = R; S.stampFx = true; S.deadline = 0;
    if (!S.G.over) S.draft = freshDraft();
    save();
    render();
    S.stampFx = false;
    const b = document.getElementById("close-sheet");
    if (b) b.focus({ preventScroll: true });
    const sh = document.querySelector(".sheet");
    if (sh) sh.scrollTop = 0;
  }

  let timerH = null;
  function tickTimer() {
    if (timerH) { clearInterval(timerH); timerH = null; }
    if (!S.G || S.G.over || !S.sel.timer || S.result) return;
    const upd = () => {
      const left = Math.max(0, Math.round((S.deadline - Date.now()) / 1000));
      const el = document.getElementById("timer");
      if (el) el.textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
      if (left <= 0) { clearInterval(timerH); timerH = null; validate(true); }
    };
    upd();
    timerH = setInterval(upd, 1000);
  }

  function render() {
    if (!S.G) renderHome(); else renderGame();
  }

  app.addEventListener("click", ev => {
    const b = ev.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "pick") { S.sel.scenario = b.dataset.id; renderHome(); return; }
    if (act === "start") { startGame(S.sel); return; }
    if (act === "resume") {
      const sv = loadSaved();
      if (sv && sv.G) {
        S.G = sv.G; S.draft = sv.draft || freshDraft(); S.draft.disinvest = S.draft.disinvest || {}; S.q = sv.q || {}; S.sel = Object.assign(S.sel, sv.sel || {}); S.result = null; S.tab = "conseil";
        // recharger la page ne remet pas le chronomètre à zéro (30 s de grâce si l'échéance est passée)
        if (S.sel.timer && sv.deadline) S.deadline = Math.max(sv.deadline, Date.now() + 30000); else openYear();
        render();
      }
      return;
    }
    if (act === "discard") { clearSaved(); renderHome(); return; }
    if (act === "tab") { S.tab = b.dataset.tab; render(); window.scrollTo(0, 0); return; }
    if (act === "mco") { S.matrixCo = b.dataset.id; render(); return; }
    if (act === "validate") { validate(false); return; }
    if (act === "reset") { S.draft = freshDraft(); render(); return; }
    if (act === "close-sheet") {
      S.result = null;
      if (S.G.over) S.tab = "bilan"; else openYear();
      save(); render(); window.scrollTo(0, 0); return;
    }
    if (act === "new") { clearSaved(); S.G = null; S.result = null; render(); window.scrollTo(0, 0); return; }
    if (act === "replay") {
      const G = S.G;
      startGame({ scenario: G.sc, years: G.T, seed: String(G.seed), name: player().name === E.SCENARIOS.find(s => s.id === G.sc).companies[0].name ? "" : player().name });
      return;
    }
    if (act === "dq") {
      const sid = b.dataset.sid, dv = player().div[sid];
      if (!dv) return;
      const v = Math.round(+b.dataset.f * dv.A);
      S.draft.disinvest = S.draft.disinvest || {};
      if (v > 0) { S.draft.disinvest[sid] = v; S.draft.invest[sid] = 0; S.q[sid] = "zero"; }
      else { delete S.draft.disinvest[sid]; S.draft.invest[sid] = Math.round(segOf(sid).dep * dv.A); S.q[sid] = "maint"; }
      S.confirmRisk = false; save(); render(); return;
    }
    if (act === "q") {
      const sid = b.dataset.sid, v = +b.dataset.v;
      S.draft.invest[sid] = v; S.q[sid] = b.dataset.k;
      const inp = document.getElementById("inv-" + sid);
      if (inp) inp.value = Math.round(v);
      S.confirmRisk = false;
      if (b.dataset.k === "zero" && !player().div[sid]) { render(); return; }
      if (!player().div[sid]) { render(); return; }
      updateDerived(); save(); return;
    }
  });

  function onField(ev) {
    const el = ev.target;
    if (el.dataset.o) {
      const k = el.dataset.o;
      S.sel[k] = (k === "years" || k === "timer") ? +el.value : el.value;
      return;
    }
    const k = el.dataset.k;
    if (!k || !S.draft) return;
    const d = S.draft, v = el.type === "number" || el.type === "range" ? Math.max(0, +el.value || 0) : el.value;
    S.confirmRisk = false;
    if (k === "inv") { d.invest[el.dataset.sid] = v; S.q[el.dataset.sid] = null; }
    else if (k === "dis") {
      const sid = el.dataset.sid, A = player().div[sid].A;
      d.disinvest = d.disinvest || {};
      if (v > 0) { d.disinvest[sid] = Math.min(v, S.G.params.maxDisinv * A); d.invest[sid] = 0; S.q[sid] = "zero"; } else delete d.disinvest[sid];
      const inp = document.getElementById("inv-" + sid);
      if (inp) { inp.disabled = v > 0; if (v > 0) inp.value = 0; }
    }
    else if (k === "dvmode") {
      const sid = el.dataset.sid;
      if (!v) delete d.divest[sid];
      else {
        const A = player().div[sid].A;
        d.divest[sid] = { mode: v, min: d.divest[sid] && d.divest[sid].min ? d.divest[sid].min : Math.round(0.6 * A) };
        if (v === "liq") { d.invest[sid] = 0; S.q[sid] = "zero"; }
        if (d.disinvest) delete d.disinvest[sid];
      }
      save(); render(); return;
    }
    else if (k === "dvmin") { const sid = el.dataset.sid; if (d.divest[sid]) d.divest[sid].min = v; }
    else if (k === "payout") d.payout = v / 100;
    else if (k === "loanAmt") { d.loan = Object.assign({ years: 5 }, d.loan || {}, { amount: v }); }
    else if (k === "loanYears") { d.loan = Object.assign({ amount: 0 }, d.loan || {}, { years: +v }); }
    else if (k === "issue") { d.issuePct = v / 100; if (v > 0 && d.buybackPct > 0) { d.buybackPct = 0; const bb = document.getElementById("buyback"); if (bb) bb.value = 0; } }
    else if (k === "buyback") { d.buybackPct = v / 100; if (v > 0 && d.issuePct > 0) { d.issuePct = 0; const is = document.getElementById("issue"); if (is) is.value = 0; } }
    else if (k === "bid") d.bids[el.dataset.lid] = v;
    updateDerived();
    save();
  }
  app.addEventListener("input", ev => { if (ev.target.tagName !== "SELECT") onField(ev); });
  app.addEventListener("change", ev => { if (ev.target.tagName === "SELECT") onField(ev); });

  window.addEventListener("resize", () => { if (!S.G) drawGuilloche(); });
  document.addEventListener("keydown", ev => {
    if (ev.key === "Escape" && S.result) { const b = document.getElementById("close-sheet"); if (b) b.click(); }
  });

  /* ---------------- démarrage ---------------- */
  render();
})();
