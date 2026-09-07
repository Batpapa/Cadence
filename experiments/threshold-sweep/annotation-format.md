# Format d'annotation d'une session

Un fichier par enregistrement, nommé `<nom-de-l-audio>-timings.csv`, déposé dans
`test-fixtures/sessions/` à côté du `-windows.json`.

```csv
start;end;ID;comment
00:00:00;00:02:27;182;Silver Spear
00:02:27;00:04:12;98;Sally Gardens
00:04:22;00:05:47;1600;Humours of Lisheen
00:51:22;00:53:22;;air pas présent sur TheSession
```

| colonne | contenu |
|---|---|
| `start` | début du morceau, `HH:MM:SS` |
| `end` | fin du morceau, `HH:MM:SS` |
| `ID` | identifiant TheSession du **morceau** |
| `comment` | libre — sert à lire les rapports, jamais à identifier |

Le commentaire **s'ajoute** à l'identifiant dans les rapports, il ne le remplace
pas. Et il gagne son coût : sur Audio G, « Played in A, but settings on
TheSession are in G » explique à lui seul un morceau manqué, et « audio tronqué
avant la fin » explique une couverture faible qui aurait autrement compté comme
un défaut de détection.

Un commentaire contenant une **virgule** doit être entre guillemets — le lecteur
les gère, mais sans eux les colonnes se décalent.

## Les trois choses qui comptent

**L'ID est celui du morceau, pas du réglage.** Celui de l'adresse
`thesession.org/tunes/**1600**`, jamais un `#setting22837`. Les deux sont des
nombres et rien ne les distingue à l'œil, mais un numéro de réglage pointe vers
un autre air — c'est exactement l'erreur qui a rendu une mesure entière fausse
le 2026-09-06.

**Deux cas particuliers, et ils ne se valent pas.** Inventer un identifiant
proche reste bien pire que d'utiliser l'un des deux.

| `ID` | Sens | Effet sur la mesure |
|---|---|---|
| `0` | l'annotateur n'a pas reconnu le morceau | passage **exclu du score**, des deux côtés |
| `-1` | reconnu, mais absent de TheSession | **aucune détection attendue** ; toute détection y est un faux positif |

La distinction n'est pas cosmétique : les deux demandent au lecteur des
comportements opposés.

Sur un `-1`, le détecteur ne peut structurellement pas avoir raison — tout son
vocabulaire est fait d'identifiants TheSession. Ces passages sont donc la seule
vérité terrain de faux positifs *à l'intérieur de vraie musique* dont on
dispose : l'enregistrement de bruit pur ne produit aucune détection à aucun
seuil, il ne contraint rien.

Sur un `0`, au contraire, le morceau est probablement bien dans l'index et c'est
l'humain qui n'a pas su le nommer. Une détection y est peut-être juste. La
compter comme faux positif reviendrait à pénaliser le détecteur pour en savoir
plus que l'annotateur.

Une case **vide** est traitée comme `0`, la lecture prudente : rien ne permet de
deviner laquelle des deux situations elle recouvre.

**Une ligne qu'on n'arrive pas à identifier ne se supprime jamais.** C'est
arrivé sur Audio B : « The Maid of Llanwellyn », un chant gallois absent de
TheSession, avait été effacé faute d'identifiant. Or le détecteur n'avait rien
produit sur ces 42 secondes — il aurait marqué un point parfait sur un vrai test
de faux positif. Supprimer la ligne fait disparaître exactement la preuve que
`-1` sert à recueillir.

**Les chants prennent `-1` aussi**, avec un commentaire le disant. On chante dans
les sessions, et vérifier que le détecteur reste muet pendant un chant a autant
de valeur que le vérifier sur un morceau absent de la base. Attention toutefois :
beaucoup d'airs de chants existent aussi sur TheSession sous un nom de morceau
instrumental — auquel cas une détection n'est pas absurde. `-1` veut toujours
dire « j'ai vérifié, ce n'est pas dans la base », quelle qu'en soit la raison.

**Les bornes servent vraiment.** Avec un début et une fin, on ne mesure plus
seulement « l'air a-t-il été nommé quelque part », mais « la détection
couvre-t-elle réellement le passage » — un air repéré sur 15 secondes d'un set de
3 minutes n'est pas un succès.

## Tolérances du lecteur

Inutile d'uniformiser les machines, le parseur s'adapte :

- **séparateur** détecté automatiquement — virgule, point-virgule (ce qu'écrit
  Excel en français), tabulation ou barre verticale ;
- **deux-points redoublés** acceptés (`00::02::27`) ;
- `MM:SS` accepté aussi bien que `HH:MM:SS` ;
- guillemets autour d'un champ, espaces superflus, BOM UTF-8 : ignorés ;
- la **première ligne est toujours l'en-tête** et n'est jamais lue comme un air.

## Pourquoi ce format remplace les `.txt`

Les anciens fichiers donnaient des noms écrits à la main, qu'il fallait faire
correspondre à l'index de TheSession. Six couches de rattrapage ont été
nécessaires — articles inversés, alias multiples, chiffres romains, fautes de
frappe, interversions de lettres, horodatages passé une heure — et **chacune n'a
été découverte que parce qu'un chiffre a paru louche à un humain**. Un
identifiant supprime tout cela d'un coup.

Le lecteur prend automatiquement le `.csv` quand il existe, et retombe sur le
`.txt` sinon ; le second chemin disparaîtra avec le dernier fichier converti.
