/**
 * CONSIG: LOG-REDACT (consigai/jambonz-feature-server#3, codex review finding 5). This whole file is
 * Consig's. Why a separate file: callers add one function call at each log site, so the upstream diff
 * stays at one line per site.
 * Called by: lib/tasks/listen.js, lib/tasks/config.js, lib/utils/background-task-manager.js,
 * lib/session/call-session.js. Tests: test/speech-events-unit-test.js ("listen-redact:" tests).
 * Invariants: the output is built from an allowlist, never by copying and masking the input, so a new
 * caller-supplied field cannot leak by default. Log and trace call sites only: do not use it on data
 * that is sent anywhere. If a log line passes a listen option object directly, that is a regression.
 */
/**
 * What a log line or trace may say about a listen: a fixed allowlist, never a copy of the
 * caller-supplied options. A listen url can carry a signed query (a bearer token), its path or the
 * metadata can carry identifiers or phone numbers, and keyterms can carry patient names.
 * Use at log and trace call sites only; what is sent on the wire is never changed.
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_NAME = /^[A-Za-z0-9_.-]{1,32}$/;
const MIX_TYPES = ['mono', 'mixed', 'stereo'];
const SPEECH_MODES = ['off', 'shadow', 'drive'];

/**
 * @param {*} url
 * @returns {string|undefined} scheme, host and first path segment only ('/…' marks a longer path);
 *   no credentials, query or fragment
 */
function urlForLog(url) {
  if (typeof url !== 'string') return undefined;
  const abs = /^([a-z][a-z0-9+.-]*:)?\/\/(?:[^/@?#]*@)?([^/?#]*)(\/[^/?#]*)?([^?#]*)/i.exec(url);
  if (abs) return `${abs[1] || ''}//${abs[2]}${abs[3] || ''}${abs[4] ? '/…' : ''}`;
  const rel = /^(\/[^/?#]*)([^?#]*)/.exec(url);
  if (rel) return `${rel[1]}${rel[2] ? '/…' : ''}`;
  return '[url]';
}

const pick = (value, ok) => (value === undefined ? undefined : (ok(value) ? value : '[invalid]'));

/**
 * @param {object} opts - listen verb options, a listen task's data, or a ws hook
 * @param {string} [bugname]
 * @returns {object} url (see urlForLog), mixType, sampleRate, bugname, auth (boolean) and, when
 *   metadata.speech is present, speech {mode, engine, keyterm_count, listen_id}. Nothing else.
 */
function listenForLog(opts, bugname) {
  if (!opts || typeof opts !== 'object') return {};
  const out = {
    url: urlForLog(opts.url),
    mixType: pick(opts.mixType, (v) => MIX_TYPES.includes(v)),
    sampleRate: pick(opts.sampleRate, Number.isInteger),
    bugname: pick(bugname, (v) => typeof v === 'string' && SAFE_NAME.test(v)),
    auth: !!(opts.wsAuth || opts.auth)
  };
  const speech = opts.metadata && typeof opts.metadata === 'object' ? opts.metadata.speech : undefined;
  if (speech && typeof speech === 'object') {
    const keyterms = speech.engine_options?.keyterms;
    out.speech = {
      mode: pick(speech.mode, (v) => SPEECH_MODES.includes(v)),
      engine: pick(speech.engine, (v) => typeof v === 'string' && SAFE_NAME.test(v)),
      keyterm_count: Array.isArray(keyterms) ? keyterms.length : 0,
      listen_id: pick(speech.listen_id, (v) => typeof v === 'string' && SAFE_ID.test(v))
    };
  }
  return out;
}

module.exports = {urlForLog, listenForLog};
