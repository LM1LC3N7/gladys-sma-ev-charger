// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The user name
// and the password of the charger are kept here in memory only: never
// logged, never written to /data, never put in a status or an error.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { CURRENT, DEFAULT_PORT, LIMITS, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  host: '',
  username: '',
  password: '',
  allow_commands: false,
  max_current: CURRENT.defaultCeiling,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * The address typed, without credentials pasted in it (`user:pass@`): they
 * are ignored (the dedicated fields hold them) and never shown back.
 */
export const withoutCredentials = (raw) =>
  String(raw ?? '')
    .trim()
    .replace(/^(https?:\/\/)?.*@/is, '$1');

/** Whether the text typed held credentials (`…@`): said in the status, never shown. */
export const hadCredentials = (raw) => /@/.test(String(raw ?? ''));

/**
 * The address of the charger typed by the user: an IPv4 address or a host
 * name, with an optional port (a pasted URL is reduced to its host and port).
 * Never a broadcast, multicast or unspecified address.
 * @returns {{ host: string, port: number } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  const text = withoutCredentials(raw)
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
  if (text === '' || text.length > 260) {
    return undefined;
  }
  const match = text.match(/^([^:]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    const [first, , , last] = host.split('.').map(Number);
    // 0.0.0.0/8, multicast and reserved (224+), and a .255 broadcast are not a charger.
    return first === 0 || first >= 224 || last === 255 ? undefined : { host, port };
  }
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A user name or a password typed in the form: printable ASCII, else ''. */
function secret(value, { trim = true } = {}) {
  if (typeof value !== 'string') {
    return '';
  }
  // A password is sent as typed (a space is a character of it); a user name is trimmed.
  const text = trim ? value.trim() : value;
  if (text.length < LIMITS.secretMin || text.length > LIMITS.secretMax) {
    return '';
  }
  return /^[\x20-\x7e]+$/.test(text) ? text : '';
}

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(DEFAULT_CONFIG, key) && value != null) {
      c[key] = value;
    }
  }
  const typed = withoutCredentials(c.host);
  // Credentials pasted in the address: the address is ignored (a fixed text
  // says why, the typed text is never shown back).
  const credentialsInHost = hadCredentials(c.host);
  const address = credentialsInHost ? undefined : parseAddress(typed);
  const typedUser = typeof c.username === 'string' && c.username.trim() !== '';
  const username = secret(c.username);
  const password = secret(c.password, { trim: false });
  const typedPassword = typeof c.password === 'string' && c.password !== '';
  const interval = Number(c.poll_interval);
  const ceiling = Number(c.max_current);
  return {
    address,
    /** The text typed when it is not an address (shown in the status, cut, without control characters). */
    invalidHost:
      typed !== '' && !address && !credentialsInHost
        ? // eslint-disable-next-line no-control-regex
          typed.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100)
        : undefined,
    /** Credentials typed in the address: ignored, said with a fixed text. */
    credentialsInHost,
    /** The login of the charger: a user name AND a password (one alone is refused). */
    auth: username && password ? { username, password } : undefined,
    noUsername: !typedUser,
    noPassword: !typedPassword,
    /** A user name or a password typed but refused (not plain ASCII, too long). */
    badSecret: (typedUser && !username) || (typedPassword && !password),
    allowCommands: strictTrue(c.allow_commands),
    maxCurrent:
      Number.isFinite(ceiling) && String(c.max_current).trim() !== ''
        ? Math.min(CURRENT.max, Math.max(CURRENT.min, Math.floor(ceiling)))
        : CURRENT.defaultCeiling,
    pollInterval:
      Number.isFinite(interval) && String(c.poll_interval).trim() !== ''
        ? Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, Math.round(interval)))
        : POLL_INTERVAL.default,
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** What identifies the credentials, to tell a change (never stored, never logged). */
export const credentialsKey = (config) =>
  config.auth ? JSON.stringify([config.auth.username, config.auth.password]) : 'none';

/** The address as a key of /data (the pin of the certificate belongs to it). */
export const targetKey = (config) => (config.address ? addressKey(config.address) : undefined);
