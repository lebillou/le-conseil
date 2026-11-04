/* Tests d'interface de bout en bout : node tools/ui_test.js
   Ouvre index.html dans Chromium (Playwright) et vérifie les parcours principaux.
   Sort avec le code 1 si une vérification échoue ou si la page lève une erreur JavaScript. */
const path = require("path");
const { chromium } = require("playwright");

const URL = "file://" + path.resolve(__dirname, "..", "index.html");
let fails = 0, passes = 0;
function ok(cond, msg) {
  if (cond) passes++;
  else { fails++; console.error("ÉCHEC :", msg); }
}
const txt = async (page, sel) => ((await page.locator(sel).first().textContent().catch(() => "")) || "").replace(/\s+/g, " ");

async function fresh(page) {
  await page.goto(URL);
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* rien */ } });
  await page.reload();
}
async function validateYear(page) {
  await page.click("#validate");
  if (/Confirmer/.test(await txt(page, "#validate"))) await page.click("#validate");
  await page.waitForSelector("#close-sheet");
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = p => {
    p.on("pageerror", e => errors.push(e.stack || e.message));
    p.on("console", m => { if (m.type() === "error") errors.push("console : " + m.text()); });
  };

  /* --- Accueil --- */
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  watch(page);
  await fresh(page);
  const nScen = await page.locator(".scen").count();
  ok(nScen === 6, `6 scénarios attendus à l'accueil, ${nScen} trouvés`);
  ok((await page.locator(".scen .chip.on").count()) === nScen, "chaque scénario affiche sa difficulté");
  ok((await page.locator("#o-level option").count()) === 3, "trois niveaux de jeu proposés");
  await page.selectOption("#o-level", "facile");
  ok(/expérience/.test(await txt(page, ".home")), "l'explication du niveau facile s'affiche");

  /* --- Partie : industrie, graine fixe, niveau facile, 10 exercices --- */
  await page.selectOption("#o-years", "10");
  await page.fill("#o-seed", "42");
  await page.click("[data-act=start]");
  ok(/niveau facile/.test(await txt(page, ".topline")), "le niveau est rappelé dans la barre de jeu");
  ok(/Cours estimé/.test(await txt(page, "#sum")), "l'aperçu affiche un cours estimé");
  ok(/aperçu : part/.test(await txt(page, ".effect")), "chaque division affiche sa part estimée");

  // désinvestissement au maximum : décote affichée
  await page.locator("[data-act=dq]").nth(1).click();
  ok(/moins-value/.test(await txt(page, ".effect")), "le désinvestissement affiche sa moins-value");
  await page.locator("[data-act=dq][data-f='0']").first().click();

  // focus conservé après un changement de menu (re-rendu complet)
  const dv = page.locator("select[data-k=dvmode]").first();
  const dvId = await dv.getAttribute("id");
  await dv.focus(); await dv.selectOption("auction");
  ok(await page.evaluate(id => document.activeElement && document.activeElement.id === id, dvId), "le focus revient sur le menu après re-rendu");
  await page.locator("#" + dvId).selectOption("");

  // onglets au clavier
  await page.focus("#tab-conseil");
  await page.keyboard.press("ArrowRight");
  ok(await page.evaluate(() => document.activeElement.id === "tab-divisions"), "flèche droite : onglet suivant");
  await page.keyboard.press("End");
  ok(await page.evaluate(() => document.activeElement.id === "tab-regles"), "Fin : dernier onglet");
  for (const t of ["marches", "matrice", "comptes", "rivaux", "journal", "conseil"]) await page.click(`[data-act=tab][data-tab=${t}]`);

  // décision ruineuse : confirmation demandée
  const inv = page.locator("input[data-k=inv]").first();
  await inv.fill("9000");
  await page.click("#validate");
  ok(/Confirmer malgré le risque/.test(await txt(page, "#validate")), "une décision ruineuse demande confirmation");
  await page.click("[data-act=reset]");

  // premier exercice : procès-verbal, décomposition, piège de focus, Échap
  await validateYear(page);
  ok(/Pourquoi le score a bougé/.test(await txt(page, ".sheet")), "le procès-verbal décompose la variation du score");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
  ok(await page.evaluate(() => !!document.activeElement.closest(".sheet")), "le focus reste dans le procès-verbal");
  await page.keyboard.press("Escape");
  ok((await page.locator(".sheet").count()) === 0, "Échap ferme le procès-verbal");

  // fin de partie
  for (let y = 1; y < 10; y++) { await validateYear(page); await page.keyboard.press("Escape"); }
  ok((await page.locator(".verdict").count()) === 1, "le bilan final s'affiche");
  const refRows = await page.locator(".refs tbody tr").count();
  ok(refRows >= 4, `le bilan compare la partie aux stratégies de référence (${refRows} lignes)`);
  ok((await page.locator(".refs tr.me").count()) === 1, "la partie du joueur figure dans la comparaison");
  await page.click("[data-act=tab][data-tab=journal]");
  ok((await page.locator(".log li.mine").count()) === 10, "le journal consigne les décisions de chaque exercice");
  await page.click("[data-act=tab][data-tab=matrice]");
  ok((await page.locator("svg clipPath#bcg-clip").count()) === 1, "les bulles de la matrice sont découpées au cadre");

  /* --- Chronomètre : décision ruineuse, temps écoulé, rechargement --- */
  const p2 = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  watch(p2);
  await p2.clock.install();
  await fresh(p2);
  await p2.selectOption("#o-timer", "180");
  await p2.fill("#o-seed", "7");
  await p2.click("[data-act=start]");
  await p2.locator("input[data-k=inv]").first().fill("9000");
  await p2.clock.runFor(181000);
  await p2.waitForSelector("#close-sheet");
  ok(/directeur financier/.test(await txt(p2, ".sheet")), "à expiration, le directeur financier réduit les investissements");
  ok(!/Cessation/.test(await txt(p2, ".stamp")), "le directeur financier évite la cessation de paiements");
  await p2.click("#close-sheet");
  await p2.clock.runFor(100000);
  await p2.reload();
  await p2.click("[data-act=resume]");
  const left = await txt(p2, "#timer");
  const sec = left.includes(":") ? +left.split(":")[0] * 60 + +left.split(":")[1] : -1;
  ok(sec > 60 && sec <= 80, `le rechargement conserve l'échéance (${left} restant, 1:20 attendu)`);

  /* --- Mobile : pas de défilement horizontal, marges de 16 px --- */
  const p3 = await browser.newPage({ viewport: { width: 390, height: 844 } });
  watch(p3);
  await fresh(p3);
  ok(await p3.evaluate(() => document.documentElement.scrollWidth <= 390), "accueil sans défilement horizontal sur mobile");
  const box = await p3.locator(".scen").first().boundingBox();
  ok(box && box.x >= 16, "marge latérale de 16 px sur mobile");
  await p3.click("[data-act=start]");
  ok(await p3.evaluate(() => document.documentElement.scrollWidth <= 390), "écran de jeu sans défilement horizontal sur mobile");

  ok(errors.length === 0, "erreurs JavaScript :\n" + errors.join("\n"));
  await browser.close();
  console.log(`${passes} vérifications d'interface réussies, ${fails} échec${fails > 1 ? "s" : ""}.`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
