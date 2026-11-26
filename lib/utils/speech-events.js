/**
 * Engine-neutral speech events relayed by a listen task (speech events contract v1, section 4).
 *
 * The far end of the listen websocket sends text frames {"type": "json", "data": {...event...}}.
 * mod_audio_fork fires them as mod_audio_fork::json with the whole message as the body.
 * Pure functions only: no FreeSWITCH, no call session.
 *
 * Only these fields of an event are ever read: kind, event, turn, epoch, seq
 * (and stream_id, for the debug log line only).
 */

const SPEECH_MODES = ['shadow', 'drive'];
const SPEECH_STARTED = 'speech_started';

/**
 * @param {object} metadata - the listen verb's free-form metadata
 * @returns {string|null} 'shadow' or 'drive'; null when absent, 'off' or anything else
 */
function getSpeechMode(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const speech = metadata.speech;
  if (!speech || typeof speech !== 'object') return null;
  return SPEECH_MODES.includes(speech.mode) ? speech.mode : null;
}

/**
 * @param {object} metadata - the listen verb's free-form metadata
 * @returns {string|undefined} metadata.speech.listen_id when it is a string (contract v1.6, section 11)
 */
function getListenId(metadata) {
  const id = metadata?.speech?.listen_id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * @param {*} msg - the argument of a mod_audio_fork::json event: the parsed message,
 *   or a string when the body was not JSON
 * @returns {object|null} the event body, unchanged, when it is a speech event; otherwise null
 */
function parseSpeechMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  if (msg.type !== 'json') return null;
  const body = msg.data;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (body.kind !== 'speech') return null;
  if (typeof body.event !== 'string' || body.event.length === 0) return null;
  return body;
}

/**
 * Decide whether a speech_started may stop the agent's audio.
 * @returns {{kill: boolean, cut: object|undefined}} when kill is true the caller kills
 *   and builds the cut with appliedCut()
 */
function decideCut({mode, botModeEnabled, usingWebsockets}) {
  if (mode !== 'drive') return {kill: false, cut: {applied: false, reason: 'shadow'}};
  if (!botModeEnabled) return {kill: false, cut: {applied: false, reason: 'bargein_off'}};
  /* same guard as the background gather's bargeIn-done handler in CallSession */
  if (!usingWebsockets) return {kill: false, cut: {applied: false, reason: 'not_websocket'}};
  return {kill: true, cut: undefined};
}

/**
 * @param {object|null} task - the task that was current when the session was killed
 */
function appliedCut(task) {
  return {
    applied: true,
    task: task ? task.name : null,
    verb_id: task && task.id !== undefined ? task.id : null
  };
}

function isSpeechStarted(body) {
  return body.event === SPEECH_STARTED;
}

/**
 * @param {string|undefined} listenId - from getListenId(); omitted from the payload when undefined
 * @returns {object} the verb status payload:
 *   {event: 'speech-event', speech, cut?, fs_received_ms, listen_id?}
 */
function buildSpeechRelay(body, cut, fsReceivedMs, listenId) {
  return {
    event: 'speech-event',
    speech: body,
    ...(cut && {cut}),
    fs_received_ms: fsReceivedMs,
    ...(typeof listenId === 'string' && {listen_id: listenId})
  };
}

const STREAM_CLOSED_REASONS = ['connect_failed', 'disconnected', 'task_ended'];

/**
 * The feature server's own event when the listen stream is lost or stopped (contract v1.1).
 * Carries no stream_id, seq, epoch or turn.
 * @param {string} reason - 'connect_failed' | 'disconnected' | 'task_ended'
 * @param {string} callId - the call sid
 */
function streamClosed(reason, callId) {
  return {
    v: 1,
    kind: 'speech',
    event: 'stream_closed',
    reason: STREAM_CLOSED_REASONS.includes(reason) ? reason : 'disconnected',
    call_id: callId
  };
}

/**
 * Fields that may be logged. Never the transcript.
 */
function speechLogFields(body) {
  return {event: body.event, stream_id: body.stream_id, turn: body.turn, epoch: body.epoch, seq: body.seq};
}

module.exports = {
  getSpeechMode,
  getListenId,
  parseSpeechMessage,
  decideCut,
  appliedCut,
  isSpeechStarted,
  buildSpeechRelay,
  streamClosed,
  speechLogFields
};
