"use strict";
/* ============================================================
   LE CONSEIL — stratégies de référence
   Partagées entre le jeu (comparaison au bilan final) et les outils de calibrage.
   Chaque stratégie est une fonction (G, société du joueur) → décision.
   ============================================================ */
var STRATEGIES = (function (E) {

  // garde-fou : ne pas engager plus que la trésorerie disponible et la moitié du découvert
  function guardCash(G, co, d) {
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

  function consolidate(sids) {
    return (G, co) => {
      const d = base(G, co, "recentre");
      sids.forEach(sid => {
        const dv = co.div[sid], seg = E.segById(G, sid);
        if (!dv) return;
        const h = E.investHints(G, co, sid);
        delete d.divest[sid];
        d.invest[sid] = h.gF > 0 && seg.r < 1.08 ? h.plus5 : h.follow;
      });
      d.payout = 0.2;
      const ml = E.maxLoan(G, co);
      if (ml > 10 && G.year + 1 < G.T - 4) d.loan = { amount: Math.round(0.5 * ml), years: 8 };
      return guardCash(G, co, d);
    };
  }

  function persona(k) {
    // la société du joueur pilotée par la logique d'un concurrent
    return (G, co) => {
      co.persona = k;
      try { return E.aiDecide(G, co); } finally { co.persona = null; }
    };
  }

  /* Liste ordonnée des stratégies d'un scénario : { key, label, desc, fn } */
  function list(scId) {
    const G0 = E.newGame(scId, { seed: 1 });
    const pl = G0.companies.find(c => c.player);
    const L = [
      { key: "passif", label: "Passivité", desc: "Maintenir les actifs partout, sans entrée ni sortie.", fn: (G, co) => base(G, co, "passif") },
      { key: "recentre", label: "Recentrage", desc: "Suivre le marché là où l'on est leader, réduire les créneaux en déclin, fermer les petites positions déficitaires.", fn: (G, co) => guardCash(G, co, base(G, co, "recentre")) }
    ];
    G0.segments.filter(s => !pl.div[s.id] && E.forecastGrowth(G0, s, 1) > 0.02).forEach(s => {
      const share = s.capex > 1.8 ? 0.10 : 0.15;
      L.push({ key: "entrée " + s.id, label: "Entrée : " + s.name, desc: "Recentrage, plus une entrée progressive jusqu'à " + Math.round(share * 100) + " % du marché en quatre exercices, financée par emprunt.", fn: entry(s.id, share, 4) });
    });
    G0.segments.filter(s => pl.div[s.id] && pl.div[s.id].rs < 1 && E.forecastGrowth(G0, s, 1) > 0.07).forEach(s => {
      const share = Math.min(0.35, pl.div[s.id].share + 0.15);
      L.push({ key: "pousser " + s.id, label: "Offensive : " + s.name, desc: "Recentrage, plus une montée à " + Math.round(share * 100) + " % de part de marché en cinq exercices, financée par emprunt.", fn: entry(s.id, share, 5) });
    });
    const groups = {};
    for (const sid in pl.div) { const g = E.segById(G0, sid).group; (groups[g] = groups[g] || []).push(sid); }
    for (const g in groups) if (groups[g].length >= 3) {
      const names = groups[g].map(sid => E.segById(G0, sid).name);
      L.push({ key: "consolider " + g, label: "Consolidation d'un métier", desc: "Gagner des parts dans les divisions qui partagent leur expérience : " + names.join(", ") + ".", fn: consolidate(groups[g]) });
    }
    ["gardien", "conquerant", "diversifieur"].forEach(k => {
      L.push({ key: "IA " + k, label: "Style « " + E.PERSONAS[k].label.toLowerCase() + " »", desc: "La logique d'un concurrent appliquée à votre société : " + E.PERSONAS[k].desc.charAt(0).toLowerCase() + E.PERSONAS[k].desc.slice(1), fn: persona(k) });
    });
    return L;
  }

  /* Rejoue une partie avec une stratégie : même scénario, même graine, même durée, même niveau */
  function replay(G, strat) {
    const H = E.newGame(G.sc, { seed: G.seed, years: G.T, level: G.level });
    const co = H.companies.find(c => c.player);
    while (!H.over) E.simulateYear(H, strat(H, co));
    const s = E.lastH(co).score;
    return { score: s, rank: 1 + H.companies.filter(c => !c.player && E.lastH(c).score > s).length, bankrupt: H.bankrupt, n: H.companies.length };
  }

  return { list, replay, guardCash };
})(typeof ENGINE !== "undefined" ? ENGINE : require("./engine.js"));
if (typeof module !== "undefined") module.exports = STRATEGIES;
