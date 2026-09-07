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

## Les trois choses qui comptent

**L'ID est celui du morceau, pas du réglage.** Celui de l'adresse
`thesession.org/tunes/**1600**`, jamais un `#setting22837`. Les deux sont des
nombres et rien ne les distingue à l'œil, mais un numéro de réglage pointe vers
un autre air — c'est exactement l'erreur qui a rendu une mesure entière fausse
le 2026-09-06.

**Un air absent de TheSession : laisser la colonne `ID` vide.** Il sera compté
comme hors de portée, ce qui est honnête. Inventer un identifiant proche est
bien pire que ne rien mettre.

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
