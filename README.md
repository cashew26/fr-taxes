# Simulateur d'impôt sur le revenu 2026 (revenus 2025)

Application en une seule page (`index.html`, HTML/CSS/JS sans dépendance) qui reproduit la liquidation de l'impôt sur le revenu d'un foyer fiscal français pour la déclaration 2026 des revenus 2025.

Ouvrez simplement `index.html` dans un navigateur. La saisie est conservée localement (localStorage) et peut être exportée / importée au format JSON.

## Fonctionnalités

- Rubriques des formulaires 2042, 2042-C, 2042-C-PRO, 2042-RICI et 2044, avec les codes de cases (1AJ, 2DC, 4BA, 7DB…).
- Calcul instantané à chaque modification, affichage sous la forme de l'avis d'imposition (revenu brut global → net global → net imposable → impôt brut → décote → réductions → PFU → crédits → impôt net → prélèvements sociaux → prélèvement à la source → solde).
- Nombre de parts et plafonnement du quotient familial (cases T, L, P, F, W, S, G, enfants F/G/H/I/J/N/R, veufs avec personnes à charge, réductions complémentaires).
- Déduction de 10 % ou frais réels, abattement pensions, rentes viagères, abattement personnes âgées / invalides, enfants mariés rattachés.
- Revenus mobiliers au PFU ou au barème (option 2OP) avec comparaison automatique de l'option la plus favorable, assurance-vie (abattement 4 600 / 9 200 €), plus-values et abattements pour durée de détention.
- Revenus fonciers (micro / réel, déficits 10 700 / 21 400 €, revenus étrangers 4BK/4BL avec crédit d'impôt, 4EA au taux effectif), BIC/BNC/BA micro et réel, durée d'exercice 5CD, forfait forestier 5HD, revenus à imposer aux prélèvements sociaux 5HY, meublés de tourisme (50 % / 30 %), versement libératoire (taux effectif).
- Charges déductibles (CSG, pensions alimentaires plafonnées, accueil de personnes âgées, épargne retraite 6NS/6RS avec plafonds et reports).
- Réductions et crédits : dons (7UD 75 % jusqu'à 1 000 €, 7UQ 75 % jusqu'à 2 000 € pour les dons versés depuis le 14 octobre 2025, 66 % au-delà), scolarité, garde d'enfants, emploi à domicile (plafonds calculés), cotisations syndicales, prestations compensatoires, dépendance, PME/JEI/FCPI/FIP, Sofica, forêts, bornes de recharge, équipements, risques technologiques, montants directs pour Pinel/Denormandie/Girardin/Malraux ; plafonnement global 10 000 / 18 000 €.
- Système du quotient (revenus exceptionnels 0XX), taux effectif (8TI), crédits d'impôt étrangers (8TK, 8VL), réduction DOM, CEHR, contribution différentielle sur les hauts revenus (avec décote), prélèvements sociaux 17,2 %, seuil de recouvrement, prélèvement à la source.
- Validation des champs obligatoires, plafonds appliqués avec avertissement, affichage conditionnel des rubriques selon la situation (déclarant 2, personnes à charge, régime foncier, option barème, frais réels…).

## Paramètres annuels

Les montants indexés (barème, plafonds du quotient familial, décote, déductions, abattements, plafonds des réductions) sont ceux de la loi n° 2026-103 du 19 février 2026 de finances pour 2026 (indexation de 0,9 %).

- Dans la page, la rubrique « Paramètres annuels » (en bas du formulaire) permet de modifier chaque valeur ; les valeurs modifiées sont surlignées, conservées avec la saisie (localStorage, export/import JSON) et un bouton rétablit les valeurs par défaut.
- Dans le code, les valeurs par défaut sont regroupées dans l'objet `DEFAULT_PARAMS` en tête du script, et la liste `PARAM_DEFS` décrit les paramètres exposés dans l'interface (groupe, chemin, libellé, type). Pour une nouvelle année, il suffit de mettre à jour `DEFAULT_PARAMS`.

## Vérification

Un moteur de calcul isolé (`compute(valeurs)`) est délimité par les marqueurs `ENGINE START` / `ENGINE END` dans `index.html`, ce qui permet de l'exécuter hors navigateur (Node) pour des tests.
