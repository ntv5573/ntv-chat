/**
 * app.js — logique du client.
 *
 * Trois responsabilités principales :
 *  1. Parler au serveur en WebSocket (rejoindre la file d'attente,
 *     recevoir "matched", relayer la signalisation WebRTC, envoyer/recevoir
 *     le chat).
 *  2. Gérer la connexion WebRTC (RTCPeerConnection) : récupérer la caméra,
 *     créer l'offer/answer, échanger les ICE candidates via le serveur,
 *     puis afficher le flux vidéo distant une fois connecté.
 *  3. Gérer l'interface (formulaire de préférences, écran d'appel, chat).
 */

// -----------------------------------------------------------------
// Liste de pays proposée dans les filtres. On garde une liste courte
// et pédagogique plutôt qu'une liste ISO complète.
// -----------------------------------------------------------------
const COUNTRIES = [
  ['any', 'Non précisé'],
  ['FR', 'France'],
  ['BE', 'Belgique'],
  ['CH', 'Suisse'],
  ['CA', 'Canada'],
  ['DE', 'Allemagne'],
  ['ES', 'Espagne'],
  ['IT', 'Italie'],
  ['GB', 'Royaume-Uni'],
  ['US', 'États-Unis'],
  ['MA', 'Maroc'],
  ['DZ', 'Algérie'],
  ['TN', 'Tunisie'],
  ['SN', 'Sénégal'],
  ['CI', "Côte d'Ivoire"],
  ['JP', 'Japon'],
  ['BR', 'Brésil'],
];

// Config ICE : serveur STUN public de Google pour la découverte d'adresse.
// Pour un vrai déploiement (utilisateurs derrière des box/NAT restrictifs),
// il faut en plus un serveur TURN (ex: coturn) — voir le README.
const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

// -----------------------------------------------------------------
// État global
// -----------------------------------------------------------------
let ws = null;
let pc = null;           // RTCPeerConnection en cours
let localStream = null;
let isInitiator = false;

// -----------------------------------------------------------------
// Références DOM
// -----------------------------------------------------------------
const setupScreen = document.getElementById('setup-screen');
const callScreen = document.getElementById('call-screen');
const startBtn = document.getElementById('start-btn');
const setupError = document.getElementById('setup-error');

const myGenderSel = document.getElementById('my-gender');
const wantGenderSel = document.getElementById('want-gender');
const targetCountrySel = document.getElementById('target-country');
const ageConfirmChk = document.getElementById('age-confirm');
const cguAcceptChk = document.getElementById('cgu-accept');

const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const callStatus = document.getElementById('call-status');
const peerTag = document.getElementById('peer-tag');

const nextBtn = document.getElementById('next-btn');
const stopBtn = document.getElementById('stop-btn');
const reportBtn = document.getElementById('report-btn');

const chatLog = document.getElementById('chat-log');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');

// -----------------------------------------------------------------
// Init des <select> pays
// -----------------------------------------------------------------
function fillCountrySelects() {
  for (const [code, label] of COUNTRIES) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = code === 'any' ? "N'importe quel pays" : label;
    targetCountrySel.appendChild(opt);
  }
}
fillCountrySelects();

// -----------------------------------------------------------------
// Verrouillage du bouton "Démarrer" tant que l'âge et les CGU ne sont
// pas confirmés (contrôle côté serveur aussi, voir server.js).
// -----------------------------------------------------------------
function updateStartBtnState() {
  startBtn.disabled = !(ageConfirmChk.checked && cguAcceptChk.checked);
}
ageConfirmChk.addEventListener('change', updateStartBtnState);
cguAcceptChk.addEventListener('change', updateStartBtnState);
updateStartBtnState();

// -----------------------------------------------------------------
// Démarrage : accès caméra + connexion WebSocket
// -----------------------------------------------------------------
startBtn.addEventListener('click', async () => {
  if (!ageConfirmChk.checked || !cguAcceptChk.checked) return; // garde-fou, ne devrait pas arriver (bouton désactivé sinon)

  setupError.textContent = '';
  startBtn.disabled = true;
  startBtn.textContent = 'Accès à la caméra…';

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    setupError.textContent = "Impossible d'accéder à la caméra/micro : " + err.message;
    startBtn.disabled = false;
    startBtn.textContent = 'Démarrer la recherche';
    return;
  }

  localVideo.srcObject = localStream;

  setupScreen.classList.add('hidden');
  callScreen.classList.remove('hidden');

  connectWebSocket();
});

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.addEventListener('open', () => {
    requestMatch();
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    handleServerMessage(msg);
  });

  ws.addEventListener('close', () => {
    setCallStatus('Connexion au serveur perdue.');
  });
}

function requestMatch() {
  setCallStatus("Recherche d'un partenaire…");
  peerTag.classList.add('hidden');
  ws.send(JSON.stringify({
    type: 'find',
    gender: myGenderSel.value,
    wantGender: wantGenderSel.value,
    targetCountry: targetCountrySel.value,
    ageConfirmed: ageConfirmChk.checked,
    cguAccepted: cguAcceptChk.checked,
  }));
}

