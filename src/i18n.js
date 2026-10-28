// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and state names, the status of
// the integration, the answers of the buttons and the command errors. None of
// them ever carries the user name, the password or the access token.
// -----------------------------------------------------------------------------

import { FEATURES, MODES, STATE } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** "45 s", "5 min", "2 h", in both languages (59.99 s is "1 min", never "60 s"). */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

/** A number of kWh for a message: at most 3 decimals. */
const kwh = (value) => String(Math.round(value * 1000) / 1000);

/** The start of a fingerprint, enough to compare it with the web page of the charger. */
export const shortFingerprint = (fingerprint) => String(fingerprint ?? '').slice(0, 23);

export const FEATURE_NAMES = {
  [FEATURES.STATUS]: both('Status', 'État'),
  [FEATURES.MODE]: both('Charging mode', 'Mode de charge'),
  [FEATURES.ROTARY]: both('Rotary switch', 'Sélecteur rotatif'),
  [FEATURES.HEALTH]: both('Status of the charger', 'Statut de la borne'),
  [FEATURES.CONNECTOR]: both('Connector', 'Connecteur'),
  [FEATURES.CHARGING_STATE]: both('Charging state', 'État de charge'),
  [FEATURES.PLUGGED]: both('Vehicle plugged in', 'Véhicule branché'),
  [FEATURES.STOPPED]: both('Charge stopped', 'Charge arrêtée'),
  [FEATURES.ERROR]: both('Error reported', 'Erreur signalée'),
  [FEATURES.POWER]: both('Power', 'Puissance'),
  [FEATURES.CURRENT_L1]: both('Current L1', 'Courant L1'),
  [FEATURES.CURRENT_L2]: both('Current L2', 'Courant L2'),
  [FEATURES.CURRENT_L3]: both('Current L3', 'Courant L3'),
  [FEATURES.VOLTAGE_L1]: both('Voltage L1', 'Tension L1'),
  [FEATURES.VOLTAGE_L2]: both('Voltage L2', 'Tension L2'),
  [FEATURES.VOLTAGE_L3]: both('Voltage L3', 'Tension L3'),
  [FEATURES.CURRENT_LIMIT]: both('Charge current limit', 'Limite du courant de charge'),
  [FEATURES.ENERGY_INDEX]: both('Energy index', "Index d'énergie"),
  [FEATURES.SESSION_ENERGY]: both('Energy of the session', 'Énergie de la session'),
  [FEATURES.STOP]: both('Stop charging', 'Arrêter la charge'),
  [FEATURES.START]: both('Start charging', 'Démarrer la charge'),
  [FEATURES.SET_MODE]: both('Set the charging mode', 'Régler le mode de charge'),
  [FEATURES.SET_CURRENT]: both('Set the charging current', 'Régler le courant de charge'),
};

export const STATE_NAMES = {
  [STATE.STANDBY]: both('No vehicle', 'Aucun véhicule'),
  [STATE.CONNECTED]: both('Vehicle plugged in, not charging', 'Véhicule branché, sans charge'),
  [STATE.CHARGING]: both('Charging', 'En charge'),
  [STATE.LOCKED]: both('Charging station locked', 'Borne verrouillée'),
  [STATE.ERROR]: both('Charger fault', 'Défaut de la borne'),
  [STATE.UNKNOWN]: both('Unknown state', 'État inconnu'),
  [STATE.OFFLINE]: both('Charger unreachable', 'Borne injoignable'),
};

/** A vehicle plugged in with the mode "Charge stop". */
export const STOPPED = both(
  'Vehicle plugged in, charge stopped',
  'Véhicule branché, charge arrêtée',
);

export const MODE_NAMES = {
  [MODES.BOOST]: both('Boost charging', 'Charge rapide'),
  [MODES.OPTIMIZED]: both('Optimized charging', 'Charge optimisée'),
  [MODES.SETPOINT]: both('Charging with setpoint', 'Charge avec consigne'),
  [MODES.STOP]: both('Charge stop', 'Arrêt de la charge'),
  other: both('Unknown mode', 'Mode inconnu'),
};

export const ROTARY_NAMES = {
  smart: both('Smart charging', 'Charge intelligente'),
  boost: both('Boost charging', 'Charge rapide'),
};

export const HEALTH_NAMES = {
  ok: both('OK', 'OK'),
  warning: both('Warning', 'Avertissement'),
  alarm: both('Alarm', 'Alarme'),
  off: both('Off', 'Éteinte'),
};

