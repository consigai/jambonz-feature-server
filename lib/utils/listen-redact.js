/**
 * Log- and trace-safe views of a listen's url and options.
 *
 * A listen url can carry a signed query (a bearer token for the far end) and
 * metadata.speech.engine_options.keyterms can carry patient names. Use these at log and
 * trace call sites only; what is sent on the wire is never changed.
 */

/**
 * @param {*} url
 * @returns {*} the url without its query string, fragment or user:password; non-strings unchanged
 */
function redactUrl(url) {
  if (typeof url !== 'string') return url;
  let end = url.length;
  const q = url.indexOf('?');
  const h = url.indexOf('#');
  if (q !== -1) end = q;
  if (h !== -1 && h < end) end = h;
  return url.slice(0, end).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
}

/**
 * metadata.speech reduced to mode, engine, listen_id and a keyterm count
 */
function redactSpeech(speech) {
  if (!speech || typeof speech !== 'object') return speech;
  const keyterms = speech.engine_options?.keyterms;
  return {
    mode: speech.mode,
    engine: speech.engine,
    listen_id: speech.listen_id,
    keyterm_count: Array.isArray(keyterms) ? keyterms.length : 0
  };
}

/**
 * @param {object} opts - listen verb options (or a listen task's data, or a ws hook)
 * @returns {object} a shallow copy with url redacted, credentials replaced and metadata.speech reduced
 */
function redactListenOpts(opts) {
  if (!opts || typeof opts !== 'object') return opts;
  const out = {...opts};
  if ('url' in out) out.url = redactUrl(out.url);
  if (out.wsAuth) out.wsAuth = '[redacted]';
  if (out.auth) out.auth = '[redacted]';
  if (out.metadata && typeof out.metadata === 'object' && 'speech' in out.metadata) {
    out.metadata = {...out.metadata, speech: redactSpeech(out.metadata.speech)};
  }
  return out;
}

module.exports = {redactUrl, redactListenOpts};
