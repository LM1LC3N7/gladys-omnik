// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys. Every text is a { en, fr } object. They never
// quote a text of the logger, a user name or a password: only our own words,
// error codes and the values we checked.
// -----------------------------------------------------------------------------

const seconds = (ms) => Math.max(1, Math.round(ms / 1000));
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const hours = (ms) => Math.max(1, Math.round(ms / 3_600_000));
export const delay = (ms) => {
  if (ms >= 2 * 3_600_000) return { en: `${hours(ms)} h`, fr: `${hours(ms)} h` };
  if (ms >= 60_000) return { en: `${minutes(ms)} min`, fr: `${minutes(ms)} min` };
  return { en: `${seconds(ms)} s`, fr: `${seconds(ms)} s` };
};

/** Our words for an error code of src/omnik/client.js and src/app.js. */
const REASON = {
  timeout: { en: 'no answer', fr: 'pas de réponse' },
  unreachable: { en: 'unreachable', fr: 'injoignable' },
  http: { en: 'HTTP error', fr: 'erreur HTTP' },
  not_found: {
    en: 'no such page at this address (is it an Omnik logger? try another source)',
    fr: 'pas de telle page à cette adresse (est-ce bien un enregistreur Omnik ? essayez une autre source)',
  },
  server: { en: 'error of the logger', fr: 'erreur de l’enregistreur' },
  rate_limited: { en: 'too many requests', fr: 'trop de requêtes' },
  too_large: { en: 'answer too large', fr: 'réponse trop grande' },
  unknown_answer: {
    en: 'not the status of an Omnik inverter in this source (try another source)',
    fr: 'ce n’est pas l’état d’un onduleur Omnik dans cette source (essayez une autre source)',
  },
  auth: {
    en: 'user name or password refused by the logger',
    fr: 'nom d’utilisateur ou mot de passe refusé par l’enregistreur',
  },
  no_serial: {
    en: 'the answer has no readable serial number, values not written',
    fr: 'la réponse n’a pas de numéro de série lisible, valeurs non écrites',
  },
  no_inverter: {
    en: 'the Wi-Fi logger answers without its inverter, right after it produced',
    fr: 'l’enregistreur Wi-Fi répond sans son onduleur, juste après qu’il a produit',
  },
  other_board: {
    en: 'another Wi-Fi logger answers at this address, without inverter',
    fr: 'un autre enregistreur Wi-Fi répond à cette adresse, sans onduleur',
  },
};

export function reason(err) {
  const text = REASON[err?.code] ?? { en: 'unexpected error', fr: 'erreur inattendue' };
  const status =
    (err?.code === 'http' || err?.code === 'server' || err?.code === 'auth') &&
    Number.isInteger(err.status)
      ? ` ${err.status}`
      : '';
  return { en: `${text.en}${status}`, fr: `${text.fr}${status}` };
}

const kwh = (value) => Math.round(value * 1000) / 1000;

const join = (lang, first, notes) => [first[lang], ...notes.map((n) => n[lang])].join(' ');
const withNotes = (first, notes) => ({
  en: join('en', first, notes),
  fr: join('fr', first, notes),
});

const MISSING = {
  address: {
    en: 'Enter the address of the Wi-Fi logger of your Omnik inverter (its IP address on your network, e.g. 192.168.1.70).',
    fr: 'Saisissez l’adresse de l’enregistreur Wi-Fi de votre onduleur Omnik (son adresse IP sur votre réseau, ex. 192.168.1.70).',
  },
  logger_serial: {
    en: 'The tcp source needs the serial number of the Wi-Fi logger (digits only, on its label or in its web page, e.g. 602123456).',
    fr: 'La source tcp demande le numéro de série de l’enregistreur Wi-Fi (chiffres seulement, sur son étiquette ou dans sa page web, ex. 602123456).',
  },
  credentials: {
    en: 'The html source needs the user name and the password of the logger’s web page.',
    fr: 'La source html demande le nom d’utilisateur et le mot de passe de la page web de l’enregistreur.',
  },
};