/** The integration status, the buttons and the logs a user may read. */
export const T = {
  noHost: both(
    'Enter the IP address of your SMA EV Charger, the user name and the password of its web interface, then save.',
    "Saisissez l'adresse IP de votre borne SMA EV Charger, le nom d'utilisateur et le mot de passe de son interface web, puis enregistrez.",
  ),
  invalidHost: (typed) =>
    both(
      `"${typed}" is not an IP address of a device nor a host name.`,
      `« ${typed} » n'est ni l'adresse IP d'un appareil ni un nom d'hôte.`,
    ),
  credentialsInHost: both(
    'The address holds a user name or a password ("…@"): enter the address alone, and the credentials in their own fields.',
    "L'adresse contient un nom d'utilisateur ou un mot de passe (« …@ ») : saisissez l'adresse seule, et les identifiants dans leurs champs.",
  ),
  noCredentials: both(
    'Enter the user name AND the password of the web interface of the charger (one alone is refused), then save.',
    "Saisissez le nom d'utilisateur ET le mot de passe de l'interface web de la borne (l'un sans l'autre est refusé), puis enregistrez.",
  ),
  badSecret: both(
    'The user name and the password must be plain ASCII, 256 characters at most.',
    "Le nom d'utilisateur et le mot de passe doivent être en ASCII simple, 256 caractères au plus.",
  ),
  configRetry: (wait) =>
    both(
      `The configuration could not be read from Gladys: asked again in ${wait.en}.`,
      `La configuration n'a pas pu être lue auprès de Gladys : nouvelle demande dans ${wait.fr}.`,
    ),
  storageUnreadable: both(
    'The state kept in /data cannot be read: nothing is sent to the charger (its pinned certificate is unknown) until it can. It is read again at each interval.',
    "L'état gardé dans /data ne peut pas être lu : rien n'est envoyé à la borne (son certificat épinglé est inconnu) tant que ce n'est pas possible. Il est relu à chaque intervalle.",
  ),
  connecting: both('Reading the charger…', 'Lecture de la borne…'),
  connected: (summary) => both(`Connected. ${summary.en}`, `Connecté. ${summary.fr}`),
  unreachable: (host, wait) =>
    both(
      `No answer from ${host} (next try in ${wait.en}). Check the address and that the charger is on the network.`,
      `Pas de réponse de ${host} (nouvel essai dans ${wait.fr}). Vérifiez l'adresse et que la borne est sur le réseau.`,
    ),
  failing: (reason, wait) =>
    both(
      `The charger answers with an error (${reason}): next try in ${wait.en}.`,
      `La borne répond par une erreur (${reason}) : nouvel essai dans ${wait.fr}.`,
    ),
  forbidden: (reason, wait) =>
    both(
      `The charger accepted the login but refused to give its values (${reason}): the user may lack the rights (an installer or administrator account is needed). Next try in ${wait.en}.`,
      `La borne a accepté la connexion mais refusé de donner ses valeurs (${reason}) : l'utilisateur n'a peut-être pas les droits (un compte installateur ou administrateur est nécessaire). Nouvel essai dans ${wait.fr}.`,
    ),
  rateLimited: (wait) =>
    both(
      `The charger asks to slow down (HTTP 429): pause of ${wait.en}.`,
      `La borne demande de ralentir (HTTP 429) : pause de ${wait.fr}.`,
    ),
  serverError: (wait) =>
    both(
      `The charger answered with a server error (HTTP 5xx): pause of ${wait.en}.`,
      `La borne a répondu par une erreur serveur (HTTP 5xx) : pause de ${wait.fr}.`,
    ),
  authRefused: both(
    'The charger refused the user name or the password: no new try until you save other ones or click "Test the connection" (a charger may lock the account after a few refused passwords).',
    "La borne a refusé le nom d'utilisateur ou le mot de passe : aucun nouvel essai tant que vous n'en enregistrez pas d'autres ou ne cliquez pas sur « Tester la connexion » (une borne peut verrouiller le compte après quelques mots de passe refusés).",
  ),
  certificateChanged: (fingerprint) =>
    both(
      `The certificate of the charger changed (now ${shortFingerprint(fingerprint)}…): nothing is sent to it, the password neither. If you replaced or updated the charger, click "Trust the new certificate".`,
      `Le certificat de la borne a changé (maintenant ${shortFingerprint(fingerprint)}…) : rien ne lui est envoyé, le mot de passe non plus. Si vous avez remplacé ou mis à jour la borne, cliquez sur « Faire confiance au nouveau certificat ».`,
    ),
  storage: both(
    'The certificate of the charger could not be kept in /data: the password is not sent until it can (check the storage of Gladys).',
    "Le certificat de la borne n'a pas pu être gardé dans /data : le mot de passe n'est pas envoyé tant que ce n'est pas possible (vérifiez le stockage de Gladys).",
  ),
  notSma: both(
    'The device at this address answers, but not as an SMA EV Charger (no serial number): it cannot be added.',
    "L'appareil à cette adresse répond, mais pas comme une borne SMA EV Charger (pas de numéro de série) : elle ne peut pas être ajoutée.",
  ),
  otherCharger: (names) =>
    both(
      `Not read any more: ${names} (another charger answers at this address, or it was removed).`,
      `Plus lue : ${names} (une autre borne répond à cette adresse, ou elle a été retirée).`,
    ),
  pendingStop: both(
    '"Stop charging" could not be sent yet: it is sent again before the next reads.',
    "« Arrêter la charge » n'a pas encore pu être envoyée : elle est renvoyée avant les prochaines lectures.",
  ),
  held: (held) =>
    both(
      `Energy index held back: ${held.direction === 'down' ? 'a drop (meter reset or replaced?)' : 'a jump'} from ${kwh(held.from)} to ${kwh(held.to)} kWh, never counted without you ("Accept the held index", two clicks).`,
      `Index d'énergie retenu : ${held.direction === 'down' ? 'une baisse (compteur remis à zéro ou remplacé ?)' : 'un saut'} de ${kwh(held.from)} à ${kwh(held.to)} kWh, jamais compté sans vous (« Accepter l'index retenu », deux clics).`,
    ),
  test: {
    blockedWait: (wait) =>
      both(
        `Refused credentials are tried again at most once a minute: click again in ${wait.en}.`,
        `Des identifiants refusés sont réessayés au plus une fois par minute : cliquez de nouveau dans ${wait.fr}.`,
      ),
    notDue: (wait) =>
      both(
        `The charger is read at most once per interval: next read in ${wait.en}.`,
        `La borne est lue au plus une fois par intervalle : prochaine lecture dans ${wait.fr}.`,
      ),
  },
  accept: {
    nothing: both('No energy index is held back.', "Aucun index d'énergie n'est retenu."),
    confirm: (held) =>
      both(
        `Held: ${held.direction === 'down' ? 'a drop' : 'a jump'} from ${kwh(held.from)} to ${kwh(held.to)} kWh (${kwh(Math.max(0, held.to - held.from))} kWh would be counted). Click again between 3 and 60 s from now to accept exactly this.`,
        `Retenu : ${held.direction === 'down' ? 'une baisse' : 'un saut'} de ${kwh(held.from)} à ${kwh(held.to)} kWh (${kwh(Math.max(0, held.to - held.from))} kWh seraient comptés). Cliquez de nouveau entre 3 et 60 s à partir de maintenant pour accepter exactement cela.`,
      ),
    done: (taken) =>
      both(
        `Accepted: ${taken.direction === 'down' ? 'the drop' : 'the jump'} from ${kwh(taken.from)} to ${kwh(taken.to)} kWh; the index goes on from there.`,
        `Accepté : ${taken.direction === 'down' ? 'la baisse' : 'le saut'} de ${kwh(taken.from)} à ${kwh(taken.to)} kWh ; l'index repart de là.`,
      ),
  },
  trust: {
    confirm: (fingerprint) =>
      both(
        `Certificate refused: ${fingerprint}. Compare it, then click again between 3 and 60 s from now to trust exactly this one.`,
        `Certificat refusé : ${fingerprint}. Comparez-le, puis cliquez de nouveau entre 3 et 60 s à partir de maintenant pour approuver exactement celui-ci.`,
      ),
    nothing: both(
      'No new certificate was refused: nothing to trust.',
      "Aucun nouveau certificat n'a été refusé : rien à approuver.",
    ),
    done: (fingerprint) =>
      both(
        `The certificate ${shortFingerprint(fingerprint)}… is trusted from now on.`,
        `Le certificat ${shortFingerprint(fingerprint)}… est désormais approuvé.`,
      ),
  },
  badge: {
    held: (held) =>
      both(
        `Energy index held: ${kwh(held.from)} → ${kwh(held.to)} kWh`,
        `Index d'énergie retenu : ${kwh(held.from)} → ${kwh(held.to)} kWh`,
      ),
  },
};

