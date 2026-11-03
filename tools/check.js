/* Tests de non-régression du moteur : node tools/check.js
   Sort avec le code 1 au premier échec. */
const E = require("../src/engine.js");
const { strategies, evaluate } = require("./strategies.js");

let fails = 0, passes = 0;
function ok(cond, msg) {
  if (cond) passes++;
  else { fails++; console.error("ÉCHEC :", msg); }
}

function play(sc, seed, strat) {
  const G = E.newGame(sc, { seed });
  const co = G.companies.find(c => c.player);
  while (!G.over) E.simulateYear(G, strat(G, co));
  return G;
}

/* 1. Même graine, même conjoncture, quelles que soient les décisions du joueur */
{
  const variants = [
    (G, co) => E.defaultDecision(G, co),
    (G, co) => { const d = E.defaultDecision(G, co); for (const s in co.div) d.invest[s] = E.investHints(G, co, s).follow; return d; },
    (G, co) => { const d = E.defaultDecision(G, co); for (const s in co.div) d.invest[s] = Math.round(0.5 * E.investHints(G, co, s).maint); return d; },
    (G, co) => { const d = E.defaultDecision(G, co); if (G.year === 2) { const s = Object.keys(co.div)[0]; if (s) d.divest[s] = { mode: "auction", min: 1 }; } return d; }
  ];
  for (const sc of E.SCENARIOS) for (let seed = 1; seed <= 8; seed++) {
    const runs = variants.map(v => {
      const G = play(sc.id, seed, v);
      return { g: G.segments.map(s => s.hist.map(h => h.g)), news: G.log.filter(e => ["conjoncture", "coûts", "banque", "technologie", "marché", "régulation", "secteur"].includes(e.kind) && !/obtient un emprunt/.test(e.text)).map(e => e.t + e.text) };
    });
    for (let k = 1; k < runs.length; k++) {
      const n = Math.min(runs[0].g[0].length, runs[k].g[0].length);
      const same = runs[0].g.every((s, i) => s.slice(0, n).every((x, j) => x === runs[k].g[i][j]));
      const nNews = runs[0].news.filter(x => parseInt(x, 10) < n).length;
      ok(same && runs[0].news.slice(0, nNews).join() === runs[k].news.slice(0, nNews).join(),
        `${sc.id} graine ${seed} : la conjoncture dépend des décisions (variante ${k})`);
    }
  }
}

/* 2. Identité de trésorerie à chaque exercice, pour toutes les sociétés vivantes */
{
  const S = strategies("industrie");
  for (const sc of E.SCENARIOS) for (let seed = 1; seed <= 6; seed++) {
    const strat = strategies(sc.id)[seed % 2 ? "recentre" : "passif"] || S.passif;
    const G = play(sc.id, seed, strat);
    G.companies.forEach(c => {
      for (let i = 1; i < c.hist.length; i++) {
        const h = c.hist[i], p = c.hist[i - 1];
        if (c.bankrupt === h.t) continue;
        const flows = h.npRec + h.dep - h.inv - h.dividends + (h.issue || 0) - (h.buyback || 0) + (h.ma || 0) + (h.disinv || 0) + (h.debt - p.debt);
        ok(Math.abs(h.cash - p.cash - flows) < 1e-6 * Math.max(1, Math.abs(h.cash)),
          `${sc.id} graine ${seed} ${c.name} t${h.t} : trésorerie ${h.cash.toFixed(3)} ≠ ${(p.cash + flows).toFixed(3)}`);
      }
    });
  }
}

/* 3. Désinvestissement : décoté, plafonné, et jamais plus avantageux que nécessaire */
{
  const G = E.newGame("industrie", { seed: 1 });
  const co = G.companies.find(c => c.player);
  const sid = "pmt", A = co.div[sid].A, seg = E.segById(G, sid);
  const rate = E.disinvestRate(G, seg);
  const d = E.defaultDecision(G, co); d.disinvest[sid] = A;
  E.simulateYear(G, d);
  const h = E.lastH(co);
  ok(co.div[sid], "un désinvestissement ne doit pas faire sortir du créneau");
  ok(Math.abs(h.disinv - rate * G.params.maxDisinv * A) < 1e-6, "montant récupéré = taux × plafond × actifs");
  ok(rate < 1 && rate >= G.params.disFloor, "taux de récupération hors bornes");
  ok(h.exc < 0, "la décote doit passer en résultat exceptionnel");
}

