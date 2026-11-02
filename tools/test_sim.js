const E = require("../src/engine.js");

function botPassive(G, co) { return E.defaultDecision(G, co); }
function botFollow(G, co) {
  const d = E.defaultDecision(G, co);
  for (const sid in co.div) d.invest[sid] = E.investHints(G, co, sid).follow;
  return d;
}
function botSmart(G, co) {
  const d = E.defaultDecision(G, co);
  const t = G.year + 1;
  for (const sid in co.div) {
    const dv = co.div[sid], seg = E.segById(G, sid), h = E.investHints(G, co, sid);
    if (dv.rs >= 0.9 && h.gF > 0.0) d.invest[sid] = h.plus5;
    else if (h.gF > 0.05) d.invest[sid] = h.follow;
    else if (dv.lossYears >= 2 && dv.rs < 0.6) d.divest[sid] = { mode: "liq" };
    else d.invest[sid] = Math.round(h.maint * 0.5);
  }
  d.payout = 0.3;
  const ml = E.maxLoan(G, co);
  if (ml > 0 && t < G.T - 4) d.loan = { amount: Math.round(ml * 0.5), years: 6 };
  return d;
}

const bots = { passive: botPassive, follow: botFollow, smart: botSmart };
const verbose = process.argv.includes("-v");
for (const sc of E.SCENARIOS) {
  for (const bn in bots) {
    const agg = {};
    let bk = 0, pb = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const G = E.newGame(sc.id, { seed, years: 15 });
      if (seed === 1 && bn === "passive") {
        console.log("\n=== " + sc.id + " initial");
        G.companies.forEach(c => { const h = E.lastH(c); console.log(c.name.padEnd(24), "rev", h.rev.toFixed(0), "ebit", h.ebit.toFixed(0), "np", h.npRec.toFixed(0), "cash", h.cash.toFixed(0), "price", h.price.toFixed(2), "PER", h.PER.toFixed(1), "sh", c.shares.toFixed(1)); });
        G.segments.forEach(s => { const pl = G.companies.filter(c => c.div[s.id]).map(c => c.id + ":" + (c.div[s.id].share * 100).toFixed(0) + "%/" + (c.div[s.id].ebit / c.div[s.id].rev * 100).toFixed(0) + "%").join(" "); console.log("  " + s.id.padEnd(6), "P", s.P.toFixed(3), pl); });
      }
      const player = G.companies.find(c => c.player);
      while (!G.over) E.simulateYear(G, bots[bn](G, player));
      G.companies.forEach(c => { (agg[c.id] = agg[c.id] || []).push(E.lastH(c).score); if (!c.alive) bk++; });
      if (G.bankrupt) pb++;
      if (verbose && seed === 1) {
        G.companies.forEach(c => { const h = E.lastH(c); console.log("   ", c.name.padEnd(24), "t", h.t, "rev", h.rev.toFixed(0), "np", h.npRec.toFixed(0), "cash", h.cash.toFixed(0), "debt", h.debt.toFixed(0), "price", h.price.toFixed(2), "score", h.score.toFixed(2), "divs", Object.keys(c.div).join(",")); });
        G.segments.forEach(s => { const h = s.hist[s.hist.length - 1]; console.log("    ", s.id.padEnd(6), "D", s.D.toFixed(0), "P", s.P.toFixed(3), "r", h.r.toFixed(2), G.companies.filter(c => c.div[s.id]).map(c => c.id + ":" + (c.div[s.id].share * 100).toFixed(0) + "%/" + (c.div[s.id].ebit / Math.max(1e-9, c.div[s.id].rev) * 100).toFixed(0) + "%").join(" ")); });
      }
    }
    const line = Object.keys(agg).map(k => k + "=" + (agg[k].reduce((a, b) => a + b, 0) / agg[k].length).toFixed(1)).join("  ");
    console.log(sc.id.padEnd(10), bn.padEnd(8), line, " faillites:", bk, " joueur:", pb);
  }
}