const STOP_AVAILABLE = both(
  '"Stop charging" stays available',
  '« Arrêter la charge » reste disponible',
);

/** The errors a command answers to Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  disabled: both(
    `Starting, the charging mode and the charging current are disabled: turn on "Allow starting, the mode and the current" in the configuration of the integration (${STOP_AVAILABLE.en}).`,
    `Le démarrage, le mode de charge et le courant de charge sont désactivés : activez « Autoriser le démarrage, le mode et le courant » dans la configuration de l'intégration (${STOP_AVAILABLE.fr}).`,
  ),
  noConfig: both(
    'The configuration was not read from Gladys yet: not sent.',
    "La configuration n'a pas encore été lue auprès de Gladys : non envoyée.",
  ),
  storageUnreadable: both(
    'The state kept in /data cannot be read (pinned certificate unknown): not sent.',
    "L'état gardé dans /data ne peut pas être lu (certificat épinglé inconnu) : non envoyée.",
  ),
  unknownCharger: both(
    'This charger is not read by the integration (address changed, another charger, or not answering yet).',
    "Cette borne n'est pas lue par l'intégration (adresse changée, autre borne, ou pas encore de réponse).",
  ),
  otherCharger: both(
    'Another charger answers at the address: command not sent.',
    "Une autre borne répond à l'adresse : commande non envoyée.",
  ),
  notReadYet: both(
    'The charger was not read since the start: only "Stop charging" is accepted until then. Not sent.',
    "La borne n'a pas encore été lue depuis le démarrage : seule « Arrêter la charge » est acceptée d'ici là. Non envoyée.",
  ),
  noAddress: both(
    'No valid address, user name or password in the configuration: not sent.',
    "Aucune adresse, aucun nom d'utilisateur ou aucun mot de passe valable dans la configuration : non envoyée.",
  ),
  certificate: both(
    'The certificate of the charger changed: nothing is sent to it ("Trust the new certificate" in the configuration).',
    'Le certificat de la borne a changé : rien ne lui est envoyé (« Faire confiance au nouveau certificat » dans la configuration).',
  ),
  configChanged: both(
    'The configuration changed during the command: not sent, try again.',
    'La configuration a changé pendant la commande : non envoyée, réessayez.',
  ),
  storage: both(
    'The certificate of the charger could not be kept in /data: the password is not sent. Not sent.',
    "Le certificat de la borne n'a pas pu être gardé dans /data : le mot de passe n'est pas envoyé. Non envoyée.",
  ),
  credentialsRefused: both(
    'The charger refused the user name or the password: not sent.',
    "La borne a refusé le nom d'utilisateur ou le mot de passe : non envoyée.",
  ),
  forbidden: (reason) =>
    both(
      `The charger refused the request (${reason}): the user may lack the rights (an installer or administrator account is needed). Not applied.`,
      `La borne a refusé la requête (${reason}) : l'utilisateur n'a peut-être pas les droits (un compte installateur ou administrateur est nécessaire). Non appliquée.`,
    ),
  rateLimitedNotSent: (wait) =>
    both(
      `The charger asks to slow down (HTTP 429): not sent, pause of ${wait.en} (${STOP_AVAILABLE.en}).`,
      `La borne demande de ralentir (HTTP 429) : non envoyée, pause de ${wait.fr} (${STOP_AVAILABLE.fr}).`,
    ),
  badButton: both('A button only accepts the value 1.', "Un bouton n'accepte que la valeur 1."),
  badMode: both(
    'The charging mode must be one of the list: boost, optimized or stop.',
    'Le mode de charge doit être un de la liste : boost, optimized ou stop.',
  ),
  badCurrent: both(
    'The charging current must be a whole number of amperes.',
    "Le courant de charge doit être un nombre entier d'ampères.",
  ),
  outOfBounds: (min, max) =>
    both(
      `The charging current must be between ${min} and ${max} A for this charger: not sent.`,
      `Le courant de charge doit être entre ${min} et ${max} A pour cette borne : non envoyé.`,
    ),
  modeNotOffered: (mode) =>
    both(
      `The charger does not offer "${mode.en}" now (optimized charging needs an energy manager such as the Sunny Home Manager): not sent.`,
      `La borne ne propose pas « ${mode.fr} » en ce moment (la charge optimisée demande un gestionnaire d'énergie comme le Sunny Home Manager) : non envoyée.`,
    ),
  paused: (wait) =>
    both(
      `The charger asked to slow down: commands paused for ${wait.en} (${STOP_AVAILABLE.en}).`,
      `La borne a demandé de ralentir : commandes en pause pendant ${wait.fr} (${STOP_AVAILABLE.fr}).`,
    ),
  serverPaused: (wait) =>
    both(
      `The charger answered with a server error: commands paused for ${wait.en} (${STOP_AVAILABLE.en}).`,
      `La borne a répondu par une erreur serveur : commandes en pause pendant ${wait.fr} (${STOP_AVAILABLE.fr}).`,
    ),
  blocked: both(
    'The charger refused the credentials: commands are not sent until they are fixed ("Stop charging" is still tried).',
    "La borne a refusé les identifiants : les commandes ne sont pas envoyées tant qu'ils ne sont pas corrigés (« Arrêter la charge » est quand même tentée).",
  ),
  blockedStop: (wait) =>
    both(
      `The charger refused the credentials less than 5 minutes ago: a refused password is never sent again in a loop, try again in ${wait.en}. Not sent.`,
      `La borne a refusé les identifiants il y a moins de 5 minutes : un mot de passe refusé n'est jamais renvoyé en boucle, réessayez dans ${wait.fr}. Non envoyée.`,
    ),
  stillRunning: both(
    `Another command of this charger is still running: not sent (${STOP_AVAILABLE.en}).`,
    `Une autre commande de cette borne est encore en cours : non envoyée (${STOP_AVAILABLE.fr}).`,
  ),
  stopMeanwhile: both(
    'A stop of this charger arrived meanwhile: this command is not sent.',
    "Un arrêt de cette borne est arrivé entre-temps : cette commande n'est pas envoyée.",
  ),
  tooOften: (wait) =>
    both(
      `The charge was started or its mode or current changed less than a minute ago: try again in ${wait.en} (${STOP_AVAILABLE.en}). Not sent.`,
      `La charge a été démarrée ou son mode ou son courant changé il y a moins d'une minute : réessayez dans ${wait.fr} (${STOP_AVAILABLE.fr}). Non envoyée.`,
    ),
  tooSlow: both(
    'The charger answered too slowly to send the command in time: not sent.',
    'La borne a répondu trop lentement pour envoyer la commande à temps : non envoyée.',
  ),
  unknownState: (reason) =>
    both(
      `The state of the charger could not be read just before (${reason}): command not sent.`,
      `L'état de la borne n'a pas pu être relu juste avant (${reason}) : commande non envoyée.`,
    ),
  missing: both(
    'The charger did not give the state this command needs: not sent.',
    "La borne n'a pas donné l'état dont cette commande a besoin : non envoyée.",
  ),
  noVehicle: both(
    'No vehicle is plugged in: the charge is not started. Not sent.',
    "Aucun véhicule n'est branché : la charge n'est pas démarrée. Non envoyée.",
  ),
  fault: (state) =>
    both(
      `The charger reports "${state.en}": not sent.`,
      `La borne signale « ${state.fr} » : non envoyée.`,
    ),
  notSent: (reason) =>
    both(
      `The charger could not be reached (${reason}): command not sent.`,
      `La borne n'a pas pu être jointe (${reason}) : commande non envoyée.`,
    ),
  stopKept: (reason) =>
    both(
      `The charger could not be reached (${reason}): "Stop charging" not sent yet; it is kept and sent again before the next reads (3 tries within 15 minutes).`,
      `La borne n'a pas pu être jointe (${reason}) : « Arrêter la charge » pas encore envoyée ; elle est gardée et renvoyée avant les prochaines lectures (3 essais en 15 minutes).`,
    ),
  refused: (reason) =>
    both(
      `The charger refused the command (${reason}).`,
      `La borne a refusé la commande (${reason}).`,
    ),
  notYetApplied: both(
    'Command accepted by the charger, but the read right after still shows the value before: not applied yet, checked again in 5 and 20 seconds.',
    "Commande acceptée par la borne, mais la lecture juste après montre encore la valeur d'avant : pas encore appliquée, vérifiée de nouveau dans 5 et 20 secondes.",
  ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): check the state of the charger in a few seconds.`,
      `Commande envoyée, sans confirmation (${reason}) : vérifiez l'état de la borne dans quelques secondes.`,
    ),
};

/** The one-line summary of the charger: "SMA EV Charger 7890: Charging, 7200 W, 16 A limit". */
export function summaryOf({ name, power, current, mode }, stateText) {
  const en = [stateText.en];
  const fr = [stateText.fr];
  if (mode) {
    en.push(mode.en);
    fr.push(mode.fr);
  }
  if (power !== undefined) {
    en.push(`${power} W`);
    fr.push(`${power} W`);
  }
  if (current !== undefined) {
    en.push(`${current} A limit`);
    fr.push(`limite ${current} A`);
  }
  return both(`${name}: ${en.join(', ')}.`, `${name} : ${fr.join(', ')}.`);
}
