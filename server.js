/**
 * server.js
 * -----------------------------------------------------------------------
 * Serveur de signalisation + matchmaking pour le prototype "OmeLike".
 *
 * Rôle du serveur :
 *  1. Servir les fichiers statiques du dossier /public (HTML/CSS/JS client).
 *  2. Gérer une connexion WebSocket par visiteur.
 *  3. Placer chaque visiteur en attente ("pool") avec ses préférences
 *     (son genre déclaré, le genre recherché, le pays dans lequel il
 *     veut aller discuter).
 *  4. Dès que deux personnes sont compatibles, les sortir de la pool,
 *     créer une "room" et leur dire de démarrer une connexion WebRTC
 *     (l'un est "initiator", l'autre "receiver").
 *  5. Une fois la room créée, le serveur ne fait plus que relayer :
 *     - les messages de signalisation WebRTC (offer / answer / ICE candidates)
 *     - les messages du chat texte
 *     La vidéo/audio, elle, passe en direct entre les deux navigateurs
 *     (peer-to-peer), le serveur ne la voit jamais.
 *
 * IMPORTANT (pédagogique) :
 *  - Le "genre" est ici une simple déclaration faite par l'utilisateur
 *    dans le formulaire. Il n'y a aucune vérification d'identité : c'est
 *    une limite assumée du prototype (voir README).
 *  - Le "pays" fonctionne différemment : ce n'est plus une déclaration.
 *    Le pays RÉEL de chaque visiteur est détecté automatiquement à partir
 *    de son adresse IP (via la librairie `geoip-lite`, base locale, pas
 *    d'appel réseau externe). L'utilisateur choisit uniquement le pays
 *    dans lequel il veut trouver un partenaire ("targetCountry"), et le
 *    serveur ne le connecte qu'à quelqu'un réellement détecté là-bas.
 *    Limite à connaître : la géolocalisation IP n'est jamais fiable à
 *    100% (VPN, proxy, IP mobile partagée...) et ne fonctionne PAS pour
 *    des connexions locales (localhost / réseau privé) — voir README.
 * -----------------------------------------------------------------------
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const geoip = require('geoip-lite');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ------------------------------------------------------------------
// 1. Petit serveur HTTP statique (sert index.html, app.js, style.css)
// ------------------------------------------------------------------
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(PUBLIC_DIR, path.normalize(filePath).replace(/^(\.\.[/\\])+/, ''));

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 - Fichier non trouvé');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  });
});

// ------------------------------------------------------------------
// 2. Serveur WebSocket (signalisation + chat + matchmaking)
// ------------------------------------------------------------------
const wss = new WebSocket.Server({ server: httpServer });

// File d'attente des personnes qui cherchent un partenaire.
// Chaque entrée : { id, ws, gender, wantGender, targetCountry }
// targetCountry = le pays choisi par l'utilisateur pour aller y discuter
// (pas son pays d'origine).
let waitingPool = [];

// Rooms actives : Map<roomId, { a: clientA, b: clientB }>
const rooms = new Map();

// Map<ws, clientState> pour retrouver rapidement l'état d'un client
const clients = new Map();

function makeId() {
  return crypto.randomBytes(8).toString('hex');
}

// Récupère l'adresse IP réelle du visiteur (gère le cas d'un proxy/reverse
// proxy devant le serveur, ex: Nginx, qui pose l'en-tête X-Forwarded-For).
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  let ip = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
  // Les IPv4 mappées en IPv6 ont un préfixe "::ffff:" à retirer.
  if (ip && ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

// Déduit le pays (code ISO 2 lettres, ex "FR", "CH") à partir de l'IP.
// Renvoie 'any' si la détection échoue (IP locale/privée, base sans
// correspondance...) : dans ce cas le visiteur sera traité comme
// compatible avec toutes les recherches, plutôt que bloqué.
function detectCountry(ip) {
  const geo = geoip.lookup(ip);
  return (geo && geo.country) || 'any';
}

// Pseudonymise une IP (RGPD : minimisation des données). On ne stocke
// jamais l'IP en clair dans les logs, seulement une empreinte à sens
// unique — utile pour repérer un abus répété sans identifier l'IP réelle.
function hashIp(ip) {
  return crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 16);
}

// ------------------------------------------------------------------
// Journaux d'audit (fichiers texte, une ligne JSON par événement).
// Ne contiennent JAMAIS le contenu vidéo/audio (le serveur ne le voit
// pas) ni le texte du chat — uniquement les métadonnées nécessaires à
// la modération et à la traçabilité des consentements.
// ------------------------------------------------------------------
const SESSIONS_LOG_PATH = path.join(__dirname, 'sessions.log');
const REPORTS_LOG_PATH = path.join(__dirname, 'reports.log');

function appendLog(filePath, entry) {
  try {
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error(`Impossible d'écrire dans ${filePath} :`, e.message);
  }
}

function send(ws, type, payload = {}) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

// Est-ce que "candidate" correspond à ce que "seeker" recherche côté genre ?
function genderMatches(seeker, candidate) {
  return seeker.wantGender === 'any' || seeker.wantGender === candidate.gender;
}

// Est-ce que le pays réellement détecté de "candidate" correspond au pays
// que "seeker" a choisi pour discuter ? "any" = pas de préférence.
function countryMatches(seeker, candidate) {
  return seeker.targetCountry === 'any' || seeker.targetCountry === candidate.country;
}

// Deux personnes sont compatibles si le genre recherché correspond dans
// les deux sens ET si chacune est bien située dans le pays que l'autre
// a choisi (ou n'a pas de préférence de pays).
function isMutualMatch(a, b) {
  return (
    genderMatches(a, b) &&
    genderMatches(b, a) &&
    countryMatches(a, b) &&
    countryMatches(b, a)
  );
}

function removeFromPool(client) {
  waitingPool = waitingPool.filter((c) => c !== client);
}

// Cherche un partenaire compatible pour "client" dans la pool d'attente.
function tryMatch(client) {
  const candidateIndex = waitingPool.findIndex((other) => isMutualMatch(client, other));
  if (candidateIndex === -1) {
    // Personne de compatible pour l'instant : on rejoint la file d'attente.
    waitingPool.push(client);
    send(client.ws, 'status', { message: 'Recherche d\'un partenaire...' });
    return;
  }

  const partner = waitingPool[candidateIndex];
  removeFromPool(partner);

  const roomId = makeId();
  client.roomId = roomId;
  partner.roomId = roomId;
  rooms.set(roomId, { a: client, b: partner });

  // On désigne arbitrairement un "initiator" : c'est lui qui créera
  // l'offer WebRTC en premier côté client.
  send(client.ws, 'matched', { initiator: true, peerCountry: partner.country, peerGender: partner.gender });
  send(partner.ws, 'matched', { initiator: false, peerCountry: client.country, peerGender: client.gender });
}

function leaveRoom(client, notifyPartner = true) {
  if (!client.roomId) return;
  const room = rooms.get(client.roomId);
  if (room) {
    const partner = room.a === client ? room.b : room.a;
    rooms.delete(client.roomId);
    if (partner) {
      partner.roomId = null;
      if (notifyPartner) send(partner.ws, 'partner-left');
    }
  }
  client.roomId = null;
}

function getPartner(client) {
  if (!client.roomId) return null;
  const room = rooms.get(client.roomId);
  if (!room) return null;
  return room.a === client ? room.b : room.a;
}

wss.on('connection', (ws, req) => {
  const ip = getClientIp(req);
  const detectedCountry = detectCountry(ip);
  const ipHash = hashIp(ip);

  const client = {
    id: makeId(),
    ws,
    ipHash,
    gender: 'any',
    wantGender: 'any',
    country: detectedCountry,  // pays RÉEL détecté via l'IP (pas déclaré)
    targetCountry: 'any',      // pays choisi par l'utilisateur pour discuter
    ageConfirmed: false,
    roomId: null,
  };
  clients.set(ws, client);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return; // message mal formé, on ignore
    }

    switch (msg.type) {
      // Le client envoie ses préférences et démarre la recherche.
      case 'find': {
        // Contrôle serveur (pas seulement côté client) : sans confirmation
        // d'âge et acceptation des CGU, pas de recherche de partenaire.
        if (msg.ageConfirmed !== true || msg.cguAccepted !== true) {
          send(client.ws, 'find-rejected', {
            reason: 'Confirmation d\'âge et acceptation des CGU requises.',
          });
          break;
        }

        // On journalise la confirmation une seule fois par connexion
        // (pas à chaque clic sur "Suivant"), avec l'IP pseudonymisée.
        if (!client.ageConfirmed) {
          client.ageConfirmed = true;
          appendLog(SESSIONS_LOG_PATH, {
            timestamp: new Date().toISOString(),
            clientId: client.id,
            ipHash: client.ipHash,
            detectedCountry: client.country,
            ageConfirmed: true,
            cguAccepted: true,
          });
        }

        // On quitte une éventuelle room précédente avant de rechercher.
        leaveRoom(client);
        removeFromPool(client);

        client.gender = msg.gender || 'any';
        client.wantGender = msg.wantGender || 'any';
        client.targetCountry = msg.targetCountry || 'any';

        tryMatch(client);
        break;
      }

      // Relais de la signalisation WebRTC vers le partenaire de la room.
      case 'signal': {
        const partner = getPartner(client);
        if (partner) {
          send(partner.ws, 'signal', { data: msg.data });
        }
        break;
      }

      // Relais d'un message de chat texte.
      case 'chat': {
        const partner = getPartner(client);
        if (partner) {
          send(partner.ws, 'chat', { text: String(msg.text || '').slice(0, 1000) });
        }
        break;
      }

      // L'utilisateur signale son partenaire : on coupe IMMÉDIATEMENT la
      // connexion des deux côtés (avant même de journaliser), puis on
      // journalise l'incident pour examen manuel. On ne stocke jamais le
      // contenu vidéo/audio (le serveur ne le voit pas) ni l'historique
      // du chat — seulement les métadonnées utiles à la modération.
      case 'report': {
        const partner = getPartner(client);
        const entry = {
          timestamp: new Date().toISOString(),
          reporterId: client.id,
          reporterIpHash: client.ipHash,
          reportedId: partner ? partner.id : null,
          reportedIpHash: partner ? partner.ipHash : null,
          reportedCountry: partner ? partner.country : null,
          reason: String(msg.reason || '').slice(0, 300),
        };

        leaveRoom(client); // coupe aussi le partenaire (notifyPartner=true)
        appendLog(REPORTS_LOG_PATH, entry);
        console.warn('⚠️  Signalement reçu :', entry);

        send(client.ws, 'report-received');
        tryMatch(client); // relance automatiquement une recherche
        break;
      }

      // L'utilisateur clique sur "Suivant" : on quitte la room et on
      // relance immédiatement une recherche avec les mêmes critères.
      case 'next': {
        leaveRoom(client);
        tryMatch(client);
        break;
      }

      // L'utilisateur arrête complètement.
      case 'stop': {
        leaveRoom(client);
        removeFromPool(client);
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    removeFromPool(client);
    leaveRoom(client);
    clients.delete(ws);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Serveur OmeLike démarré : http://localhost:${PORT}`);
  console.log('Ouvre cette adresse dans deux onglets/navigateurs différents pour tester le matching.');
});
