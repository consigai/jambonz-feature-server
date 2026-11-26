/**
 * Engine-neutral speech events relayed by a listen task (speech events contract v1, section 4).
 *
 * The far end of the listen websocket sends text frames {"type": "json", "data": {...event...}}.
 * mod_audio_fork fires them as mod_audio_fork::json with the whole message as the body.
 * Pure functions only: no FreeSWITCH, no call session.
 *
 * Only these fields of an event are ever read: kind, event, turn, epoch, seq and stream_id
 * (stream_id scopes the admission guard and appears in the debug log line).
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

/**
 * Per-listen admission state for the cut decision. One object per listen task, created once;
 * admitSpeechEvent() only compares and assigns fields, so the hot path allocates nothing.
 */
function createAdmission() {
  return {streamId: undefined, lastSeq: null, lastStartedTurn: null, lastEndedTurn: null};
}

/* the cut reported for a speech_started that was not admitted: relayed, never a kill */
const NOT_ADMITTED_CUT = Object.freeze({applied: false, reason: 'not_admitted'});

/**
 * Admit an event before the cut decision (contract sections 3 and 5, applied in the feature server).
 * Within one stream_id: seq must be greater than the last admitted seq. A speech_started must name
 * a turn later than any turn that already started or ended. A new stream_id starts a fresh scope.
 * Rejected events change no state. The caller still relays them.
 * @param {object} state - from createAdmission()
 * @param {object} body - a speech event body from parseSpeechMessage()
 * @returns {boolean} true if admitted
 */
function admitSpeechEvent(state, body) {
  if (body.stream_id !== state.streamId) {
    state.streamId = body.stream_id;
    state.lastSeq = null;
    state.lastStartedTurn = null;
    state.lastEndedTurn = null;
  }
  const seq = body.seq;
  if (!Number.isInteger(seq) || (state.lastSeq !== null && seq <= state.lastSeq)) return false;
  const turn = body.turn;
  if (body.event === SPEECH_STARTED) {
    if (!Number.isInteger(turn)) return false;
    if (state.lastStartedTurn !== null && turn <= state.lastStartedTurn) return false;
    if (state.lastEndedTurn !== null && turn <= state.lastEndedTurn) return false;
    state.lastStartedTurn = turn;
  }
  else if (body.event === 'turn_ended' && Number.isInteger(turn) &&
    (state.lastEndedTurn === null || turn > state.lastEndedTurn)) {
    state.lastEndedTurn = turn;
  }
  state.lastSeq = seq;
  return true;
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
  createAdmission,
  admitSpeechEvent,
  NOT_ADMITTED_CUT,
  isSpeechStarted,
  buildSpeechRelay,
  streamClosed,
  speechLogFields
};
