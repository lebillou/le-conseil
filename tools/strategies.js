/* Banc d'essai de calibrage : compare des stratégies lisibles sur N graines.
   node tools/strategies.js [scenario] [N] [facile|normal|difficile]
   Pour chaque stratégie : score moyen du joueur, rang moyen, part des parties gagnées, faillites. */
const E = require("../src/engine.js");

const ST = require("../src/strategies.js");

/* Stratégies d'un scénario, indexées par clé (passif, recentre, entrée <créneau>…) */
function strategies(sc) {
  const S = {};
  ST.list(sc).forEach(x => { S[x.key] = x.fn; });
  return S;
}

function evaluate(sc, N, strat, level) {
  let score = 0, rank = 0, wins = 0, bk = 0, best = 0;
  for (let seed = 1; seed <= N; seed++) {
    const G = E.newGame(sc, { seed, level });
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
  const only = process.argv[2], N = +process.argv[3] || 20, level = process.argv[4] || "normal";
  for (const sc of E.SCENARIOS) {
    if (only && sc.id !== only) continue;
    const S = strategies(sc.id);
    console.log("\n" + sc.id);
    for (const k in S) {
      const r = evaluate(sc.id, N, S[k], level);
      console.log("  " + k.padEnd(14), "score", r.score.toFixed(1).padStart(5), " rang", r.rank.toFixed(2), " victoires", (r.wins * 100).toFixed(0).padStart(3) + " %", " faillites", r.bk, " meilleure IA", r.best.toFixed(1));
    }
  }
}
module.exports = { strategies, evaluate };
