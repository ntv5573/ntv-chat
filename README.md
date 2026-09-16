# NTV — prototype de chat vidéo

Un mini "OmeTV" fait maison : visio aléatoire entre deux inconnus (WebRTC),
chat texte en direct, avec filtres sur le pays et le genre recherchés.

## Installation et lancement

Il faut [Node.js](https://nodejs.org/) installé (version 18 ou plus).

```bash
cd omelike
npm install
npm start
```

Le serveur démarre sur **http://localhost:3000**.

Pour tester le matching, ouvre cette adresse dans **deux onglets/navigateurs
différents** (ou deux machines du même réseau, en remplaçant `localhost` par
l'adresse IP du serveur). Autorise la caméra et le micro sur les deux.
Les deux profils doivent être compatibles (genre/pays) pour être connectés
ensemble — sinon chacun reste "en recherche".

## Architecture

```
Navigateur A                    Serveur Node.js                 Navigateur B
(caméra, WebRTC)   <—WebSocket—>  (signalisation +   <—WebSocket—>  (caméra, WebRTC)
                                   matchmaking +
                                   relais du chat)

           \_______________ flux vidéo/audio en direct (P2P) _______________/
                        (ne passe PAS par le serveur)
```

- **`server.js`** : serveur HTTP (sert les fichiers du dossier `public/`) +
  serveur WebSocket. Il gère :
  - la file d'attente des utilisateurs en recherche (`waitingPool`),
  - l'algorithme de matching mutuel (filtre pays + genre dans les deux sens),
  - le relais des messages de signalisation WebRTC (offer / answer / ICE),
  - le relais des messages de chat.
- **`public/app.js`** : logique client — récupère la caméra
  (`getUserMedia`), ouvre la connexion WebSocket, crée la
  `RTCPeerConnection`, échange l'offer/answer avec le partenaire via le
  serveur, affiche le flux vidéo distant, gère le chat et les boutons
  Suivant/Arrêter.
- **`public/index.html` / `style.css`** : interface (écran de préférences
  puis écran d'appel).

Point clé WebRTC : le **serveur ne voit jamais la vidéo ni l'audio**. Il ne
sert qu'à la "poignée de main" initiale (signalisation) ; une fois la
connexion établie, le flux audio/vidéo circule directement entre les deux
navigateurs (peer-to-peer).

## Limites connues du prototype (à mentionner si c'est pour un rendu)

- **Genre déclaratif** : rien ne vérifie qu'un utilisateur dit vrai sur
  son genre — c'est une simple case cochée dans le formulaire.
- **Pays détecté par IP, mais pas fiable à 100%** : depuis cette version,
  le pays de chaque visiteur n'est plus déclaré mais déduit
  automatiquement de son adresse IP (librairie `geoip-lite`, base locale
  embarquée, pas d'appel réseau externe). C'est plus fiable qu'une simple
  déclaration, mais ce n'est pas infaillible : un VPN, un proxy, ou une
  IP mobile partagée peuvent fausser la détection. Et surtout, **ça ne
  fonctionne pas en local** : sur `localhost` ou un réseau privé
  (`192.168.x.x`), `geoip-lite` ne trouve pas de correspondance et le
  serveur traite alors le visiteur comme compatible avec toutes les
  recherches (valeur `"any"`) — pour tester la détection réelle, il faut
  déployer le serveur sur une machine avec une IP publique.
- **Pas de TURN server** : la configuration WebRTC n'utilise ici qu'un
  serveur STUN public (Google). Cela suffit pour un test en local ou sur un
  réseau simple, mais dans un vrai déploiement, une partie des utilisateurs
  (derrière des box/NAT restrictifs, réseaux d'entreprise, 4G) ne pourront
  pas se connecter sans un **serveur TURN** (ex: [coturn](https://github.com/coturn/coturn),
  auto-hébergé ou via un service comme Twilio/Metered). C'est un bon axe
  d'approfondissement SISR (mise en place et administration d'un serveur
  coturn).
- **Aucune modération** : pas de détection de contenu inapproprié, pas de
  vérification d'âge, pas de système de signalement. C'est précisément ce
  qui a coûté sa fermeture à Omegle en 2023. Pour un usage réel (pas juste
  une démo en local/classe), il faudrait a minima : CGU, vérification
  d'âge, bouton de signalement, modération (humaine ou par IA).
- **Chat relayé par le serveur** (pas par un DataChannel WebRTC) : plus
  simple à mettre en place pour un prototype, mais moins "pur P2P" que la
  vidéo. Amélioration possible : passer le chat sur un `RTCDataChannel`.
- **Pas de HTTPS** : `getUserMedia` fonctionne en HTTP uniquement sur
  `localhost`. Pour un déploiement sur un vrai nom de domaine, il faut du
  HTTPS (obligatoire pour l'accès caméra/micro dans les navigateurs
  modernes).

## Pistes d'évolution possibles (pour aller plus loin dans le projet)

- Ajouter un vrai serveur TURN (coturn) et le configurer dans `RTC_CONFIG`.
- Affiner la géolocalisation IP (base MaxMind GeoLite2 officielle, mise à
  jour régulière, plus précise que la base embarquée dans `geoip-lite`).
- Bouton "signaler" qui coupe la connexion et logue l'incident.
- Compteur du nombre de personnes en ligne / en attente.
- Passage du chat en `RTCDataChannel` (100% P2P, plus de relais serveur).
- Dockerisation du serveur pour le déploiement.
