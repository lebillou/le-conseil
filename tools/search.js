const E = require("../src/engine.js");
let s0 = 12345;
const R = () => { s0 = (s0 * 1103515245 + 12345) & 0x7fffffff; return s0 / 0x7fffffff; };
const ACTIONS = ["grow", "follow", "maint", "harvest", "sell"];

function makePolicy(G) {
  const pl = G.companies.find(c => c.player);
  const pol = { act: {}, entry: null, entryYears: 1 + Math.floor(R() * 4), entryShare: 0.05 + R() * 0.15, payout: R() * 0.5, loan: R() < 0.6, loanFrac: 0.3 + R() * 0.7 };
  for (const sid in pl.div) pol.act[sid] = ACTIONS[Math.floor(R() * ACTIONS.length)];
  const free = G.segments.filter(s => !pl.div[s.id]);
  if (free.length && R() < 0.7) pol.entry = free[Math.floor(R() * free.length)].id;
  return pol;
}
function play(G, pol) {
  const co = G.companies.find(c => c.player);
  const t = G.year + 1;
  const d = E.defaultDecision(G, co);
  d.payout = pol.payout;
  for (const sid in co.div) {
    const h = E.investHints(G, co, sid);
    const a = pol.act[sid] || "grow";
    if (a === "grow") d.invest[sid] = h.plus5;
    else if (a === "follow") d.invest[sid] = h.follow;
    else if (a === "maint") d.invest[sid] = h.maint;
    else if (a === "harvest") d.invest[sid] = 0;
    else if (a === "sell") { d.invest[sid] = 0; if (!G.listings.some(l => l.seller === co.id && l.seg === sid)) d.divest[sid] = co.div[sid].unsold ? { mode: "liq" } : { mode: "auction", min: Math.round(0.4 * co.div[sid].A) }; }
  }
  if (pol.entry && t <= pol.entryYears) {
    const seg = E.segById(G, pol.entry);
    const dv = co.div[pol.entry];
    const Dn = seg.D * (1 + E.forecastGrowth(G, seg, t));
    const Kafter = dv ? dv.A * (1 - seg.dep) / seg.capex : 0;
    d.invest[pol.entry] = Math.max(0, Math.round((pol.entryShare * Dn / 0.97 - Kafter) * seg.capex));
  }
  // garde-fou trésorerie
  const h = E.lastH(co);
  const tot = Object.values(d.invest).reduce((a, b) => a + b, 0);
  const avail = co.cash + h.npRec * (1 - d.payout) + h.dep - (co.loan ? co.loan.ann : 0) + 0.5 * co.overdraft;
  if (tot > avail && tot > 0) { const k = Math.max(0, avail) / tot; for (const s in d.invest) d.invest[s] = Math.round(d.invest[s] * k); }
  if (pol.loan && t < G.T - 3) { const ml = E.maxLoan(G, co); if (ml > 10) d.loan = { amount: Math.round(ml * pol.loanFrac), years: 7 }; }
  return d;
}
const sc = process.argv[2] || "industrie";
const N = +process.argv[3] || 300;
const seeds = [3, 7, 11];
let res = [];
for (let i = 0; i < N; i++) {
  const G0 = E.newGame(sc, { seed: 1 });
  const pol = makePolicy(G0);
  let tot = 0, ranks = 0, ai = 0;
  for (const seed of seeds) {
    const G = E.newGame(sc, { seed });
    while (!G.over) E.simulateYear(G, play(G, pol));
    const pl = G.companies.find(c => c.player);
    tot += E.lastH(pl).score;
    const rk = E.lastH(pl).score;
    ranks += 1 + G.companies.filter(c => !c.player && E.lastH(c).score > rk).length;
    ai += Math.max(...G.companies.filter(c => !c.player).map(c => E.lastH(c).score));
  }
  res.push({ score: tot / seeds.length, rank: ranks / seeds.length, bestAI: ai / seeds.length, pol });
}
res.sort((a, b) => b.score - a.score);
console.log("scenario", sc, "median score", res[Math.floor(N / 2)].score.toFixed(1), "share winning (avg rank<=1.34):", res.filter(r => r.rank <= 1.34).length + "/" + N);
res.slice(0, 5).forEach(r => console.log(r.score.toFixed(1), "rank", r.rank.toFixed(2), "bestAI", r.bestAI.toFixed(1), JSON.stringify(r.pol)));
console.log("worst", res[N - 1].score.toFixed(1));