// -----------------------------------------------------------------
// Réception des messages serveur
// -----------------------------------------------------------------
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'status':
      setCallStatus(msg.message);
      break;

    case 'matched':
      isInitiator = msg.initiator;
      showPeerTag(msg.peerCountry, msg.peerGender);
      addSystemMessage('Connecté avec un inconnu. Sois respectueux 🙂');
      startWebRTC();
      break;

    case 'signal':
      handleSignal(msg.data);
      break;

    case 'chat':
      addChatMessage(msg.text, 'them');
      break;

    case 'partner-left':
      addSystemMessage("L'autre personne a quitté la conversation.");
      teardownPeerConnection();
      setCallStatus("Partenaire déconnecté. Clique sur 'Suivant' pour continuer.", true);
      break;

    case 'find-rejected':
      setCallStatus(msg.reason || 'Recherche refusée.', true);
      break;

    case 'report-received':
      addSystemMessage('Signalement transmis. Recherche d\'un nouveau partenaire…');
      break;

    default:
      break;
  }
}

function showPeerTag(country, gender) {
  const countryLabel = (COUNTRIES.find((c) => c[0] === country) || [null, 'pays non détecté'])[1];
  const genderLabel = gender === 'homme' ? 'Homme' : gender === 'femme' ? 'Femme' : 'Genre non précisé';
  peerTag.textContent = `${genderLabel} · ${countryLabel}`;
  peerTag.classList.remove('hidden');
}

function setCallStatus(text, away = false) {
  callStatus.textContent = text;
  callStatus.classList.toggle('away', away);
  callStatus.style.display = 'flex';
}

function hideCallStatus() {
  callStatus.style.display = 'none';
}

// -----------------------------------------------------------------
// WebRTC : établissement de la connexion peer-to-peer
// -----------------------------------------------------------------
function startWebRTC() {
  teardownPeerConnection(); // au cas où une ancienne connexion traînerait

  pc = new RTCPeerConnection(RTC_CONFIG);

  // On envoie notre flux caméra/micro au partenaire.
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  // Quand le flux distant arrive, on l'affiche.
  pc.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    hideCallStatus();
  };

  // Chaque ICE candidate trouvée localement doit être envoyée à l'autre
  // via le serveur de signalisation.
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({ type: 'signal', data: { candidate: event.candidate } }));
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc && (pc.connectionState === 'disconnected' || pc.connectionState === 'failed')) {
      setCallStatus('Connexion perdue avec le partenaire.', true);
    }
  };

  if (isInitiator) {
    pc.onnegotiationneeded = async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'signal', data: { sdp: pc.localDescription } }));
    };
  }
}

async function handleSignal(data) {
  if (!pc) return;

  if (data.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'signal', data: { sdp: pc.localDescription } }));
    }
  } else if (data.candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (e) {
      // Peut arriver si la candidate arrive avant la remote description ;
      // sans impact pratique pour ce prototype.
    }
  }
}

function teardownPeerConnection() {
  if (pc) {
    pc.close();
    pc = null;
  }
  remoteVideo.srcObject = null;
}

// -----------------------------------------------------------------
// Boutons Suivant / Arrêter
// -----------------------------------------------------------------
nextBtn.addEventListener('click', () => {
  teardownPeerConnection();
  chatLog.innerHTML = '';
  peerTag.classList.add('hidden');
  ws.send(JSON.stringify({ type: 'next' }));
  setCallStatus("Recherche d'un nouveau partenaire…");
});

reportBtn.addEventListener('click', () => {
  const reason = window.prompt(
    "Décris brièvement le problème (optionnel). La conversation va être immédiatement coupée."
  );
  if (reason === null) return; // l'utilisateur a annulé la boîte de dialogue

  ws.send(JSON.stringify({ type: 'report', reason: reason || '' }));
  teardownPeerConnection();
  chatLog.innerHTML = '';
  peerTag.classList.add('hidden');
  setCallStatus('Signalement en cours…');
});

stopBtn.addEventListener('click', () => {
  ws.send(JSON.stringify({ type: 'stop' }));
  teardownPeerConnection();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  if (ws) ws.close();
  callScreen.classList.add('hidden');
  setupScreen.classList.remove('hidden');
  startBtn.disabled = false;
  startBtn.textContent = 'Démarrer la recherche';
  chatLog.innerHTML = '';
});

// -----------------------------------------------------------------
// Chat texte
// -----------------------------------------------------------------
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'chat', text }));
  addChatMessage(text, 'me');
  chatInput.value = '';
});

function addChatMessage(text, who) {
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.innerHTML = `<span class="who">${who === 'me' ? 'Toi' : 'Inconnu'}</span><span class="bubble"></span>`;
  div.querySelector('.bubble').textContent = text; // textContent : pas d'injection HTML
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'msg system';
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}
