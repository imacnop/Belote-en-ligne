# La Belote en ligne

Une table de belote classique, jouable dans le navigateur à quatre, entre amis ou en famille.
Une seule personne lance le serveur sur son ordinateur ; les autres s'installent à la table grâce
au code de la salle ou à un lien d'invitation, depuis un ordinateur, une tablette ou un téléphone.
S'il manque des joueurs, des bots prennent les places libres.

## Fonctionnalités

- Créer une salle et partager son **code à quatre caractères** ou le lien d'invitation.
- Compléter la table avec des **bots**.
- Jouer en 251, 501 ou 1001 points, ou en partie libre.
- Enchères en deux tours, belote et rebelote annoncées automatiquement, dix de der et capot.
- Tchat, affichage du dernier pli, mode rapide, sons et annonces vocales.
- Un joueur qui ferme la page par mégarde retrouve sa place en revenant ; en son absence,
  l'ordinateur joue pour lui.

## Installation (à faire une seule fois)

1. Installer **Node.js** (version 18 ou ultérieure) depuis <https://nodejs.org>, en choisissant
   la version « LTS ».
2. Ouvrir un terminal dans le dossier du projet et taper :

   ```
   npm install
   ```

## Lancer une partie

```
npm start
```

Le terminal indique alors les adresses à ouvrir :

- `http://localhost:3000` sur l'ordinateur où tourne le serveur ;
- `http://192.168.x.x:3000` sur les téléphones et ordinateurs **reliés au même réseau Wi-Fi**.

Il ne reste plus qu'à saisir son nom, cliquer sur **Créer une salle**, communiquer le code aux
autres joueurs, ajouter des bots au besoin, puis cliquer sur **Lancer la partie**.

> Pour jouer avec des personnes qui ne partagent pas le même Wi-Fi, il faut héberger le serveur
> sur Internet (Render, Railway, un serveur privé…) ou passer par un tunnel comme `ngrok http 3000`.

Pour arrêter le serveur : `Ctrl + C` dans le terminal, ou fermer la fenêtre.

## Modifier les réglages (sans toucher au code)

Tous les réglages se trouvent dans le fichier **`config.jsonc`**. Ouvrez-le avec le Bloc-notes
(clic droit → *Ouvrir avec* → *Bloc-notes*), modifiez la valeur voulue, enregistrez, puis
relancez le serveur. Chaque réglage y est expliqué.

| Réglage | Valeur par défaut | Rôle |
|---|---|---|
| `partie.pointsParDefaut` | `501` | Score à atteindre, présélectionné |
| `partie.choixPoints` | `[251, 501, 1001, 0]` | Scores proposés à l'hôte (0 = partie libre) |
| `regles.pointsBelote` | `20` | Valeur de la belote et rebelote |
| `regles.dixDeDer` | `10` | Bonus accordé au dernier pli |
| `regles.pointsCapot` | `252` | Points de l'équipe qui remporte tous les plis |
| `regles.beloteToujoursAcquise` | `true` | Le preneur conserve sa belote même s'il chute |
| `regles.obligationDeSousCouper` | `true` | Obligation de jouer un atout plus faible quand on ne peut pas surcouper |
| `aides.jeuAutoCarteUnique` | `true` | Joue automatiquement la carte lorsqu'elle est la seule autorisée |
| `aides.passeAutoMainFaible` | `false` | Passe automatiquement aux enchères avec une main trop faible |
| `temps.delaiTourSecondes` | `45` | Délai au-delà duquel l'ordinateur joue pour un joueur absent |
| `temps.pauseEntreDonnesSecondes` | `7` | Pause entre deux donnes |
| `temps.reflexionBotsSecondes` | `0.7` | Temps de réflexion des bots |
| `bots.noms` | Marcel, Gérard… | Noms des bots |
| `serveur.port` | `3000` | Port utilisé dans l'adresse du jeu |
| `serveur.dureeVieSalleMinutes` | `10` | Délai avant la suppression d'une salle abandonnée |

Une faute de frappe ? Pas de panique : au démarrage, le serveur affiche un message `[config]`
qui décrit le problème, puis reprend la valeur par défaut.

## Règles appliquées

- Jeu de 32 cartes, distribué par 3 puis par 2 ; la carte suivante est retournée et propose l'atout.
- **Enchères** : au premier tour, on prend à la couleur retournée ou l'on passe ; au second tour,
  on peut choisir une autre couleur. Si personne ne prend, on redistribue.
- **Obligations** : fournir à la couleur demandée ; à défaut, couper ; surcouper si un adversaire
  a déjà coupé. On est libre quand son partenaire est maître du pli. À l'atout, il faut toujours
  monter quand on le peut.
- **Décompte** : chaque donne vaut 162 points (152 + 10 de der). Le preneur doit en marquer
  **davantage** que la défense, belote comprise ; sinon, il est « dedans » et la défense empoche
  les 162 points. En cas d'égalité, le preneur est dedans. Un capot rapporte 252 points.
- La partie s'achève dès qu'une équipe atteint le score visé **et** devance l'autre.

## Organisation des fichiers

| Fichier | Rôle |
|---|---|
| `server.js` | Serveur : salles, distribution, enchères, bots et décompte des points |
| `regles.js` | Règles du jeu, communes au serveur et à la page web |
| `belote.html` | Page du jeu (table, cartes, animations, tchat) |
| `config.jsonc` | **Réglages modifiables** |
| `config.js` | Lecture et vérification des réglages |
| `test/` | Tests automatiques des règles (`npm test`) |