/* 4. Score = cours + dividendes cumulés ; valorisation cohérente au départ */
{
  for (const sc of E.SCENARIOS) {
    const G = E.newGame(sc.id, { seed: 5 });
    G.companies.forEach(c => ok(Math.abs(E.lastH(c).price - 10) < 1e-9, `${sc.id} ${c.name} : cours initial ≠ 10`));
    const co = G.companies.find(c => c.player);
    while (!G.over) E.simulateYear(G, E.defaultDecision(G, co));
    G.companies.filter(c => c.alive).forEach(c => {
      const h = E.lastH(c);
      ok(Math.abs(h.score - (h.price + E.sum(c.dps))) < 1e-9, `${sc.id} ${c.name} : score ≠ cours + dividendes cumulés`);
      ok(isFinite(h.price) && h.price >= 0, `${sc.id} ${c.name} : cours invalide`);
    });
  }
}

/* 5. Pas de rente de pénurie pour une société au-delà du seuil de position dominante.
   Cas construit : demande de la grande vitesse allemande +30 % d'un coup, Bahnwerk à 90 %. */
{
  const G = E.newGame("transport", { seed: 1 });
  const seg = E.segById(G, "gvde");
  seg.gShift += 0.30;
  E.simulateYear(G, E.defaultDecision(G, G.companies.find(c => c.player)));
  ok(seg.r < 0.9, `cas de pénurie non obtenu (offre/demande ${seg.r.toFixed(2)})`);
  const B = E.coById(G, "B"), dB = B.div.gvde;
  ok(dB.share >= G.params.cap, "Bahnwerk devrait rester au-delà du seuil");
  ok(dB.rev / dB.q < seg.P * 0.99, "la société dominante facture le prix de pénurie");
  const others = G.companies.filter(c => c !== B && c.alive && c.div.gvde && c.div.gvde.q > 0);
  ok(others.length > 0 && others.every(c => Math.abs(c.div.gvde.rev / c.div.gvde.q - seg.P) < 1e-9), "les autres sociétés doivent vendre au prix de marché");
}

/* 6. Faillite d'un concurrent : divisions mises en vente par le liquidateur, résolues l'exercice suivant */
{
  let seen = 0;
  for (const sc of E.SCENARIOS) for (let seed = 1; seed <= 30 && seen < 3; seed++) {
    const G = E.newGame(sc.id, { seed });
    const co = G.companies.find(c => c.player);
    while (!G.over) {
      E.simulateYear(G, E.defaultDecision(G, co));
      G.companies.filter(c => !c.alive && c.bankrupt === G.year).forEach(c => {
        seen++;
        const n = Object.keys(c.div).length;
        ok(G.listings.filter(l => l.seller === c.id && l.liq).length === n, `${sc.id} ${c.name} : chaque division doit être mise en vente`);
        if (!G.over) {
          E.simulateYear(G, E.defaultDecision(G, co));
          ok(Object.keys(c.div).length === 0, `${sc.id} ${c.name} : divisions non soldées un exercice après la faillite`);
          ok(!G.listings.some(l => l.seller === c.id), `${sc.id} ${c.name} : annonces de liquidation encore ouvertes`);
        }
      });
    }
  }
  ok(seen > 0, "aucune faillite de concurrent observée : test de liquidation vide");
}

/* 7. Calibrage : décider doit compter. Le recentrage bat la passivité dans chaque scénario. */
{
  for (const sc of E.SCENARIOS) {
    const S = strategies(sc.id);
    const pa = evaluate(sc.id, 20, S.passif), re = evaluate(sc.id, 20, S.recentre);
    ok(re.score >= pa.score - 0.1, `${sc.id} : la passivité (${pa.score.toFixed(1)}) bat le recentrage (${re.score.toFixed(1)})`);
    ok(re.bk === 0, `${sc.id} : le recentrage fait faillite`);
    // gagnable : au moins une stratégie du banc fait mieux que le hasard entre cinq sociétés
    // (20 % de victoires, rang moyen 3)
    const res = Object.keys(S).map(k => evaluate(sc.id, 20, S[k]));
    ok(res.some(r => r.wins >= 0.2 || r.rank < 3), `${sc.id} : aucune stratégie du banc ne fait mieux que le hasard`);
  }
}

console.log(`${passes} vérifications réussies, ${fails} échec${fails > 1 ? "s" : ""}.`);
process.exit(fails ? 1 : 0);
