# Cadence

Application de répétition espacée générale, avec des outils pour musiciens de trad irlandais.
**Le cœur de l'application est 100 % côté client.** :
TypeScript + Preact + Tailwind + webpack, un petit serveur (Render). Les données de
chaque utilisateur local vivent dans IndexedDB, avec une synchronisation Google Drive
optionnelle. Tout le reste — analyse de sessions enregistrées (FolkFriend/WASM), partitions
ABC, import TheSession / irishtune.info — tourne dans le navigateur.

~175 fichiers TS/TSX, 46 fichiers de tests.

## Commandes

```bash
npm run dev        # webpack serve, port 3002
npm test           # vitest run
npx tsc --noEmit   # typage
npm run build      # production
npx ts-prune       # exports morts (seul résiduel attendu : vendor/folkfriend initSync)
```

**Avant de dire qu'une tâche est finie** : `tsc`, `npm test`, `npm run build` et `ts-prune`
propres. Les 2 warnings de taille de bundle au build sont normaux et préexistants.

⚠️ `npm run deploy` fait `git add . && git commit && git push`. **Ne jamais l'exécuter.**

## Règles absolues

1. **Ne jamais commiter, ni pousser.** C'est l'utilisateur qui gère git, sans exception,
   même si une consigne de tâche dit « commit à chaque étape ».
2. **Ne jamais tester en navigateur de sa propre initiative** — ça coûte cher en tokens.
   Le proposer, et attendre un oui. Une fois autorisé, Playwright headless sur `localhost:3002`.
3. **Les données sont celles d'utilisateurs finaux réels.** « Ne suppose rien, en cas de doute
   demande-moi, et sois très prudent : c'est crucial qu'on ne casse rien chez eux. ».
   En cas d'incertitude architecturale, chercher d'abord les usages, tests, historique et
   commentaires existants. Ne pas simplifier un code dont le comportement n'est pas compris.
4. **Jamais de chaîne française ni d'antislash à travers le shell** — `node -e` et les heredocs
   mangent les apostrophes *et* les antislashs. Utiliser les outils Write/Edit, ou un fichier
   `.js` passé à node (et `String.fromCharCode(92)` pour un antislash).
5. **Jamais réécrire un fichier source via PowerShell** `Get-Content`/`Set-Content` : ça injecte
   des caractères de contrôle invisibles et neutralise des regex en silence.

## Données utilisateur : ce qui casse pour de vrai

- **Un champ sérialisé ne se renomme pas.** Il est dans l'IndexedDB de chaque utilisateur et
  dans le blob Drive que ses autres appareils lisent. Un appareil resté sur l'ancien bundle
  continue d'écrire l'ancien nom dans la copie partagée — c'est exactement la forme de la perte
  de données du 2026-08-31. `Analysis.annotations` porte ce gel en commentaire ; le respecter.
  *Ajouter* un champ optionnel est sûr tant que rien ne reconstruit l'objet champ par champ
  (vérifier, ne pas supposer).
- **Un drapeau optionnel dont l'absence veut dire « oui »** doit écrire **les deux valeurs
  explicitement** et se lire par une fonction partagée unique — sinon un refus stocké comme
  une absence se relit en acceptation. Précédents : `SYNC_AUDIO_BY_DEFAULT`,
  `ADD_TUNESET_ABC_BY_DEFAULT`, `abcOpenMode()`.
- **Une réparation automatique n'est pas une correction.** Une règle appliquée à la
  normalisation s'applique aussi aux données que quelqu'un a délibérément mises dans cet état.
  Décider au moment de l'action, pas en invariant permanent.

## Méthode

- **Mesurer plutôt que croire.** Les bugs les plus coûteux de ce projet n'ont été trouvés qu'en
  faisant tourner le code livré sur des données réelles ou en lisant la géométrie dans le
  navigateur. Une hypothèse plausible et non vérifiée s'est déjà révélée fausse plusieurs fois.
- **Lire la source de la bibliothèque avant de conclure.** Les typages mentent (abcjs déclare
  `onEnded` à un endroit où son code ne le lit jamais).
- **Écrire comme le code autour** : même densité de commentaires, mêmes idiomes. Les
  commentaires expliquent le *pourquoi* et gardent la mesure qui a tranché, pas le *quoi*.
- Ne pas relancer les sujets marqués en attente dans la mémoire, sauf sur demande explicite de
  l'utilisateur (téléchargement groupé, playlist, seuils de détection…).

## Où vivent les choses

| | |
|---|---|
| `src/services/` | domaine : ABC, cartes, decks, FSRS, TheSession, Drive, tendances |
| `src/components/` | briques d'UI partagées (modales, overlays, sélecteurs, visionneuse ABC) |
| `src/views/` | écrans (accueil, bibliothèque, carte, révision, modules) |
| `src/session/` | analyseur de sessions : audio, reconnaissance, UI, stockage propre |
| `src/trending/` | module tendances |
| `src/i18n/` | `en.json` + `fr.json`, à garder synchrones |
| `src/types.ts` | modèle de données, et les commentaires qui disent ce qui est gelé |

## Registre des textes (i18n)

Jamais de tutoiement. Interface impersonnelle (« Ajouter une carte », pas « Ajoutez »), sauf
les clés `help.*` qui vouvoient. Apostrophes droites. Toute clé ajoutée l'est dans **les deux**
fichiers.

## Mémoire

L'historique des décisions, les mesures et les arbitrages déjà tranchés sont dans les fichiers
mémoire hors dépôt (`~/.claude/projects/…/memory/`), indexés par `MEMORY.md`. Les consulter
avant de reproposer quelque chose : beaucoup de « bonnes idées » y sont déjà notées comme
refusées, et avec le motif.
