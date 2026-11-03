/* Banc d'essai de calibrage : compare des stratégies lisibles sur N graines.
   node tools/strategies.js [scenario] [N]
   Pour chaque stratégie : score moyen du joueur, rang moyen, part des parties gagnées, faillites. */
const E = require("../src/engine.js");

function guardCash(G, co, d) {
  // garde-fou : ne pas engager plus que la trésorerie disponible et la moitié du découvert
  const h = E.lastH(co);
  const tot = Object.values(d.invest).reduce((a, b) => a + b, 0);
  const avail = co.cash + h.npRec * (1 - d.payout) + h.dep - (co.loan ? co.loan.ann : 0) + 0.5 * co.overdraft;
  if (tot > avail && tot > 0) { const k = Math.max(0, avail) / tot; for (const s in d.invest) d.invest[s] = Math.round(d.invest[s] * k); }
  return d;
}

function base(G, co, mode) {
  const d = E.defaultDecision(G, co);
  for (const sid in co.div) {
    const dv = co.div[sid], h = E.investHints(G, co, sid);
    if (mode === "passif") continue;
    if (dv.rs >= 1 && h.gF > 0) d.invest[sid] = h.follow;
    else if (dv.rs < 0.5 && dv.lossYears >= 2 && h.gF < 0.05) d.divest[sid] = { mode: "liq" };
    else if (h.gF < 0) d.invest[sid] = Math.round(0.5 * h.maint);
    else d.invest[sid] = h.maint;
  }
  return d;
}

function entry(sid, share, years) {
  return (G, co) => {
    const d = base(G, co, "recentre");
    const t = G.year + 1, seg = E.segById(G, sid), dv = co.div[sid];
    if (seg && t <= years + 6) {
      let target = Math.min(share, share * t / years);
      // en pénurie, prendre la demande que les autres ne servent pas
      if (dv && seg.r < 0.97) target = Math.max(target, Math.min(G.params.cap - 0.03, dv.share + (0.97 - seg.r)));
      const Dn = seg.D * (1 + E.forecastGrowth(G, seg, t));
      const Ka = dv ? dv.A * (1 - seg.dep) / seg.capex : 0;
      d.invest[sid] = Math.max(d.invest[sid] || 0, Math.round((target * Dn / 0.97 - Ka) * seg.capex));
      delete d.divest[sid];
    }
    d.payout = 0.2;
    const ml = E.maxLoan(G, co);
    if (ml > 10 && t < G.T - 4) d.loan = { amount: Math.round(0.7 * ml), years: 8 };
    return guardCash(G, co, d);
  };
}

function strategies(sc) {
  const S = {
    passif: (G, co) => base(G, co, "passif"),
    recentre: (G, co) => guardCash(G, co, base(G, co, "recentre"))
  };
  const G0 = E.newGame(sc, { seed: 1 });
  const pl = G0.companies.find(c => c.player);
  G0.segments.filter(s => !pl.div[s.id] && E.forecastGrowth(G0, s, 1) > 0.02)
    .forEach(s => { S["entrée " + s.id] = entry(s.id, s.capex > 1.8 ? 0.10 : 0.15, 4); });
  // pousser un créneau en forte croissance où le joueur n'est pas leader
  G0.segments.filter(s => pl.div[s.id] && pl.div[s.id].rs < 1 && E.forecastGrowth(G0, s, 1) > 0.07)
    .forEach(s => { S["pousser " + s.id] = entry(s.id, Math.min(0.35, pl.div[s.id].share + 0.15), 5); });
  return S;
}

function evaluate(sc, N, strat) {
  let score = 0, rank = 0, wins = 0, bk = 0, best = 0;
  for (let seed = 1; seed <= N; seed++) {
    const G = E.newGame(sc, { seed });
    const co = G.companies.find(c => c.player);
    while (!G.over) E.simulateYear(G, strat(G, co));
    const s = E.lastH(co).score;
    const r = 1 + G.companies.filter(c => !c.player && E.lastH(c).score > s).length;
    score += s; rank += r; if (r === 1) wins++; if (G.bankrupt) bk++;
    best += Math.max(...G.companies.filter(c => !c.player).map(c => E.lastH(c).score));
  }
  return { score: score / N, rank: rank / N, wins: wins / N, bk, best: best / N };
}

if (require.main === module) {
  const only = process.argv[2], N = +process.argv[3] || 20;
  for (const sc of E.SCENARIOS) {
    if (only && sc.id !== only) continue;
    const S = strategies(sc.id);
    console.log("\n" + sc.id);
    for (const k in S) {
      const r = evaluate(sc.id, N, S[k]);
      console.log("  " + k.padEnd(14), "score", r.score.toFixed(1).padStart(5), " rang", r.rank.toFixed(2), " victoires", (r.wins * 100).toFixed(0).padStart(3) + " %", " faillites", r.bk, " meilleure IA", r.best.toFixed(1));
    }
  }
}
module.exports = { strategies, evaluate };
