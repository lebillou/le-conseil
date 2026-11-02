# Le Conseil

Jeu de stratégie d'entreprise en solo, jouable dans le navigateur. Vous présidez le conseil d'administration d'un groupe présent sur plusieurs créneaux. À chaque exercice, vous répartissez les ressources entre vos divisions, fixez le dividende et choisissez vos financements, face à quatre concurrents pilotés par l'ordinateur. Le score est la valeur de l'action, dividendes compris.

Le jeu s'inspire du principe des serious games de formation à la stratégie, comme Strathena (Interactive 4D). Il n'en reprend ni le nom, ni les visuels, ni les contenus, et son moteur de simulation est original. Les sociétés et les chiffres sont fictifs.

## Jouer

Ouvrir `index.html` dans un navigateur : le fichier est autonome, sans serveur ni installation. La partie en cours est sauvegardée dans le navigateur.

## Contenu

- Trois scénarios : groupe industriel diversifié, transport terrestre longue distance, froid commercial européen.
- Courbe d'expérience (avec expérience partagée entre créneaux d'un même métier), équilibre offre/demande, cycle de vie des créneaux.
- Investissement, désinvestissement d'actifs, vente aux enchères ou fermeture de divisions, rachat de divisions concurrentes.
- Dividende, emprunt bancaire, augmentation de capital, rachat d'actions.
- Seuil de position dominante, faillite au-delà du découvert autorisé, événements de conjoncture.
- Concurrents aux profils différents (gardien du métier, conquérant, rentier, diversifieur, opportuniste), révélés en fin de partie.
- Matrice BCG, comptes consolidés, journal, chronomètre optionnel, graine pour rejouer la même conjoncture.

Score = cours + dividende moyen par action ; cours = PER sectoriel × résultat net courant ÷ nombre d'actions. Toutes les sociétés démarrent à 10 €. Les règles détaillées sont dans l'onglet « Règles » du jeu.

## Structure

```
index.html        page jouable, générée par build.py (ne pas éditer à la main)
build.py          assemble src/ en index.html
src/engine.js     moteur de simulation pur, sans DOM (utilisable sous Node)
src/ui.js         interface
src/shell.html    gabarit HTML et feuille de style
tools/            simulations sans interface pour le calibrage
```

## Modifier le jeu

```bash
python3 build.py                 # régénère index.html après modification de src/
node tools/test_sim.js           # 20 parties par scénario avec trois stratégies simples
node tools/search.js froid 200   # recherche aléatoire de stratégies sur un scénario
node tools/dbg.js transport 1 P  # trajectoire d'une société sur une graine donnée
```

Les scénarios (créneaux, positions initiales, événements programmés) et les profils des concurrents sont définis en tête de `src/engine.js`.
