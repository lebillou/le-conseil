"use strict";
/* ============================================================
   LE CONSEIL — moteur de simulation (pur, sérialisable JSON)
   ============================================================ */
var ENGINE = (function () {

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const sum = (arr, f) => arr.reduce((s, x) => s + (f ? f(x) : x), 0);

  /* ---------- Aléa reproductible (mulberry32, état dans G) ----------
     Deux flux indépendants : G.rng pour la conjoncture (demande, événements, taux),
     G.rngAI pour les décisions des concurrents. Le nombre de tirages du premier ne
     dépend jamais des décisions : une même graine rejoue la même conjoncture. */
  const VERSION = 2;
  function rnd(G, key) {
    key = key || "rng";
    let a = (G[key] = (G[key] + 0x6D2B79F5) | 0);
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function gauss(G) {
    let u = 0;
    while (u === 0) u = rnd(G);
    const v = rnd(G);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function pick(G, arr) { return arr[Math.floor(rnd(G) * arr.length) % arr.length]; }

  function pathGrowth(path, t) {
    if (t <= path[0][0]) return path[0][1];
    for (let i = 1; i < path.length; i++) {
      if (t <= path[i][0]) {
        const [t0, g0] = path[i - 1], [t1, g1] = path[i];
        return g0 + (g1 - g0) * (t - t0) / (t1 - t0);
      }
    }
    return path[path.length - 1][1];
  }

  /* ---------- Profils des concurrents pilotés par l'IA ---------- */
  const PERSONAS = {
    gardien: {
      label: "Gardien du métier",
      desc: "Défend ses positions de leader, investit au rythme du marché, distribue régulièrement.",
      payout: 0.40, aggr: 0.25, push: 0.25, harvestG: 0.0, harvestRS: 0.5, util: 0.97,
      debt: true, equity: false, entry: 0.06, entryShare: 0.08, odUse: 0.15, exitPatience: 3,
      buyback: true, flexDiv: true, loanYears: 6
    },
    conquerant: {
      label: "Conquérant",
      desc: "Cherche la part de marché dans les créneaux en croissance, finance par dette et augmentations de capital.",
      payout: 0.12, aggr: 1.0, push: 0.55, harvestG: -0.02, harvestRS: 0.35, util: 0.95,
      debt: true, equity: true, entry: 0.30, entryShare: 0.12, odUse: 0.45, exitPatience: 4,
      buyback: false, flexDiv: true, loanYears: 8, cfUse: 0.7
    },
    rentier: {
      label: "Rentier",
      desc: "Privilégie le dividende, investit peu, se retire vite des activités déficitaires.",
      payout: 0.70, aggr: 0.0, push: 0.05, harvestG: 0.03, harvestRS: 0.9, util: 0.99,
      debt: false, equity: false, entry: 0.0, entryShare: 0.05, odUse: 0.05, exitPatience: 2,
      buyback: true, flexDiv: false, loanYears: 5
    },
    diversifieur: {
      label: "Diversifieur",
      desc: "Multiplie les entrées dans les créneaux nouveaux, au risque de la dispersion.",
      payout: 0.30, aggr: 0.55, push: 0.3, harvestG: 0.0, harvestRS: 0.5, util: 0.96,
      debt: true, equity: false, entry: 0.45, entryShare: 0.10, odUse: 0.15, exitPatience: 3,
      buyback: false, flexDiv: true, loanYears: 7, cfUse: 0.85
    },
    opportuniste: {
      label: "Opportuniste",
      desc: "Achète les divisions mises en vente, coupe vite ce qui ne rapporte pas.",
      payout: 0.30, aggr: 0.6, push: 0.4, harvestG: 0.01, harvestRS: 0.6, util: 0.96,
      debt: true, equity: false, entry: 0.15, entryShare: 0.08, odUse: 0.25, exitPatience: 2,
      buyback: false, flexDiv: true, loanYears: 6, bidBoost: 0.2
    }
  };

  /* ---------- Scénarios (sociétés et chiffres fictifs) ---------- */
  const SCENARIOS = [
    {
      id: "industrie",
      difficulty: "Intermédiaire",
      title: "Groupe industriel diversifié",
      kicker: "Portefeuille hétérogène",
      pitch: "Vous présidez un groupe présent dans sept métiers, du carton d'emballage aux batteries stationnaires. Votre vache à lait, les pièces de moteurs thermiques, est condamnée à terme. Il faut choisir où concentrer les ressources avant qu'elle ne s'épuise.",
      startYear: 2027,
      params: { cap: 0.55, rate: 0.030, overdraft: 0.12 },
      companies: [
        { id: "P", name: "Vauclair Industries", color: "#C8432B", player: true, cash: 0.10, debt: 0.25, debtYears: 5, payout: 0.30 },
        { id: "A", name: "Norvane", color: "#2F6E96", persona: "gardien", cash: 0.08, debt: 0.20, debtYears: 6 },
        { id: "B", name: "Kestrel Holding", color: "#7A5AA6", persona: "conquerant", cash: 0.06, debt: 0.35, debtYears: 6 },
        { id: "C", name: "Brennac", color: "#A88328", persona: "rentier", cash: 0.12 },
        { id: "D", name: "Oxalia Group", color: "#2E8A6A", persona: "diversifieur", cash: 0.07, debt: 0.15, debtYears: 5 }
      ],
      segments: [
        { id: "emb", name: "Emballages carton", group: "conso", D0: 900, path: [[0, 0.02], [20, 0.01]], capex: 0.9, slope: 0.85, mu: 0.26, eps: 1.6, dep: 0.07, vol: 0.010,
          pos: { P: 0.18, A: 0.42, C: 0.25, D: 0.15 } },
        { id: "mac", name: "Machines-outils", group: "meca", D0: 700, path: [[0, 0.03], [6, 0.0], [12, 0.025], [20, 0.02]], capex: 1.0, slope: 0.82, mu: 0.27, eps: 1.5, dep: 0.08, vol: 0.025,
          pos: { P: 0.30, B: 0.20, C: 0.35, D: 0.15 } },
        { id: "cmp", name: "Composants électroniques", group: "elec", D0: 400, path: [[0, 0.12], [6, 0.10], [12, 0.04], [20, 0.02]], capex: 1.3, slope: 0.75, mu: 0.28, eps: 1.7, dep: 0.10, vol: 0.015,
          pos: { P: 0.12, A: 0.35, B: 0.25, D: 0.28 } },
        { id: "bat", name: "Batteries stationnaires", group: "elec", D0: 120, path: [[0, 0.26], [5, 0.22], [10, 0.12], [15, 0.06], [20, 0.04]], capex: 1.5, slope: 0.72, mu: 0.30, eps: 1.8, dep: 0.10, vol: 0.02, entryX: 0.5,
          pos: { B: 0.35, D: 0.25 } },
        { id: "pmt", name: "Pièces moteurs thermiques", group: "meca", D0: 800, path: [[0, -0.01], [5, -0.04], [10, -0.08], [20, -0.08]], capex: 1.0, slope: 0.85, mu: 0.27, eps: 1.6, dep: 0.08, vol: 0.012,
          pos: { P: 0.35, C: 0.40, D: 0.25 } },
        { id: "cap", name: "Capteurs industriels", group: "elec", D0: 300, path: [[0, 0.08], [20, 0.05]], capex: 1.1, slope: 0.78, mu: 0.28, eps: 1.6, dep: 0.09, vol: 0.012,
          pos: { P: 0.15, A: 0.40, B: 0.25, D: 0.20 } },
        { id: "med", name: "Dispositifs médicaux", group: "med", D0: 350, path: [[0, 0.06], [20, 0.055]], capex: 1.2, slope: 0.80, mu: 0.36, eps: 1.4, dep: 0.08, vol: 0.008, perBonus: 4,
          pos: { A: 0.30, C: 0.25, D: 0.45 } }
      ],
      scripted: [
        { t: 6, text: "Les normes d'émissions et les zones à faibles émissions accélèrent le recul des motorisations thermiques ; la demande de stockage d'énergie en profite.",
          gShift: { pmt: -0.03, bat: 0.03 } }
      ]
    },
    {
      id: "transport",
      difficulty: "Intermédiaire",
      title: "Transport terrestre longue distance",
      kicker: "Challenger face aux opérateurs historiques",
      pitch: "Leader européen de l'autocar, vous pouvez entrer sur la grande vitesse ferroviaire que l'ouverture à la concurrence rend accessible. Les opérateurs historiques ont l'expérience et les moyens ; le régulateur leur interdit en revanche de renforcer leurs monopoles.",
      startYear: 2027,
      params: { cap: 0.65, rate: 0.030, overdraft: 0.15 },
      companies: [
        { id: "P", name: "Arvéo Mobilités", color: "#C8432B", player: true, cash: 0.70, payout: 0.20 },
        { id: "A", name: "Ferovia", color: "#2F6E96", persona: "gardien", cash: 0.05, debt: 0.60, debtYears: 8 },
        { id: "B", name: "Bahnwerk", color: "#5A6B7A", persona: "rentier", cash: 0.06, debt: 0.50, debtYears: 8 },
        { id: "C", name: "Iberrail", color: "#A88328", persona: "opportuniste", cash: 0.08, debt: 0.40, debtYears: 7 },
        { id: "D", name: "Rotaia", color: "#7A5AA6", persona: "conquerant", cash: 0.10, debt: 0.40, debtYears: 7 }
      ],
      segments: [
        { id: "gvfr", name: "Grande vitesse France", group: "rail", D0: 900, path: [[0, 0.03], [20, 0.025]], capex: 2.4, slope: 0.90, mu: 0.24, eps: 1.4, dep: 0.05, vol: 0.010, H: 10, entryX: 0.8,
          pos: { A: 0.85, D: 0.15 } },
        { id: "gvde", name: "Grande vitesse Allemagne", group: "rail", D0: 700, path: [[0, 0.04], [20, 0.03]], capex: 2.4, slope: 0.90, mu: 0.24, eps: 1.4, dep: 0.05, vol: 0.010, H: 10, entryX: 0.8,
          pos: { B: 0.90, A: 0.10 } },
        { id: "gves", name: "Grande vitesse Espagne", group: "rail", D0: 450, path: [[0, 0.09], [8, 0.06], [20, 0.035]], capex: 2.4, slope: 0.90, mu: 0.25, eps: 1.4, dep: 0.05, vol: 0.012, H: 8, entryX: 0.8,
          pos: { C: 0.60, A: 0.20, D: 0.20 } },
        { id: "gvit", name: "Grande vitesse Italie", group: "rail", D0: 500, path: [[0, 0.05], [20, 0.035]], capex: 2.4, slope: 0.90, mu: 0.24, eps: 1.4, dep: 0.05, vol: 0.010, H: 10, entryX: 0.8,
          pos: { D: 0.72, A: 0.28 } },
        { id: "icfr", name: "Intercités France", group: "rail", D0: 400, path: [[0, -0.02], [20, -0.03]], capex: 1.6, slope: 0.88, mu: 0.20, eps: 1.3, dep: 0.06, vol: 0.010, H: 12,
          pos: { A: 0.90, P: 0.10 } },
        { id: "icde", name: "Intercités Allemagne", group: "rail", D0: 450, path: [[0, 0.01], [20, 0.0]], capex: 1.6, slope: 0.88, mu: 0.20, eps: 1.3, dep: 0.06, vol: 0.010, H: 12,
          pos: { B: 0.85, P: 0.15 } },
        { id: "icsud", name: "Intercités Europe du Sud", group: "rail", D0: 300, path: [[0, 0.0], [20, 0.01]], capex: 1.6, slope: 0.88, mu: 0.20, eps: 1.3, dep: 0.06, vol: 0.010, H: 12,
          pos: { C: 0.55, D: 0.45 } },
        { id: "car", name: "Autocars longue distance", group: "car", D0: 350, path: [[0, 0.08], [8, 0.05], [20, 0.03]], capex: 0.8, slope: 0.88, mu: 0.22, eps: 1.7, dep: 0.12, vol: 0.015, H: 6, entryX: 0.55,
          pos: { P: 0.45, D: 0.20, A: 0.20, B: 0.15 } }
      ],
      scripted: [
        { t: 3, text: "Flambée du prix de l'énergie de traction : les coûts d'exploitation ferroviaires bondissent de 8 % cette année.",
          cost: { gvfr: 1.08, gvde: 1.08, gves: 1.08, gvit: 1.08, icfr: 1.08, icde: 1.08, icsud: 1.08 } },
        { t: 7, text: "Politique de report modal : les États subventionnent la grande vitesse au détriment de l'aérien court-courrier.",
          gShift: { gvfr: 0.015, gvde: 0.015, gves: 0.015, gvit: 0.015 } }
      ]
    },
    {
      id: "froid",
      difficulty: "Difficile",
      title: "Froid commercial européen",
      kicker: "Leader national face à la transition des fluides",
      pitch: "Leader français du meuble frigorifique, vous êtes présent partout en Europe mais rarement en tête. La réglementation sur les fluides frigorigènes condamne les vitrines HFC et fait exploser les centrales CO₂ transcritiques, où un concurrent nordique a pris de l'avance. Les services, peu capitalistiques, sont valorisés par le marché.",
      startYear: 2027,
      params: { cap: 0.55, rate: 0.030, overdraft: 0.12 },
      companies: [
        { id: "P", name: "Frigéa Group", color: "#C8432B", player: true, cash: 0.09, debt: 0.20, debtYears: 5, payout: 0.30 },
        { id: "A", name: "Kaltwerk", color: "#2F6E96", persona: "gardien", cash: 0.08, debt: 0.15, debtYears: 6 },
        { id: "B", name: "Polaris Retail Systems", color: "#7A5AA6", persona: "conquerant", cash: 0.07, debt: 0.35, debtYears: 7 },
        { id: "C", name: "Frioli", color: "#A88328", persona: "rentier", cash: 0.12 },
        { id: "D", name: "Nordkyl", color: "#2E8A6A", persona: "diversifieur", cash: 0.08, debt: 0.10, debtYears: 5 }
      ],
      segments: [
        { id: "mfr", name: "Meubles frigorifiques France", group: "meuble", D0: 500, path: [[0, 0.01], [20, 0.01]], capex: 0.8, slope: 0.82, mu: 0.25, eps: 1.6, dep: 0.08, vol: 0.010,
          pos: { P: 0.45, A: 0.15, B: 0.15, C: 0.25 } },
        { id: "mde", name: "Meubles frigorifiques DACH", group: "meuble", D0: 600, path: [[0, 0.015], [20, 0.01]], capex: 0.8, slope: 0.82, mu: 0.25, eps: 1.6, dep: 0.08, vol: 0.010,
          pos: { A: 0.50, P: 0.10, D: 0.20, B: 0.20 } },
        { id: "msud", name: "Meubles frigorifiques Europe du Sud", group: "meuble", D0: 450, path: [[0, 0.02], [20, 0.015]], capex: 0.8, slope: 0.82, mu: 0.25, eps: 1.6, dep: 0.08, vol: 0.012,
          pos: { C: 0.45, P: 0.20, A: 0.15, B: 0.20 } },
        { id: "muk", name: "Meubles frigorifiques Royaume-Uni", group: "meuble", D0: 350, path: [[0, 0.01], [20, 0.01]], capex: 0.8, slope: 0.82, mu: 0.25, eps: 1.6, dep: 0.08, vol: 0.012,
          pos: { B: 0.40, P: 0.15, A: 0.20, D: 0.25 } },
        { id: "co2", name: "Centrales CO₂ transcritiques", group: "centrale", D0: 250, path: [[0, 0.15], [6, 0.12], [12, 0.06], [20, 0.04]], capex: 1.0, slope: 0.75, mu: 0.30, eps: 1.7, dep: 0.09, vol: 0.015, entryX: 0.4,
          pos: { D: 0.45, A: 0.25, P: 0.15, B: 0.15 } },
        { id: "hfc", name: "Vitrines groupe logé HFC", group: "meuble", D0: 300, path: [[0, -0.05], [5, -0.08], [10, -0.12], [20, -0.12]], capex: 0.7, slope: 0.85, mu: 0.25, eps: 1.6, dep: 0.09, vol: 0.010,
          pos: { C: 0.40, P: 0.30, B: 0.30 } },
        { id: "srv", name: "Services et maintenance", group: "service", D0: 400, path: [[0, 0.05], [20, 0.045]], capex: 0.4, slope: 0.90, mu: 0.30, eps: 1.3, dep: 0.15, vol: 0.008, perBonus: 5, entryX: 0.5,
          pos: { P: 0.25, A: 0.25, B: 0.30, C: 0.20 } },
        { id: "chf", name: "Chambres froides", group: "centrale", D0: 250, path: [[0, 0.02], [20, 0.02]], capex: 0.9, slope: 0.84, mu: 0.25, eps: 1.5, dep: 0.08, vol: 0.010,
          pos: { C: 0.30, D: 0.30, A: 0.40 } }
      ],
      scripted: [
        { t: 4, text: "Révision du règlement F-gaz : interdiction anticipée des HFC dans les vitrines neuves. Les centrales CO₂ deviennent la norme.",
          gShift: { hfc: -0.06, co2: 0.03 } }
      ]
    },
    {
      id: "auto",
      difficulty: "Difficile",
      title: "Automobile européenne",
      kicker: "Financer la bascule électrique",
      pitch: "Généraliste européen, vous dominez les citadines thermiques, les utilitaires et l'après-vente. Ces métiers financent le groupe mais l'interdiction programmée des moteurs thermiques les condamne. Un constructeur asiatique a pris de l'avance sur l'électrique et les batteries. Il faut décider quoi exploiter, quoi abandonner et où investir pendant qu'il reste du cash.",
      startYear: 2027,
      params: { cap: 0.55, rate: 0.030, overdraft: 0.12 },
      companies: [
        { id: "P", name: "Valmont Automobiles", color: "#C8432B", player: true, cash: 0.08, debt: 0.30, debtYears: 6, payout: 0.30 },
        { id: "A", name: "Hartwig Motoren", color: "#2F6E96", persona: "gardien", cash: 0.10, debt: 0.20, debtYears: 6 },
        { id: "B", name: "Kaishan Motors", color: "#7A5AA6", persona: "conquerant", cash: 0.10, debt: 0.25, debtYears: 7 },
        { id: "C", name: "Ostrava Auto", color: "#A88328", persona: "rentier", cash: 0.10 },
        { id: "D", name: "Aldren Mobility", color: "#2E8A6A", persona: "diversifieur", cash: 0.08, debt: 0.15, debtYears: 5 }
      ],
      segments: [
        { id: "cth", name: "Citadines thermiques", group: "thermique", D0: 700, path: [[0, -0.03], [5, -0.07], [10, -0.12], [20, -0.12]], capex: 0.9, slope: 0.85, mu: 0.20, eps: 1.6, dep: 0.08, vol: 0.012,
          pos: { P: 0.40, C: 0.35, A: 0.10, D: 0.15 } },
        { id: "sth", name: "Berlines et SUV thermiques", group: "thermique", D0: 900, path: [[0, -0.01], [5, -0.05], [10, -0.10], [20, -0.10]], capex: 1.0, slope: 0.85, mu: 0.26, eps: 1.5, dep: 0.08, vol: 0.012,
          pos: { A: 0.45, P: 0.20, C: 0.20, D: 0.15 } },
        { id: "utl", name: "Utilitaires légers", group: "thermique", D0: 400, path: [[0, 0.02], [10, 0.0], [20, -0.03]], capex: 0.9, slope: 0.85, mu: 0.22, eps: 1.5, dep: 0.08, vol: 0.012,
          pos: { P: 0.40, C: 0.30, A: 0.30 } },
        { id: "cve", name: "Compactes électriques", group: "electrique", D0: 250, path: [[0, 0.20], [6, 0.15], [12, 0.08], [20, 0.04]], capex: 1.3, slope: 0.78, mu: 0.24, eps: 1.7, dep: 0.10, vol: 0.020, entryX: 0.5,
          pos: { B: 0.45, D: 0.25, P: 0.15, A: 0.15 } },
        { id: "sve", name: "SUV électriques", group: "electrique", D0: 300, path: [[0, 0.16], [6, 0.12], [12, 0.07], [20, 0.04]], capex: 1.4, slope: 0.80, mu: 0.28, eps: 1.6, dep: 0.10, vol: 0.020, entryX: 0.5,
          pos: { A: 0.40, B: 0.35, D: 0.25 } },
        { id: "btr", name: "Batteries de traction", group: "batterie", D0: 200, path: [[0, 0.22], [6, 0.15], [12, 0.07], [20, 0.04]], capex: 1.6, slope: 0.72, mu: 0.26, eps: 1.8, dep: 0.10, vol: 0.025, entryX: 0.4,
          pos: { B: 0.70, D: 0.30 } },
        { id: "apv", name: "Pièces et après-vente", group: "service", D0: 350, path: [[0, 0.03], [20, 0.01]], capex: 0.5, slope: 0.88, mu: 0.32, eps: 1.3, dep: 0.10, vol: 0.008, perBonus: 4,
          pos: { P: 0.30, A: 0.30, C: 0.25, D: 0.15 } },
        { id: "logi", name: "Logiciel et services connectés", group: "logiciel", D0: 80, path: [[0, 0.18], [8, 0.12], [20, 0.06]], capex: 0.4, slope: 0.70, mu: 0.38, eps: 1.4, dep: 0.20, vol: 0.030, perBonus: 3, entryX: 0.5,
          pos: { D: 0.40, A: 0.30, B: 0.15, P: 0.15 } }
      ],
      scripted: [
        { t: 4, text: "L'Union confirme la fin des ventes de voitures thermiques neuves et durcit les normes intermédiaires : la demande thermique recule plus vite, l'électrique accélère.",
          gShift: { cth: -0.03, sth: -0.03, utl: -0.02, cve: 0.02, sve: 0.02, btr: 0.02 } },
        { t: 7, text: "Effondrement du prix du lithium : le coût des batteries baisse de 15 %, celui des véhicules électriques de 8 % cette année.",
          cost: { btr: 0.85, cve: 0.92, sve: 0.92 } }
      ]
    },
    {
      id: "numerique",
      difficulty: "Intermédiaire",
      title: "Numérique et cloud",
      kicker: "Services informatiques face aux plateformes",
      pitch: "Champion européen de l'intégration et de l'infogérance, vous êtes rentable mais faiblement valorisé : ces métiers croissent peu et le marché les paie mal. Les logiciels et la cybersécurité valent bien plus, le cloud est verrouillé par une plateforme américaine, et les puces pour l'intelligence artificielle s'arrachent. Reste à savoir si cet engouement va durer.",
      startYear: 2027,
      params: { cap: 0.60, rate: 0.030, overdraft: 0.12 },
      companies: [
        { id: "P", name: "Sorevia", color: "#C8432B", player: true, cash: 0.10, debt: 0.20, debtYears: 5, payout: 0.30 },
        { id: "A", name: "Kalder Systems", color: "#2F6E96", persona: "gardien", cash: 0.10, debt: 0.15, debtYears: 6 },
        { id: "B", name: "Northgate Cloud", color: "#7A5AA6", persona: "conquerant", cash: 0.12, debt: 0.20, debtYears: 7 },
        { id: "C", name: "Marbeck Data", color: "#A88328", persona: "opportuniste", cash: 0.08, debt: 0.20, debtYears: 6 },
        { id: "D", name: "Ilios Tech", color: "#2E8A6A", persona: "diversifieur", cash: 0.09, debt: 0.10, debtYears: 5 }
      ],
      segments: [
        { id: "itg", name: "Intégration et infogérance", group: "service", D0: 700, path: [[0, 0.02], [20, 0.01]], capex: 0.3, slope: 0.93, mu: 0.14, eps: 1.4, dep: 0.15, vol: 0.010,
          pos: { P: 0.40, C: 0.25, A: 0.20, D: 0.15 } },
        { id: "hw", name: "Serveurs et stockage", group: "materiel", D0: 500, path: [[0, 0.03], [20, 0.01]], capex: 0.9, slope: 0.82, mu: 0.22, eps: 1.6, dep: 0.10, vol: 0.012,
          pos: { A: 0.45, P: 0.20, C: 0.20, D: 0.15 } },
        { id: "cld", name: "Cloud d'infrastructure", group: "cloud", D0: 400, path: [[0, 0.18], [8, 0.12], [20, 0.06]], capex: 1.8, slope: 0.74, mu: 0.30, eps: 1.6, dep: 0.12, vol: 0.015, entryX: 0.4,
          pos: { B: 0.60, A: 0.25, D: 0.15 } },
        { id: "csv", name: "Cloud souverain", group: "cloud", D0: 60, path: [[0, 0.12], [20, 0.08]], capex: 1.6, slope: 0.78, mu: 0.30, eps: 1.5, dep: 0.12, vol: 0.020, entryX: 0.5, perBonus: 2,
          pos: { C: 0.50, P: 0.25, D: 0.25 } },
        { id: "saas", name: "Logiciels d'entreprise", group: "logiciel", D0: 300, path: [[0, 0.12], [10, 0.09], [20, 0.05]], capex: 0.4, slope: 0.72, mu: 0.34, eps: 1.3, dep: 0.20, vol: 0.015, perBonus: 5, entryX: 0.5,
          pos: { A: 0.35, D: 0.30, B: 0.20, P: 0.15 } },
        { id: "cyb", name: "Cybersécurité", group: "logiciel", D0: 150, path: [[0, 0.15], [10, 0.11], [20, 0.07]], capex: 0.4, slope: 0.75, mu: 0.36, eps: 1.3, dep: 0.20, vol: 0.015, perBonus: 6, entryX: 0.5,
          pos: { D: 0.40, C: 0.35, A: 0.25 } },
        { id: "puce", name: "Puces pour l'intelligence artificielle", group: "puce", D0: 150, path: [[0, 0.30], [4, 0.25], [8, 0.10], [20, 0.05]], capex: 2.0, slope: 0.70, mu: 0.34, eps: 2.0, dep: 0.14, vol: 0.040, entryX: 0.3,
          pos: { B: 0.55, A: 0.45 } }
      ],
      scripted: [
        { t: 3, text: "Règlement européen sur la souveraineté des données : la commande publique et les secteurs régulés doivent recourir à un cloud hébergé et opéré en Europe.",
          gShift: { csv: 0.06 } },
        { t: 8, text: "Les centres de données ont surinvesti : les commandes de puces pour l'intelligence artificielle s'effondrent cette année et la croissance du créneau ne retrouvera pas son rythme.",
          g: { puce: -0.20 }, gShift: { puce: -0.08 } }
      ]
    },
    {
      id: "pharma",
      difficulty: "Difficile",
      title: "Laboratoire pharmaceutique",
      kicker: "Préparer la falaise des brevets",
      pitch: "Votre laboratoire vit de sa franchise cardiovasculaire, très rentable, et de la santé grand public. Les brevets des molécules phares expirent dans quelques exercices : les génériques prendront alors l'essentiel du marché. L'oncologie, les biosimilaires et les thérapies géniques sont valorisés par le marché mais exigent des investissements lourds où des biotechs ont déjà l'avance.",
      startYear: 2027,
      params: { cap: 0.60, rate: 0.030, overdraft: 0.12 },
      companies: [
        { id: "P", name: "Laboratoires Berthier", color: "#C8432B", player: true, cash: 0.12, debt: 0.15, debtYears: 5, payout: 0.40 },
        { id: "A", name: "Helvexa", color: "#2F6E96", persona: "gardien", cash: 0.10, debt: 0.15, debtYears: 6 },
        { id: "B", name: "Castoria Biotech", color: "#7A5AA6", persona: "conquerant", cash: 0.10, debt: 0.30, debtYears: 7 },
        { id: "C", name: "Genovo", color: "#A88328", persona: "rentier", cash: 0.10 },
        { id: "D", name: "Medrill", color: "#2E8A6A", persona: "diversifieur", cash: 0.08, debt: 0.15, debtYears: 5 }
      ],
      segments: [
        { id: "cvx", name: "Cardiologie de marque", group: "marque", D0: 600, path: [[0, 0.02], [20, 0.0]], capex: 0.8, slope: 0.85, mu: 0.40, eps: 1.2, dep: 0.10, vol: 0.010, perBonus: 2,
          pos: { P: 0.55, A: 0.30, D: 0.15 } },
        { id: "gen", name: "Génériques", group: "generique", D0: 500, path: [[0, 0.04], [20, 0.03]], capex: 0.6, slope: 0.88, mu: 0.12, eps: 1.8, dep: 0.08, vol: 0.010,
          pos: { C: 0.50, D: 0.25, A: 0.25 } },
        { id: "otc", name: "Santé grand public", group: "conso", D0: 350, path: [[0, 0.03], [20, 0.025]], capex: 0.5, slope: 0.88, mu: 0.30, eps: 1.4, dep: 0.08, vol: 0.008, perBonus: 4,
          pos: { P: 0.35, A: 0.25, D: 0.40 } },
        { id: "vac", name: "Vaccins", group: "vaccin", D0: 200, path: [[0, 0.04], [20, 0.04]], capex: 1.2, slope: 0.82, mu: 0.30, eps: 1.5, dep: 0.10, vol: 0.060,
          pos: { A: 0.40, P: 0.30, D: 0.30 } },
        { id: "onco", name: "Oncologie", group: "bio", D0: 250, path: [[0, 0.10], [20, 0.07]], capex: 1.5, slope: 0.80, mu: 0.42, eps: 1.2, dep: 0.12, vol: 0.020, perBonus: 5, entryX: 0.35,
          pos: { B: 0.40, A: 0.35, P: 0.25 } },
        { id: "bios", name: "Biosimilaires", group: "bio", D0: 120, path: [[0, 0.15], [8, 0.10], [20, 0.05]], capex: 1.4, slope: 0.76, mu: 0.26, eps: 1.6, dep: 0.10, vol: 0.020, entryX: 0.4,
          pos: { C: 0.40, B: 0.35, D: 0.25 } },
        { id: "thg", name: "Thérapies géniques", group: "bio", D0: 30, path: [[0, 0.30], [5, 0.22], [10, 0.12], [20, 0.06]], capex: 1.8, slope: 0.70, mu: 0.45, eps: 1.4, dep: 0.14, vol: 0.050, perBonus: 3, entryX: 0.5,
          pos: { B: 0.60, D: 0.25, A: 0.15 } }
      ],
      scripted: [
        { t: 5, text: "Expiration des brevets des grands traitements cardiovasculaires : les génériques s'emparent du marché, la cardiologie de marque s'effondre cette année puis décline durablement.",
          g: { cvx: -0.15 }, gShift: { cvx: -0.07, gen: 0.03 } },
        { t: 9, text: "Épidémie saisonnière sévère : les commandes publiques de vaccins bondissent cette année.",
          g: { vac: 0.25 } }
      ]
    }
  ];

  const scenarioById = id => SCENARIOS.find(s => s.id === id);
  const segById = (G, id) => G.segments.find(s => s.id === id);
  const coById = (G, id) => G.companies.find(c => c.id === id);
  const lastH = co => co.hist[co.hist.length - 1];

  /* ---------- Paramètres par défaut du « banquier central » ---------- */
  const DEFAULT_PARAMS = {
    tax: 0.25, rate: 0.03, maxDE: 1.5, ebitdaMult: 3, maxLoanYears: 8,
    maxDil: 0.20, maxBuyback: 0.10, cap: 0.55, recov: 0.40, issueDisc: 0.10,
    bcgG: 0.05, overdraft: 0.12, odPremium: 0.04,
    disRecov: 0.75, disFloor: 0.50, maxDisinv: 0.50,
    floorBase: 0.4, floorSlope: 4, groupX: 0.25
  };

  /* Désinvestissement : actifs cédés avec décote, plus forte quand le créneau est en
     surcapacité (personne n'a besoin de ces capacités). Plafonné par exercice : sortir
     d'un créneau d'un coup passe par la vente ou la fermeture de la division. */
  function disinvestRate(G, seg) {
    const p = G.params;
    return clamp(p.disRecov - 0.8 * Math.max(0, (seg.r || 1) - 1), p.disFloor, p.disRecov);
  }

  /* ---------- Économie d'un créneau ---------- */
  function effX(G, co, seg) {
    const d = co.div[seg.id];
    let x = d.X / seg.Xnorm;
    for (const sid in co.div) {
      if (sid === seg.id) continue;
      const s2 = segById(G, sid);
      if (s2.group === seg.group) x += G.params.groupX * co.div[sid].X / s2.Xnorm;
    }
    return Math.max(0.05, x);
  }

  function unitCost(G, co, seg) {
    return seg.cbase * (G.mods.c[seg.id] || 1) * Math.pow(effX(G, co, seg), Math.log2(seg.slope));
  }

  function runMarket(G, seg, t) {
    const players = G.companies.filter(c => c.alive && c.div[seg.id]);
    const S = sum(players, c => c.div[seg.id].K);
    const u = S > 0 ? Math.min(1, seg.D / S) : 0;
    let qT = 0, cq = 0;
    players.forEach(co => {
      const d = co.div[seg.id];
      d.q = d.K * u;
      d.c = unitCost(G, co, seg);
      qT += d.q; cq += d.q * d.c;
    });
    const avgC = qT > 0 ? cq / qT : seg.cbase;
    const r = seg.D > 0 ? S / seg.D : 1;
    const f = clamp(Math.pow(Math.max(r, 0.01), -seg.eps), 0.5, 1.45);
    const P = (avgC + seg.dep * seg.capex) * (1 + seg.mu) * f;
    // Régulation tarifaire : une société en position dominante ne peut pas facturer la
    // prime de pénurie ; elle vend au prix d'équilibre. Sans cela, le plafonnement de ses
    // investissements lui garantirait une rente de rareté.
    const Preg = G.params.priceCap === false ? P : Math.min(P, P / f);
    players.forEach(co => {
      const d = co.div[seg.id];
      d.share = qT > 0 ? d.q / qT : 0;
    });
    players.forEach(co => {
      const d = co.div[seg.id];
      d.rev = (d.share >= G.params.cap ? Preg : P) * d.q;
      d.opex = d.c * d.q;
      d.ebit = d.rev - d.opex - d.depT;
    });
    players.forEach(co => {
      const d = co.div[seg.id];
      let m = 0;
      players.forEach(o => { if (o !== co) m = Math.max(m, o.div[seg.id].share); });
      d.rs = m > 0 ? clamp(d.share / m, 0.01, 10) : 10;
    });
    seg.P = P; seg.S = S; seg.r = r; seg.u = u;
    seg.hist.push({ t, D: seg.D, g: seg.g, P, r, u, S, n: players.length });
  }

  function segTrend(seg) {
    const h = seg.hist;
    const n = Math.min(3, h.length);
    let g = 0;
    for (let i = h.length - n; i < h.length; i++) g += h[i].g;
    return n ? g / n : 0;
  }
  function segPER(seg) {
    return clamp(11 + 280 * segTrend(seg), 10, 45) + (seg.perBonus || 0);
  }
  /* Valeur plancher d'une division, en fraction de ses actifs : le marché paie des
     capacités installées dans un créneau qui croît, beaucoup moins dans un créneau qui décline. */
  function assetFloor(G, seg) {
    const p = G.params;
    return clamp(p.floorBase + p.floorSlope * segTrend(seg), p.floorBase, 1.0);
  }

  function forecastGrowth(G, seg, t) {
    return pathGrowth(seg.path, t) + seg.gShift + (G.mods.g[seg.id] || 0);
  }

  /* ---------- Banque ---------- */
  function maxLoan(G, co) {
    if (co.loan || co.pendingLoan) return 0;
    const h = lastH(co), p = G.params;
    const ebitda = h.ebit + h.dep;
    const eq = Math.max(0, h.equity);
    return Math.max(0, Math.min(p.ebitdaMult * ebitda, p.maxDE * eq));
  }
  function loanRate(G, co, amt) {
    const h = lastH(co);
    const debt = co.loan ? co.loan.out : 0;
    return G.params.rate + 0.015 + 0.02 * clamp((debt + amt) / Math.max(1, h.equity), 0, 2);
  }
  function loanTotal(P, rate, n) { return P + rate * P * (n + 1) / 2; }

  /* ---------- Valorisation ---------- */
  /* Somme des parties : chaque division vaut PER du créneau × résultat opérationnel
     normatif après impôt, sans descendre sous sa valeur plancher ; on ajoute la trésorerie et on
     retranche la dette. Un euro en caisse vaut donc un euro, et un investissement de
     conquête qui pèse sur les résultats n'est pas sanctionné au-delà de la décote des actifs. */
  function valuation(G, co) {
    const tax = G.params.tax;
    let rev = 0, w = 0, assets = 0, ev = 0;
    const parts = {};
    for (const sid in co.div) {
      const d = co.div[sid], seg = segById(G, sid), per = segPER(seg);
      rev += d.rev || 0; w += (d.rev || 0) * per; assets += d.A;
      // résultat normatif : moyenne des deux derniers exercices, pour lisser les à-coups
      const hh = d.hist || [], prev = hh.length >= 2 ? hh[hh.length - 2].ebit : d.ebit;
      const ebitN = 0.5 * ((d.ebit || 0) + (prev || 0));
      parts[sid] = Math.max(per * ebitN * (1 - tax), assetFloor(G, seg) * d.A);
      ev += parts[sid];
    }
    const PER = rev > 0 ? w / rev : 10;
    const debt = co.loan ? co.loan.out : 0;
    const equity = assets + co.cash - debt;
    const value = Math.max(ev + co.cash - debt, 0.25 * Math.max(0, equity));
    return { PER, equity, value, assets, debt, ev, parts };
  }

  /* ---------- Création d'une partie ---------- */
  function newGame(scId, opts) {
    opts = opts || {};
    const sc = scenarioById(scId);
    const seed = (opts.seed >>> 0) || ((Date.now() ^ 0x5bd1e995) >>> 0);
    const G = {
      v: VERSION, sc: sc.id, title: sc.title, seed, rng: seed | 0, rngAI: (seed ^ 0x9E3779B9) | 0,
      year: 0, T: opts.years || 15, startYear: sc.startYear || 2027,
      params: Object.assign({}, DEFAULT_PARAMS, sc.params || {}),
      segments: [], companies: [], listings: [], log: [], news: [],
      mods: { g: {}, c: {} }, over: false, bankrupt: false, nextListingId: 1, results: []
    };
    G.params.rate0 = G.params.rate;
    G.params.ai = { facile: 0.6, normal: 1, difficile: 1.3 }[opts.level || "normal"] || 1;
    G.level = opts.level || "normal";
    G.pinv = [];
    sc.segments.forEach(s => {
      const H = s.H || 8;
      G.segments.push({
        id: s.id, name: s.name, group: s.group || s.id, D: s.D0, D0: s.D0, path: s.path,
        capex: s.capex, cbase: s.cbase || 0.62, slope: s.slope, mu: s.mu, eps: s.eps, dep: s.dep,
        vol: s.vol || 0.012, entryX: s.entryX || 0.35, perBonus: s.perBonus || 0,
        Xnorm: 0.25 * s.D0 * H, gShift: 0, g: pathGrowth(s.path, 0), hist: []
      });
    });
    sc.companies.forEach(c => {
      G.companies.push({
        id: c.id, name: (c.player && opts.playerName) ? opts.playerName : c.name, color: c.color,
        player: !!c.player, persona: c.persona || null, alive: true, cash: 0, shares: 0,
        loan: null, pendingLoan: null, payout: c.payout != null ? c.payout : 0.3,
        div: {}, hist: [], dps: [], overdraft: 0, bankrupt: 0
      });
    });
    sc.segments.forEach(s => {
      const tot = sum(Object.values(s.pos));
      const H = s.H || 8;
      for (const cid in s.pos) {
        const share = s.pos[cid] / tot;
        const K = share * s.D0 / 0.97;
        const co = coById(G, cid);
        co.div[s.id] = {
          K, A: K * s.capex, X: share * s.D0 * H, share, rs: 1, lossYears: 0, unsold: 0,
          depT: s.dep * K * s.capex, inv: s.dep * K * s.capex, entered: -10, hist: []
        };
      }
    });
    G.segments.forEach(seg => runMarket(G, seg, 0));
    G.companies.forEach(co => {
      const c0 = sc.companies.find(c => c.id === co.id);
      let rev = 0, ebit = 0, dep = 0;
      for (const sid in co.div) {
        const d = co.div[sid];
        rev += d.rev; ebit += d.ebit; dep += d.depT;
        d.hist.push(divSnap(d, segById(G, sid), 0));
      }
      co.cash = (c0.cash || 0.08) * rev;
      co.overdraft = G.params.overdraft * rev;
      if (c0.debt) {
        const P = c0.debt * rev, n = c0.debtYears || 6;
        co.loan = { P0: P, out: P, rate: G.params.rate + 0.02, years: n, left: n, ann: P / n };
      }
      const interest = co.loan ? co.loan.out * co.loan.rate : 0;
      const intInc = Math.max(0, co.cash) * Math.max(0, G.params.rate - 0.01);
      const ebt = ebit - interest + intInc;
      const tax = Math.max(0, ebt) * G.params.tax;
      const npRec = ebt - tax;
      const val = valuation(G, co);
      co.shares = Math.max(1, val.value / 10);
      co.hist.push({
        t: 0, rev, ebit, dep, interest, intInc, tax, npRec, exc: 0, np: npRec, dividends: 0, inv: dep,
        cash: co.cash, debt: val.debt, equity: val.equity, assets: val.assets, value: val.value, PER: val.PER,
        price: val.value / co.shares, dps: 0, score: val.value / co.shares, shares: co.shares,
        issue: 0, buyback: 0, ma: 0, payout: co.payout, ev: val.ev, parts: val.parts
      });
    });
    genNews(G, 1);
    return G;
  }

  function divSnap(d, seg, t) {
    return { t, K: d.K, q: d.q, share: d.share, rs: d.rs, rev: d.rev, ebit: d.ebit, c: d.c, inv: d.inv || 0, A: d.A, P: seg.P, u: seg.u, dep: d.depT };
  }

  /* ---------- Actualités / événements ---------- */
  function applyEvent(G, ev) {
    if (ev.g) for (const k in ev.g) {
      if (k === "*") G.segments.forEach(s => { G.mods.g[s.id] = (G.mods.g[s.id] || 0) + ev.g[k]; });
      else G.mods.g[k] = (G.mods.g[k] || 0) + ev.g[k];
    }
    if (ev.cost) for (const k in ev.cost) {
      if (k === "*") G.segments.forEach(s => { G.mods.c[s.id] = (G.mods.c[s.id] || 1) * ev.cost[k]; });
      else G.mods.c[k] = (G.mods.c[k] || 1) * ev.cost[k];
    }
    if (ev.gShift) for (const k in ev.gShift) { const s = segById(G, k); if (s) s.gShift += ev.gShift[k]; }
    if (ev.rate) G.params.rate = clamp(G.params.rate + ev.rate, 0.005, 0.09);
    if (ev.cap) G.params.cap = clamp(G.params.cap + ev.cap, 0.40, 0.80);
  }

  function genNews(G, t) {
    G.mods = { g: {}, c: {} };
    G.news = [];
    const sc = scenarioById(G.sc);
    (sc.scripted || []).filter(e => e.t === t).forEach(e => {
      const ev = Object.assign({ kind: "secteur" }, e);
      applyEvent(G, ev); G.news.push({ t, kind: ev.kind, text: ev.text });
    });
    if (t >= 2 && rnd(G) < 0.45) {
      const segs = G.segments;
      const s = pick(G, segs);
      const pool = [
        () => ({ kind: "conjoncture", text: "Récession : la demande recule dans tous les créneaux cette année (−4 points de croissance).", g: { "*": -0.04 } }),
        () => ({ kind: "conjoncture", text: "Reprise vigoureuse : la demande accélère partout cette année (+3 points de croissance).", g: { "*": 0.03 } }),
        () => ({ kind: "coûts", text: "Choc sur les matières premières : coûts d'exploitation +10 % dans tous les créneaux cette année.", cost: { "*": 1.10 } }),
        () => ({ kind: "banque", text: "La banque centrale relève son taux directeur de 1,5 point. Les nouveaux emprunts coûteront plus cher.", rate: 0.015 }),
        () => ({ kind: "banque", text: "La banque centrale abaisse son taux directeur d'un point.", rate: -0.01 }),
        () => ({ kind: "technologie", text: "Rupture technologique dans « " + s.name + " » : la croissance tendancielle du créneau perd 4 points, durablement.", gShift: { [s.id]: -0.04 } }),
        () => ({ kind: "marché", text: "Nouveaux usages dans « " + s.name + " » : +6 points de croissance cette année, +1 point durablement.", g: { [s.id]: 0.06 }, gShift: { [s.id]: 0.01 } }),
        () => ({ kind: "régulation", text: "L'autorité de la concurrence durcit sa doctrine : le seuil de position dominante baisse de 5 points.", cap: -0.05 })
      ];
      const ev = pick(G, pool)();
      applyEvent(G, ev);
      G.news.push({ t, kind: ev.kind, text: ev.text });
    }
    G.news.forEach(n => G.log.push(n));
  }

  /* ---------- Décision par défaut du joueur ---------- */
  function defaultDecision(G, co) {
    const dec = { invest: {}, disinvest: {}, divest: {}, payout: co.payout, loan: null, issuePct: 0, buybackPct: 0, bids: {} };
    for (const sid in co.div) {
      const seg = segById(G, sid), d = co.div[sid];
      dec.invest[sid] = Math.round(seg.dep * d.A);
    }
    return dec;
  }

  /* ---------- Repères d'investissement pour le joueur ---------- */
  function investHints(G, co, sid) {
    const seg = segById(G, sid), d = co.div[sid], t = G.year + 1;
    const gF = forecastGrowth(G, seg, t);
    const Dn = seg.D * (1 + gF);
    if (!d) {
      const entry = 0.08 * Dn / 0.97 * seg.capex;
      return { maint: 0, follow: 0, plus5: Math.round(0.05 * Dn / 0.97 * seg.capex), entry: Math.round(entry), gF };
    }
    const Kafter = d.A * (1 - seg.dep) / seg.capex;
    const need = s => Math.max(0, Math.round((s * Dn / 0.97 - Kafter) * seg.capex));
    return { maint: Math.round(seg.dep * d.A), follow: need(d.share), plus5: need(d.share + 0.05), gF };
  }

  /* ---------- IA des concurrents ---------- */
  function aiDecide(G, co) {
    if (G.preview) return neutralDecision(G, co);
    const p = G.params, t = G.year + 1, k = p.ai || 1;
    const P = Object.assign({}, PERSONAS[co.persona]);
    P.aggr *= k; P.push *= k; P.entry = Math.min(0.9, P.entry * k); P.odUse *= k;
    const h = lastH(co);
    const dec = { invest: {}, disinvest: {}, divest: {}, payout: P.payout, loan: null, issuePct: 0, buybackPct: 0, bids: {} };
    if (co.cash < 0) dec.payout = 0;
    const safety = 0.03 * h.rev;
    let free = co.cash - safety + P.odUse * co.overdraft;

    // enchères sur les divisions à vendre
    G.listings.forEach(L => {
      if (L.seller === co.id) return;
      const seller = coById(G, L.seller);
      if (!seller.alive && !L.liq) return;
      const ld = seller.div[L.seg];
      if (!ld) return;
      const seg = segById(G, L.seg);
      const own = co.div[L.seg];
      if ((own ? own.share : 0) + ld.share > p.cap - 0.01) return;
      const gF = forecastGrowth(G, seg, t);
      const interest = own ? 1 : ((gF > 0.04 && P.entry > 0) ? 0.6 : (P.bidBoost ? 0.4 : 0));
      if (!interest) return;
      const val = ld.A * (0.45 + 0.25 * interest + clamp(gF * 3, -0.15, 0.3) + (P.bidBoost || 0)) * (0.9 + 0.2 * rnd(G, "rngAI"));
      const amt = Math.min(val, Math.max(0, co.cash - safety) * 0.6);
      if (amt > 0 && amt >= L.minPrice) { dec.bids[L.id] = Math.round(amt); free -= amt; }
    });

    const cf = (h.npRec > 0 ? h.npRec * (1 - dec.payout) : h.npRec) + h.dep - (co.loan ? co.loan.ann : 0);
    // les profils expansionnistes ne misent qu'une partie du cash-flow attendu : un bon
    // exercice ne se reproduit pas forcément, et leurs propres capacités pèsent sur les prix
    let budget = free + (cf > 0 ? (P.cfUse || 1) * cf : cf);

    const wants = [];
    for (const sid in co.div) {
      const d = co.div[sid], seg = segById(G, sid);
      if (G.listings.some(l => l.seller === co.id && l.seg === sid)) continue;
      const gF = 0.5 * seg.g + 0.5 * forecastGrowth(G, seg, t);
      if (d.lossYears >= P.exitPatience && d.rs < 0.7 && gF < 0.06 && t - d.entered > 4) {
        if (d.unsold >= 1) dec.divest[sid] = { mode: "liq" };
        else dec.divest[sid] = { mode: "auction", min: Math.round(0.45 * d.A) };
        continue;
      }
      let mult;
      if (d.rs >= 1) mult = 1 + P.push * clamp(gF * 4, 0, 0.5);
      else mult = 1 + P.aggr * clamp(gF * 5, -0.3, 0.8);
      if (seg.r < 0.93) mult += 0.15 + 0.5 * (0.93 - seg.r);
      else if (seg.r > 1.12 && d.rs < 1) mult = Math.min(mult, 1);
      if (gF < P.harvestG && d.rs < P.harvestRS) {
        mult = Math.min(mult, 0.85);
        if (d.lossYears >= 1 && d.rs < 0.5) { dec.disinvest[sid] = Math.round(0.25 * d.A); continue; }
      }
      let target = d.share * mult;
      if (t - d.entered < 4) target = Math.max(target, P.entryShare);
      target = Math.min(target, Math.max(d.share, p.cap - 0.02));
      const Kreq = target * seg.D * (1 + gF) / P.util;
      const Kafter = d.A * (1 - seg.dep) / seg.capex;
      let inv = Math.max(0, (Kreq - Kafter) * seg.capex);
      if (d.share >= p.cap) inv = Math.min(inv, seg.dep * d.A);
      const maint = Math.min(inv, seg.dep * d.A);
      wants.push({ sid, inv: maint, pr: 3 });
      if (inv > maint) wants.push({ sid, inv: inv - maint, pr: d.rs >= 1 ? 2 : 1 });
    }
    if (P.entry > 0 && t >= 2 && rnd(G, "rngAI") < P.entry) {
      const cands = G.segments.filter(s => !co.div[s.id] && forecastGrowth(G, s, t) > 0.05);
      if (cands.length) {
        cands.sort((a, b) => forecastGrowth(G, b, t) - forecastGrowth(G, a, t));
        const s = cands[0];
        const inv = P.entryShare * s.D * (1 + forecastGrowth(G, s, t)) / P.util * s.capex;
        if (inv < 0.6 * Math.max(0, budget) + 0.3 * h.rev) wants.push({ sid: s.id, inv, pr: 1.5 });
      }
    }
    const total = sum(wants, w => w.inv);
    if (total > budget) {
      const gap = total - budget;
      if (P.debt && !co.loan && !co.pendingLoan) {
        const amt = Math.min(maxLoan(G, co), gap * 1.5 + 0.1 * h.rev);
        if (amt > 0.02 * h.rev) dec.loan = { amount: Math.round(amt), years: P.loanYears };
      }
      if (P.equity && gap > 0.08 * h.rev && h.price > 1) {
        const pct = Math.min(p.maxDil, gap / (co.shares * h.price * (1 - p.issueDisc)));
        if (pct > 0.03) { dec.issuePct = pct; budget += co.shares * pct * h.price * (1 - p.issueDisc); }
      }
      if (P.flexDiv && dec.payout > 0 && h.npRec > 0) {
        budget += 0.5 * dec.payout * h.npRec; dec.payout *= 0.5;
      }
    }
    let rem = Math.max(0, budget);
    [3, 2, 1.5, 1].forEach(pr => {
      const grp = wants.filter(w => w.pr === pr);
      const need = sum(grp, w => w.inv);
      const k = need > 0 ? Math.min(1, rem / need) : 0;
      grp.forEach(w => { dec.invest[w.sid] = (dec.invest[w.sid] || 0) + Math.round(w.inv * k); });
      rem -= need * k;
    });
    if (P.buyback && !co.loan && co.cash > total + 0.25 * h.rev && h.price > 0) dec.buybackPct = Math.min(p.maxBuyback, 0.03);
    return dec;
  }

  /* ---------- Aperçu de l'exercice ----------
     Hypothèses affichées au joueur : conjoncture sans aléa, concurrents qui investissent
     ce qu'il faut pour garder leur part, sans entrée, cession ni rachat. L'aperçu ne révèle
     donc ni l'aléa de demande ni les décisions réelles des concurrents. */
  function neutralDecision(G, co) {
    const dec = { invest: {}, disinvest: {}, divest: {}, payout: PERSONAS[co.persona] ? PERSONAS[co.persona].payout : 0.3, loan: null, issuePct: 0, buybackPct: 0, bids: {} };
    for (const sid in co.div) dec.invest[sid] = investHints(G, co, sid).follow;
    return dec;
  }
  function preview(G, playerDec) {
    const H = JSON.parse(JSON.stringify(G));
    H.preview = true;
    H.segments.forEach(s => { s.vol = 0; });
    H.listings = H.listings.filter(l => l.seller === H.companies.find(c => c.player).id);
    const R = simulateYear(H, playerDec);
    const co = H.companies.find(c => c.player);
    return { G: H, R, co, h: lastH(co) };
  }

  /* ---------- Décomposition de la variation du cours ----------
     Exacte : Δcours = Σ divisions Δvaleur / N₀ + Δtrésorerie nette / N₀ + effet du nombre
     d'actions + reste (plancher de fonds propres). */
  function priceBridge(co) {
    const H = co.hist, n = H.length;
    if (n < 2) return null;
    const h1 = H[n - 1], h0 = H[n - 2], N0 = h0.shares, N1 = h1.shares;
    if (!h1.parts || !h0.parts) return null;
    const divs = {};
    const ids = new Set(Object.keys(h0.parts).concat(Object.keys(h1.parts)));
    ids.forEach(sid => { divs[sid] = ((h1.parts[sid] || 0) - (h0.parts[sid] || 0)) / N0; });
    const flows = {
      caf: (h1.npRec + h1.dep) / N0, inv: -h1.inv / N0, div: -h1.dividends / N0,
      ma: ((h1.ma || 0) + (h1.disinv || 0)) / N0, capital: ((h1.issue || 0) - (h1.buyback || 0)) / N0
    };
    const nc0 = h0.cash - h0.debt, nc1 = h1.cash - h1.debt;
    const V1 = h1.value;
    const shares = V1 / N1 - V1 / N0;
    const rest = (h1.price - h0.price) - (sum(Object.values(divs)) + (nc1 - nc0) / N0 + shares);
    return { divs, flows, netCash: (nc1 - nc0) / N0, shares, rest, dPrice: h1.price - h0.price, dps: h1.dps, dScore: h1.score - h0.score };
  }

  /* ---------- Nettoyage de la décision du joueur ---------- */
  function sanitize(G, co, dec) {
    dec = dec || {};
    const out = { invest: {}, disinvest: {}, divest: {}, payout: clamp(+dec.payout || 0, 0, 1), loan: null, issuePct: clamp(+dec.issuePct || 0, 0, G.params.maxDil), buybackPct: clamp(+dec.buybackPct || 0, 0, G.params.maxBuyback), bids: {} };
    G.segments.forEach(s => {
      const v = +((dec.invest || {})[s.id]);
      if (isFinite(v) && v > 0) out.invest[s.id] = v;
    });
    for (const sid in (dec.divest || {})) {
      const x = dec.divest[sid];
      if (!co.div[sid] || !x || (x.mode !== "liq" && x.mode !== "auction")) continue;
      out.divest[sid] = { mode: x.mode, min: Math.max(0, +x.min || 0) };
      if (x.mode === "liq") delete out.invest[sid];
    }
    for (const sid in (dec.disinvest || {})) {
      const v = +dec.disinvest[sid];
      if (!co.div[sid] || !isFinite(v) || v <= 0 || out.divest[sid] || G.listings.some(l => l.seller === co.id && l.seg === sid)) continue;
      out.disinvest[sid] = Math.min(v, G.params.maxDisinv * co.div[sid].A);
      delete out.invest[sid];
    }
    if (dec.loan && +dec.loan.amount > 0) out.loan = { amount: +dec.loan.amount, years: clamp(Math.round(+dec.loan.years || 5), 2, G.params.maxLoanYears) };
    for (const lid in (dec.bids || {})) {
      const v = +dec.bids[lid];
      if (isFinite(v) && v > 0 && G.listings.some(l => String(l.id) === String(lid) && l.seller !== co.id)) out.bids[lid] = v;
    }
    return out;
  }

  /* ---------- Simulation d'un exercice ---------- */
  function simulateYear(G, playerDec) {
    if (G.over) return null;
    const t = G.year + 1, p = G.params;
    const R = { t, news: G.news.slice(), ma: [], notes: [], bankrupt: [] };
    const alive = G.companies.filter(c => c.alive);
    const decs = {};
    alive.forEach(co => { decs[co.id] = co.player ? sanitize(G, co, playerDec) : aiDecide(G, co); });
    alive.forEach(co => {
      co._exc = 0; co._cash0 = co.cash; co._loanOut0 = co.loan ? co.loan.out : 0; co._loanRate = co.loan ? co.loan.rate : 0;
      co._inv = 0; co._disinv = 0; co._issue = 0; co._buyback = 0; co._ma = 0; co._sold = {};
    });

    // 1. Résolution des enchères ouvertes l'an dernier
    const open = G.listings; G.listings = [];
    open.forEach(L => {
      const seller = coById(G, L.seller);
      const seg = segById(G, L.seg);
      if ((!seller.alive && !L.liq) || !seller.div[L.seg]) return;
      const d = seller.div[L.seg];
      const from = L.liq ? "le liquidateur de " + seller.name : seller.name;
      let best = null;
      alive.forEach(b => {
        if (b.id === L.seller) return;
        const amt = (decs[b.id].bids || {})[L.id];
        if (!(amt > 0)) return;
        if (amt < L.minPrice) { if (b.player) R.notes.push("Votre offre sur « " + seg.name + " » (" + fmt(amt) + " M€) est inférieure au prix minimal fixé par " + from + "."); return; }
        if (b.cash < amt) { if (b.player) R.notes.push("Offre sur « " + seg.name + " » annulée : trésorerie insuffisante au moment du règlement."); return; }
        const bd = b.div[L.seg];
        if ((bd ? bd.share : 0) + d.share > p.cap) { if (b.player) R.notes.push("L'autorité de la concurrence bloque votre rachat de « " + seg.name + " » : la part cumulée dépasserait " + pct(p.cap) + "."); return; }
        if (!best || amt > best.amt) best = { b, amt };
      });
      if (best) {
        const b = best.b, amt = best.amt;
        if (!L.liq) { seller.cash += amt; seller._exc += amt - d.A; seller._ma += amt; seller._sold[L.seg] = true; }
        delete seller.div[L.seg];
        b.cash -= amt; b._ma -= amt;
        const bd = b.div[L.seg];
        if (bd) { bd.K += d.K; bd.A += d.A; bd.X += d.X; bd.share += d.share; }
        else b.div[L.seg] = { K: d.K, A: d.A, X: d.X, share: d.share, rs: d.rs, lossYears: 0, unsold: 0, depT: d.depT, inv: 0, entered: t, hist: [] };
        R.ma.push({ seg: seg.name, seller: seller.name, buyer: b.name, amt, A: d.A, player: seller.player || b.player });
        G.log.push({ t, kind: "cession", text: b.name + " rachète « " + seg.name + " » à " + from + " pour " + fmt(amt) + " M€ (actifs : " + fmt(d.A) + " M€)." });
      } else if (L.liq) {
        delete seller.div[L.seg];
        G.log.push({ t, kind: "cession", text: "Aucun repreneur pour « " + seg.name + " » de " + seller.name + " : les capacités sont démantelées." });
      } else {
        d.unsold = (d.unsold || 0) + 1;
        R.ma.push({ seg: seg.name, seller: seller.name, buyer: null, amt: 0, A: d.A, player: seller.player });
        if (seller.player) R.notes.push("Aucune offre recevable pour « " + seg.name + " » : la division reste dans le groupe.");
      }
    });

    // 2. Nouvelles cessions
    alive.forEach(co => {
      const dv = decs[co.id].divest || {};
      for (const sid in dv) {
        const d = co.div[sid];
        if (!d) continue;
        const seg = segById(G, sid);
        if (dv[sid].mode === "liq") {
          co.cash += p.recov * d.A; co._exc += (p.recov - 1) * d.A; co._ma += p.recov * d.A; co._sold[sid] = true;
          delete co.div[sid];
          G.log.push({ t, kind: "cession", text: co.name + " ferme sa division « " + seg.name + " » et récupère " + fmt(p.recov * d.A) + " M€." });
          if (co.player) R.notes.push("Division « " + seg.name + " » liquidée : " + fmt(p.recov * d.A) + " M€ récupérés, moins-value de " + fmt((1 - p.recov) * d.A) + " M€.");
        } else {
          G.listings.push({ id: G.nextListingId++, seller: co.id, seg: sid, minPrice: Math.round(dv[sid].min), t });
          G.log.push({ t, kind: "cession", text: co.name + " met en vente sa division « " + seg.name + " » (prix minimal " + fmt(dv[sid].min) + " M€). Offres examinées l'an prochain." });
        }
      }
    });

    // 3. Financement
    alive.forEach(co => {
      const dc = decs[co.id], h = lastH(co);
      const price = h.price;
      if (dc.issuePct > 0 && price > 0) {
        const ns = co.shares * clamp(dc.issuePct, 0, p.maxDil);
        const cash = ns * price * (1 - p.issueDisc);
        co.shares += ns; co.cash += cash; co._issue = cash;
        G.log.push({ t, kind: "bourse", text: co.name + " augmente son capital de " + fmt(cash) + " M€ (+" + pct(dc.issuePct) + " d'actions)." });
      }
      if (dc.buybackPct > 0 && price > 0) {
        let bp = clamp(dc.buybackPct, 0, p.maxBuyback);
        const unit = price * 1.05;
        const maxAff = Math.max(0, co.cash) / (co.shares * unit);
        if (bp > maxAff) { if (co.player) R.notes.push("Rachat d'actions réduit à " + pct(maxAff) + " faute de trésorerie."); bp = maxAff; }
        if (bp > 0.001) {
          const cost = co.shares * bp * unit;
          co.shares -= co.shares * bp; co.cash -= cost; co._buyback = cost;
        }
      }
      if (dc.loan && !co.loan && !co.pendingLoan) {
        const amt = Math.min(dc.loan.amount, maxLoan(G, co));
        if (amt > 0) {
          const n = clamp(dc.loan.years, 2, p.maxLoanYears);
          const rate = loanRate(G, co, amt);
          co.pendingLoan = { P0: amt, out: amt, rate, years: n, left: n, ann: amt / n };
          if (co.player && amt < dc.loan.amount - 0.5) R.notes.push("La banque a plafonné votre emprunt à " + fmt(amt) + " M€.");
        }
      }
      co.payoutUsed = clamp(dc.payout, 0, 1);
      if (co.player) co.payout = co.payoutUsed;
    });

    // 4. Investissements et amortissements
    alive.forEach(co => {
      const dc = decs[co.id];
      G.segments.forEach(seg => {
        let amount = Math.max(0, +(dc.invest[seg.id] || 0));
        let d = co.div[seg.id];
        if (!d && co._sold[seg.id]) {
          if (amount > 0 && co.player) R.notes.push("Investissement prévu dans « " + seg.name + " » annulé : la division a été cédée.");
          return;
        }
        if (!d && amount > 0) {
          d = co.div[seg.id] = { K: 0, A: 0, X: seg.entryX * seg.Xnorm, share: 0, rs: 0, lossYears: 0, unsold: 0, depT: 0, inv: 0, entered: t, hist: [] };
          G.log.push({ t, kind: "entrée", text: co.name + " entre sur « " + seg.name + " » avec " + fmt(amount) + " M€ d'investissement." });
        }
        if (!d) return;
        const disReq = Math.max(0, +((dc.disinvest || {})[seg.id] || 0));
        const dis = Math.min(p.maxDisinv * d.A, disReq);
        if (dis > 0 && !G.listings.some(l => l.seller === co.id && l.seg === seg.id)) {
          const got = disinvestRate(G, seg) * dis;
          co.cash += got; co._disinv += got; co._exc -= dis - got; amount = 0;
          d.A -= dis;
          G.log.push({ t, kind: "désinvestissement", text: co.name + " désinvestit " + fmt(dis) + " M€ d'actifs dans « " + seg.name + " » et en récupère " + fmt(got) + " M€." });
          if (co.player) {
            if (disReq > dis + 0.5) R.notes.push("« " + seg.name + " » : désinvestissement plafonné à " + pct(p.maxDisinv, 0) + " des actifs, soit " + fmt(dis) + " M€.");
            R.notes.push("« " + seg.name + " » : " + fmt(dis) + " M€ d'actifs cédés pour " + fmt(got) + " M€, moins-value de " + fmt(dis - got) + " M€.");
          }
        }
        const maint = seg.dep * d.A;
        if (co.player && amount > 0) G.pinv.push({ t, sid: seg.id, inv: amount, quad: quadrant(G, seg, d.share > 0 ? d.rs : 0, true), entry: d.entered === t });
        if (d.share >= p.cap && amount > maint) {
          if (co.player) R.notes.push("« " + seg.name + " » : votre part (" + pct(d.share) + ") dépasse le seuil de position dominante ; l'investissement est limité au maintien (" + fmt(maint) + " M€).");
          amount = maint;
        }
        d.depT = seg.dep * d.A;
        d.A = d.A - d.depT + amount;
        d.K = d.A / seg.capex;
        d.inv = amount;
        co._inv += amount;
      });
    });

    // 5. Demande
    G.segments.forEach(seg => {
      const g = pathGrowth(seg.path, t) + seg.gShift + (G.mods.g[seg.id] || 0) + seg.vol * gauss(G);
      seg.g = g;
      seg.D = Math.max(1, seg.D * (1 + g));
    });

    // 6. Marchés
    G.segments.forEach(seg => runMarket(G, seg, t));
    alive.forEach(co => {
      for (const sid in co.div) {
        const d = co.div[sid], seg = segById(G, sid);
        d.X += d.q;
        d.lossYears = d.ebit < 0 ? d.lossYears + 1 : 0;
        d.hist.push(divSnap(d, seg, t));
      }
    });

    // 7. Comptes
    alive.forEach(co => {
      let rev = 0, ebit = 0, dep = 0;
      for (const sid in co.div) { const d = co.div[sid]; rev += d.rev; ebit += d.ebit; dep += d.depT; }
      const interest = co._loanOut0 * co._loanRate + Math.max(0, -co._cash0) * (p.rate + p.odPremium);
      const intInc = Math.max(0, co._cash0) * Math.max(0, p.rate - 0.01);
      const ebt = ebit - interest + intInc;
      const tax = Math.max(0, ebt) * p.tax;
      const npRec = ebt - tax;
      const np = npRec + co._exc;
      const dividends = co.payoutUsed * Math.max(0, npRec);
      let repay = 0;
      if (co.loan) repay = Math.min(co.loan.ann, co.loan.out);
      co.cash = co.cash + npRec + dep - co._inv - dividends - repay;
      if (co.loan) {
        co.loan.out -= repay; co.loan.left -= 1;
        if (co.loan.left <= 0 || co.loan.out < 1e-6) co.loan = null;
      }
      if (co.pendingLoan) {
        co.cash += co.pendingLoan.P0; co.loan = co.pendingLoan; co.pendingLoan = null;
        G.log.push({ t, kind: "banque", text: co.name + " obtient un emprunt de " + fmt(co.loan.P0) + " M€ sur " + co.loan.years + " ans à " + pct(co.loan.rate, 2) + "." });
      }
      const val = valuation(G, co);
      let price = val.value / co.shares;
      const dps = dividends / co.shares;
      co.dps.push(dps);
      let score = price + sum(co.dps);
      co.overdraft = p.overdraft * Math.max(rev, 0.5 * co.hist[0].rev);
      if (co.cash < -co.overdraft) {
        co.alive = false; co.bankrupt = t; price = 0; score = 0;
        R.bankrupt.push(co.name);
        G.log.push({ t, kind: "faillite", text: co.name + " dépasse son autorisation de découvert : cessation de paiements, la société est placée en liquidation." });
        if (co.player) { G.over = true; G.bankrupt = true; }
      }
      co.hist.push({
        t, rev, ebit, dep, interest, intInc, tax, npRec, exc: co._exc, np, dividends, inv: co._inv,
        disinv: co._disinv, cash: co.cash, debt: val.debt, equity: val.equity, assets: val.assets, value: co.alive ? val.value : 0, PER: val.PER,
        price, dps, score, shares: co.shares, issue: co._issue, buyback: co._buyback, ma: co._ma, payout: co.payoutUsed, repay,
        ev: co.alive ? val.ev : 0, parts: co.alive ? val.parts : {}
      });
    });
    // sociétés en faillite : capacités retirées du marché, divisions vendues par le liquidateur
    // l'exercice suivant (prix minimal de 20 % des actifs), démantelées faute de repreneur
    G.companies.forEach(co => {
      if (!co.alive && co.bankrupt === t) {
        G.listings = G.listings.filter(l => l.seller !== co.id);
        for (const sid in co.div) {
          const d = co.div[sid];
          G.listings.push({ id: G.nextListingId++, seller: co.id, seg: sid, minPrice: Math.round(0.2 * d.A), t, liq: true });
          G.log.push({ t, kind: "cession", text: "Le liquidateur de " + co.name + " met en vente « " + segById(G, sid).name + " » (prix minimal " + fmt(0.2 * d.A) + " M€)." });
        }
      }
    });
    alive.forEach(co => { delete co._sold; });

    // 8. Banque centrale
    if (rnd(G) < 0.3) G.params.rate = clamp(G.params.rate + (rnd(G) < 0.5 ? -0.005 : 0.005), 0.005, 0.09);

    G.year = t;
    R.ranking = ranking(G);
    G.results.push({ t, notes: R.notes, ma: R.ma, bankrupt: R.bankrupt });
    if (t >= G.T) G.over = true;
    if (!G.over) genNews(G, t + 1);
    return R;
  }

  function quadrant(G, seg, rs, forecast) {
    const g = forecast ? forecastGrowth(G, seg, G.year + 1) : seg.g;
    const hi = g >= G.params.bcgG;
    if (rs >= 1) return hi ? "vedette" : "vache";
    return hi ? "dilemme" : "poids";
  }

  function ranking(G) {
    return G.companies.map(c => ({ id: c.id, name: c.name, player: c.player, score: lastH(c).score, alive: c.alive }))
      .sort((a, b) => b.score - a.score);
  }

  /* ---------- Formats ---------- */
  function fmt(x, dec) {
    if (!isFinite(x)) return "—";
    return x.toLocaleString("fr-FR", { maximumFractionDigits: dec || 0, minimumFractionDigits: dec || 0 });
  }
  function pct(x, dec) {
    if (!isFinite(x)) return "—";
    return (x * 100).toLocaleString("fr-FR", { maximumFractionDigits: dec == null ? 1 : dec, minimumFractionDigits: dec == null ? 0 : dec }) + " %";
  }

  return {
    VERSION, SCENARIOS, disinvestRate, aiDecide, preview, priceBridge, PERSONAS, newGame, simulateYear, defaultDecision, investHints, maxLoan, loanRate, loanTotal,
    forecastGrowth, quadrant, segPER, assetFloor, segById, coById, lastH, valuation, pathGrowth, unitCost, fmt, pct, clamp, sum, sanitize
  };
})();
if (typeof module !== "undefined") module.exports = ENGINE;