export const T = {
  incomplete: (missing) => MISSING[missing] ?? MISSING.address,
  badAddress: {
    en: 'The logger address is not valid: enter an IP address or a host name, with an optional port (e.g. 192.168.1.70).',
    fr: 'L’adresse de l’enregistreur n’est pas valide : saisissez une adresse IP ou un nom d’hôte, avec un port éventuel (ex. 192.168.1.70).',
  },
  /** Credentials refused: final, kept across restarts (lot 12). */
  refused: (address, notes = []) =>
    withNotes(
      {
        en: `The Omnik logger at ${address} refuses the user name or the password: no more reads with them. Enter the right ones in the configuration (or click "Test the connection" once they work again).`,
        fr: `L’enregistreur Omnik à l’adresse ${address} refuse le nom d’utilisateur ou le mot de passe : plus aucune lecture avec eux. Saisissez les bons dans la configuration (ou cliquez sur « Tester la connexion » quand ils fonctionnent de nouveau).`,
      },
      notes,
    ),
  /** `notes`: { en, fr } texts added after the failure (an index held back). */
  unreachable: (address, err, wait, notes = []) =>
    withNotes(
      {
        en: `The Omnik inverter at ${address} could not be read (${reason(err).en}): new try in ${delay(wait).en}.`,
        fr: `L’onduleur Omnik à l’adresse ${address} n’a pas pu être lu (${reason(err).fr}) : nouvel essai dans ${delay(wait).fr}.`,
      },
      notes,
    ),
  /** HTTP 429 or 5xx: a pause, kept across restarts. */
  paused: (address, err, wait, notes = []) =>
    withNotes(
      {
        en: `The Omnik logger at ${address} asks to wait (${reason(err).en}): reads paused, new try in ${delay(wait).en}.`,
        fr: `L’enregistreur Omnik à l’adresse ${address} demande d’attendre (${reason(err).fr}) : lectures en pause, nouvel essai dans ${delay(wait).fr}.`,
      },
      notes,
    ),
  /** The night: not an error. `board`: the Wi-Fi logger answered without an inverter. */
  asleep: (address, board, notes = []) =>
    withNotes(
      board
        ? {
            en: `The Omnik inverter at ${address} is asleep (no sun): its Wi-Fi logger answers without production. The values come back when it starts again.`,
            fr: `L’onduleur Omnik à l’adresse ${address} est en veille (pas de soleil) : son enregistreur Wi-Fi répond sans production. Les valeurs reviennent à son redémarrage.`,
          }
        : {
            en: `The Omnik inverter at ${address} does not answer: it is asleep (no sun), it goes on at sunrise. If it is daytime, check its address and its Wi-Fi.`,
            fr: `L’onduleur Omnik à l’adresse ${address} ne répond pas : il est en veille (pas de soleil), il reprend au lever du soleil. S’il fait jour, vérifiez son adresse et son Wi-Fi.`,
          },
      notes,
    ),
  /** No answer at all for a day: red, even at night. */
  silent: (address, notes = []) =>
    withNotes(
      {
        en: `The Omnik inverter at ${address} has given no reading for more than a day: check its address, its Wi-Fi, the inverter itself and its panels (snow?). New try every 5 minutes.`,
        fr: `L’onduleur Omnik à l’adresse ${address} n’a donné aucune lecture depuis plus d’un jour : vérifiez son adresse, son Wi-Fi, l’onduleur lui-même et ses panneaux (neige ?). Nouvel essai toutes les 5 minutes.`,
      },
      notes,
    ),
  noDevice: (serial) => ({
    en: `Omnik inverter ${serial} found: create its device from the "Discover" tab to receive its values.`,
    fr: `Onduleur Omnik ${serial} trouvé : créez son appareil depuis l’onglet « Découverte » pour recevoir ses valeurs.`,
  }),
  waitingSerial: (address) => ({
    en: `Waiting for the first answer of the Omnik inverter at ${address} (by day: its serial number gives its device).`,
    fr: `En attente de la première réponse de l’onduleur Omnik à l’adresse ${address} (de jour : son numéro de série donne son appareil).`,
  }),
  /** `notes`: { en, fr } texts added after the connection message. */
  ok: (address, notes = []) =>
    withNotes(
      {
        en: `Connected to the Omnik inverter (${address}).`,
        fr: `Connecté à l’onduleur Omnik (${address}).`,
      },
      notes,
    ),
  notes: {
    noIndex: {
      en: 'The counter of the day made a jump or a drop that is not a new day: no production index until it is back to a plausible value; what is not back is not counted.',
      fr: 'Le compteur du jour a fait un saut ou une baisse qui n’est pas un nouveau jour : pas d’index de production tant qu’il n’est pas revenu à une valeur plausible ; ce qui ne revient pas n’est pas compté.',
    },
    stale: {
      en: 'The inverter still shows the counter of the day before: no production index until it starts the new day.',
      fr: 'L’onduleur affiche encore le compteur de la veille : pas d’index de production tant qu’il n’a pas commencé le nouveau jour.',
    },
    otherInverter: (serial) => ({
      en: `Another inverter answers at this address (serial ${serial}): its values go to its own device, never to the previous one.`,
      fr: `Un autre onduleur répond à cette adresse (numéro de série ${serial}) : ses valeurs vont à son propre appareil, jamais au précédent.`,
    }),
    held: ({ direction, from, to }) => {
      if (direction === 'down') {
        return {
          en: `The solar production index built from the counter of the day went back from ${kwh(from)} to ${kwh(to)} kWh: held back, the last accepted value is sent again. Nothing to do: the index corrects itself and goes on once the counter is back above it (what is not back is not counted).`,
          fr: `L’index de production solaire construit à partir du compteur du jour est revenu de ${kwh(from)} à ${kwh(to)} kWh : retenu, la dernière valeur acceptée est renvoyée. Rien à faire : l’index se corrige seul et reprend quand le compteur l’a rattrapé (ce qui ne revient pas n’est pas compté).`,
        };
      }
      const diff = kwh(to - from);
      return {
        en: `The solar production index jumped from ${kwh(from)} to ${kwh(to)} kWh: held back, not sent to the energy monitoring. If you click "Accept the held index" in the configuration of the integration, ${diff} kWh will be counted at once; accept only if this energy was real. Saving the configuration accepts nothing.`,
        fr: `L’index de production solaire a sauté de ${kwh(from)} à ${kwh(to)} kWh : retenu, non envoyé au suivi énergétique. Si vous cliquez sur « Accepter l’index retenu » dans la configuration de l’intégration, ${diff} kWh seront comptés d’un coup ; n’acceptez que si cette énergie est réelle. Enregistrer la configuration n’accepte rien.`,
      };
    },
  },
  accept: {
    nothing: {
      en: 'No index is held back: nothing to accept.',
      fr: 'Aucun index n’est retenu : rien à accepter.',
    },
    /** A drop of the built index: never accepted (it corrects itself), review 1 I2. */
    drop: {
      en: 'The index held back is a drop: it is never accepted, it corrects itself and goes on once the counter of the day is back above it. Nothing to accept.',
      fr: 'L’index retenu est une baisse : elle n’est jamais acceptée, l’index se corrige seul et reprend quand le compteur du jour l’a rattrapé. Rien à accepter.',
    },
    done: ({ from, to }) => ({
      en: `Accepted: the solar production index ${kwh(to)} kWh will be sent at the next read, and ${kwh(to - from)} kWh (plus what comes meanwhile) will be counted at once. A different value stays held.`,
      fr: `Accepté : l’index de production solaire ${kwh(to)} kWh sera envoyé à la prochaine lecture, et ${kwh(to - from)} kWh (plus ce qui vient d’ici là) seront comptés d’un coup. Une autre valeur reste retenue.`,
    }),
  },
  test: {
    /** The outcome of a read, `ago` ms ago (0: just now), the next one in `next` ms. */
    reading: ({ serial, model, power }, ago, next) => ({
      en: `${ago > 0 ? `Last read ${delay(ago).en} ago` : 'Read now'}: Omnik inverter ${serial}${model ? ` (${model})` : ''}, ${power} W.${next > 0 ? ` Next read in ${delay(next).en}.` : ''}`,
      fr: `${ago > 0 ? `Dernière lecture il y a ${delay(ago).fr}` : 'Lu à l’instant'} : onduleur Omnik ${serial}${model ? ` (${model})` : ''}, ${power} W.${next > 0 ? ` Prochaine lecture dans ${delay(next).fr}.` : ''}`,
    }),
    asleep: (ago, next) => ({
      en: `${ago > 0 ? `Last read ${delay(ago).en} ago` : 'Read now'}: the Wi-Fi logger of the inverter answers, the inverter is asleep (no sun).${next > 0 ? ` Next read in ${delay(next).en}.` : ''}`,
      fr: `${ago > 0 ? `Dernière lecture il y a ${delay(ago).fr}` : 'Lu à l’instant'} : l’enregistreur Wi-Fi de l’onduleur répond, l’onduleur est en veille (pas de soleil).${next > 0 ? ` Prochaine lecture dans ${delay(next).fr}.` : ''}`,
    }),
    failed: (address, err, ago, next) => ({
      en: `${ago > 0 ? `Last read ${delay(ago).en} ago` : 'Read now'}: the inverter at ${address} could not be read (${reason(err).en}). Next read in ${delay(next).en}.`,
      fr: `${ago > 0 ? `Dernière lecture il y a ${delay(ago).fr}` : 'Lu à l’instant'} : l’onduleur à l’adresse ${address} n’a pas pu être lu (${reason(err).fr}). Prochaine lecture dans ${delay(next).fr}.`,
    }),
    /** Credentials refused: no automatic read; the next click may try once. */
    refused: (address, ago) => ({
      en: `${ago > 0 ? `Last read ${delay(ago).en} ago` : 'Read now'}: the logger at ${address} refuses the user name or the password. No automatic read until they change; this button tries again once a minute at most.`,
      fr: `${ago > 0 ? `Dernière lecture il y a ${delay(ago).fr}` : 'Lu à l’instant'} : l’enregistreur à l’adresse ${address} refuse le nom d’utilisateur ou le mot de passe. Aucune lecture automatique tant qu’ils ne changent pas ; ce bouton réessaie au plus une fois par minute.`,
    }),
    refusedWait: (next) => ({
      en: `The logger refused the user name or the password: this button can try again in ${delay(next).en} (never more than one read a minute).`,
      fr: `L’enregistreur a refusé le nom d’utilisateur ou le mot de passe : ce bouton pourra réessayer dans ${delay(next).fr} (jamais plus d’une lecture par minute).`,
    }),
    notYet: (next) => ({
      en: `No read yet with this configuration: the first one comes in ${delay(next).en} (never more than one a minute).`,
      fr: `Pas encore de lecture avec cette configuration : la première vient dans ${delay(next).fr} (jamais plus d’une par minute).`,
    }),
    slow: {
      en: 'The inverter is slow to answer: look at the integration status in a minute.',
      fr: 'L’onduleur tarde à répondre : regardez l’état de l’intégration dans une minute.',
    },
  },
};
