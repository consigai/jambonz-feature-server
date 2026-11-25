const test = require('tape');
const Emitter = require('events');
const {
  getSpeechMode, parseSpeechMessage, decideCut, appliedCut, isSpeechStarted,
  buildSpeechRelay, streamClosed, speechLogFields
} = require('../lib/utils/speech-events');
const {ListenEvents} = require('../lib/utils/constants.json');
const WsRequestor = require('../lib/utils/ws-requestor');
const makeTask = require('../lib/tasks/make_task');

const noop = () => {};

const ev = (event, extra = {}) => ({
  v: 1, kind: 'speech', event, call_id: 'c1', stream_id: 's1', seq: 7, epoch: 1, turn: 2,
  engine: 'deepgram_flux', t_audio_ms: 1200, t_sent_ms: 1795600000000, ...extra
});
const frame = (body) => ({type: 'json', data: body});

test('speech-events: getSpeechMode', (t) => {
  t.equal(getSpeechMode(undefined), null, 'no metadata');
  t.equal(getSpeechMode({}), null, 'no speech');
  t.equal(getSpeechMode({speech: 'drive'}), null, 'speech not an object');
  t.equal(getSpeechMode({speech: {}}), null, 'no mode');
  t.equal(getSpeechMode({speech: {mode: 'off'}}), null, 'off');
  t.equal(getSpeechMode({speech: {mode: 'DRIVE'}}), null, 'unknown mode');
  t.equal(getSpeechMode({speech: {mode: 'shadow'}}), 'shadow', 'shadow');
  t.equal(getSpeechMode({speech: {mode: 'drive', engine: 'x'}}), 'drive', 'drive');
  t.end();
});

test('speech-events: parseSpeechMessage', (t) => {
  const body = ev('turn_ended', {transcript: 'hello'});
  t.equal(parseSpeechMessage(frame(body)), body, 'returns the body object unchanged (same reference)');
  t.equal(parseSpeechMessage(undefined), null, 'undefined');
  t.equal(parseSpeechMessage(''), null, 'empty string (non-JSON body)');
  t.equal(parseSpeechMessage('{"type":"json"}'), null, 'string');
  t.equal(parseSpeechMessage([frame(body)]), null, 'array');
  t.equal(parseSpeechMessage({type: 'killAudio', data: body}), null, 'other type');
  t.equal(parseSpeechMessage({type: 'json'}), null, 'no data');
  t.equal(parseSpeechMessage({type: 'json', data: 'x'}), null, 'data not an object');
  t.equal(parseSpeechMessage({type: 'json', data: [body]}), null, 'data an array');
  t.equal(parseSpeechMessage(frame({...body, kind: 'beep'})), null, 'non-speech json ignored');
  t.equal(parseSpeechMessage(frame({...body, kind: undefined})), null, 'no kind ignored');
  t.equal(parseSpeechMessage(frame({...body, event: ''})), null, 'empty event');
  t.equal(parseSpeechMessage(frame({...body, event: 3})), null, 'non-string event');
  t.end();
});

test('speech-events: decideCut covers every branch', (t) => {
  t.deepEqual(decideCut({mode: 'shadow', botModeEnabled: true, usingWebsockets: true}),
    {kill: false, cut: {applied: false, reason: 'shadow'}}, 'shadow, bot mode on');
  t.deepEqual(decideCut({mode: 'shadow', botModeEnabled: false, usingWebsockets: true}),
    {kill: false, cut: {applied: false, reason: 'shadow'}}, 'shadow, bot mode off');
  t.deepEqual(decideCut({mode: 'drive', botModeEnabled: false, usingWebsockets: true}),
    {kill: false, cut: {applied: false, reason: 'bargein_off'}}, 'drive, bot mode off');
  t.deepEqual(decideCut({mode: 'drive', botModeEnabled: true, usingWebsockets: false}),
    {kill: false, cut: {applied: false, reason: 'not_websocket'}}, 'drive, not websocket');
  t.deepEqual(decideCut({mode: 'drive', botModeEnabled: true, usingWebsockets: true}),
    {kill: true, cut: undefined}, 'drive, bot mode on: kill');
  t.deepEqual(appliedCut({name: 'say', id: 'v9'}), {applied: true, task: 'say', verb_id: 'v9'}, 'with id');
  t.deepEqual(appliedCut({name: 'say'}), {applied: true, task: 'say', verb_id: null}, 'no id');
  t.deepEqual(appliedCut(null), {applied: true, task: null, verb_id: null}, 'no current task');
  t.ok(isSpeechStarted(ev('speech_started')), 'speech_started');
  t.notOk(isSpeechStarted(ev('turn_ended')), 'turn_ended');
  t.end();
});

test('speech-events: relay payload and stream_closed', (t) => {
  const body = ev('speech_started');
  const cut = {applied: false, reason: 'shadow'};
  t.deepEqual(buildSpeechRelay(body, cut, 5),
    {event: 'speech-event', speech: body, cut, fs_received_ms: 5}, 'with cut');
  const r = buildSpeechRelay(ev('turn_ended'), undefined, 6);
  t.notOk('cut' in r, 'no cut key when not speech_started');
  for (const reason of ['connect_failed', 'disconnected', 'task_ended']) {
    t.deepEqual(streamClosed(reason, 'sid'),
      {v: 1, kind: 'speech', event: 'stream_closed', reason, call_id: 'sid'}, `stream_closed ${reason}`);
  }
  t.equal(streamClosed('bogus', 'sid').reason, 'disconnected', 'unknown reason maps to disconnected');
  const sc = streamClosed('task_ended', 'sid');
  t.ok(!('stream_id' in sc) && !('seq' in sc) && !('epoch' in sc) && !('turn' in sc), 'no numbering fields');
  t.end();
});

test('speech-events: log fields never include the transcript', (t) => {
  const body = ev('turn_ended', {transcript: 'my secret answer', confidence: 0.9});
  const fields = speechLogFields(body);
  t.deepEqual(fields, {event: 'turn_ended', stream_id: 's1', turn: 2, epoch: 1, seq: 7},
    'only event, stream_id, turn, epoch, seq');
  t.notOk(JSON.stringify(fields).includes('secret'), 'no transcript text');
  t.end();
});

/* wiring in TaskListen, with a fake endpoint and call session (no FreeSWITCH) */

class FakeEp extends Emitter {
  constructor() {
    super();
    this.connected = true;
    this.customEvents = [];
  }
  addCustomEventListener(event, handler) {
    this.customEvents.push(event);
    this.removeListener(event, handler);
    this.on(event, handler);
  }
  removeCustomEventListener(event, handler) {
    if (handler) this.removeListener(event, handler);
    else this.removeAllListeners(event);
  }
  async forkAudioStop() {}
}

function makeCs(log, {botMode = true, notifyEvents = true, ws = true} = {}) {
  const requestor = Object.create(WsRequestor.prototype);
  requestor.request = (type, hook, params) => {
    log.push({type, params});
    return Promise.resolve();
  };
  const cs = {
    notifyEvents,
    requestor,
    callSid: 'call-sid-1',
    isBotModeEnabled: botMode,
    appIsUsingWebsockets: ws,
    currentTask: {name: 'say', id: 'say-1'},
    kill(onBackgroundGatherBargein) {
      log.push({kill: onBackgroundGatherBargein, current: this.currentTask && this.currentTask.name});
      this.currentTask = null;
    }
  };
  return cs;
}

function makeListen(metadata, cs) {
  const logger = {error: noop, info: noop, debug: noop};
  const data = {url: 'ws://127.0.0.1/x'};
  if (metadata) data.metadata = metadata;
  const task = makeTask(logger, {listen: data});
  const ep = new FakeEp();
  task.cs = cs;
  task.ep = ep;
  task._initListeners(ep);
  return {task, ep};
}

test('listen wiring: no metadata.speech registers no json listener', (t) => {
  for (const metadata of [undefined, {foo: 'bar'}, {speech: {mode: 'off'}}]) {
    const log = [];
    const {task, ep} = makeListen(metadata, makeCs(log));
    t.equal(task.speechMode, null, `speechMode null for ${JSON.stringify(metadata)}`);
    t.notOk(ep.customEvents.includes(ListenEvents.JsonMessage), 'no mod_audio_fork::json listener');
    t.equal(ep.listenerCount(ListenEvents.JsonMessage), 0, 'zero json handlers');
    ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started')));
    t.deepEqual(log, [], 'nothing killed, nothing sent');
  }
  t.end();
});

test('listen wiring: nested speech metadata reaches the task unchanged', (t) => {
  const speech = {mode: 'shadow', engine: 'deepgram_flux', engine_options: {keyterms: ['a "b"', 'c\\d']}};
  const {task} = makeListen({speech, label: 'x"y'}, makeCs([]));
  t.equal(task.metadata.speech, speech, 'same object reference');
  t.deepEqual(task.metadata.speech.engine_options.keyterms, ['a "b"', 'c\\d'], 'nested strings not escaped');
  t.equal(task.metadata.label, 'x\\"y', 'top-level strings are still escaped as before');
  t.end();
});

test('listen wiring: drive mode, bot mode on: kill then relay in the same tick', (t) => {
  const log = [];
  const {ep} = makeListen({speech: {mode: 'drive'}}, makeCs(log));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started')));
  t.equal(log.length, 2, 'kill and relay happened synchronously');
  t.deepEqual(log[0], {kill: true, current: 'say'}, 'cs.kill(true) first');
  t.equal(log[1].type, 'verb:status', 'verb:status');
  const p = log[1].params;
  t.equal(p.event, 'speech-event', 'event');
  t.deepEqual(p.cut, {applied: true, task: 'say', verb_id: 'say-1'}, 'cut names the killed task');
  t.equal(p.speech.event, 'speech_started', 'body relayed');
  t.equal(p.verb, 'listen', 'reported under the listen verb');
  t.equal(typeof p.fs_received_ms, 'number', 'fs_received_ms');
  t.end();
});

test('listen wiring: drive mode, bot mode off: no kill', (t) => {
  const log = [];
  const {ep} = makeListen({speech: {mode: 'drive'}}, makeCs(log, {botMode: false}));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started')));
  t.equal(log.length, 1, 'relay only');
  t.deepEqual(log[0].params.cut, {applied: false, reason: 'bargein_off'}, 'bargein_off');
  t.end();
});

test('listen wiring: shadow mode never kills; non speech_started has no cut', (t) => {
  const log = [];
  const {ep} = makeListen({speech: {mode: 'shadow'}}, makeCs(log));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started')));
  ep.emit(ListenEvents.JsonMessage, frame(ev('turn_ended', {transcript: 'hi'})));
  ep.emit(ListenEvents.JsonMessage, frame({kind: 'beep', event: 'x'}));
  ep.emit(ListenEvents.JsonMessage, 'not json');
  t.equal(log.length, 2, 'two relays, no kill, junk ignored');
  t.deepEqual(log[0].params.cut, {applied: false, reason: 'shadow'}, 'shadow cut');
  t.notOk('cut' in log[1].params, 'turn_ended has no cut');
  t.equal(log[1].params.speech.transcript, 'hi', 'body relayed unchanged');
  t.end();
});

test('listen wiring: notifyEvents off sends nothing (same gate as say statuses)', (t) => {
  const log = [];
  const {ep} = makeListen({speech: {mode: 'shadow'}}, makeCs(log, {notifyEvents: false}));
  ep.emit(ListenEvents.JsonMessage, frame(ev('turn_ended')));
  t.equal(log.length, 0, 'nothing sent');
  t.end();
});

test('listen wiring: disconnect relays one stream_closed (disconnected), not task_ended too', async(t) => {
  const log = [];
  const {task, ep} = makeListen({speech: {mode: 'drive'}}, makeCs(log));
  task.notifyTaskDone = noop;
  ep.emit(ListenEvents.Disconnect, '');
  ep.emit(ListenEvents.Disconnect, '');
  t.equal(log.length, 1, 'one relay');
  t.deepEqual(log[0].params.speech,
    {v: 1, kind: 'speech', event: 'stream_closed', reason: 'disconnected', call_id: 'call-sid-1'}, 'stream_closed');
  t.notOk('cut' in log[0].params, 'no cut');
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started')));
  t.equal(log.length, 1, 'events after kill started are ignored');
  await new Promise((resolve) => setImmediate(resolve));
  t.equal(ep.listenerCount(ListenEvents.JsonMessage), 0, 'json listener removed when kill completes');
  t.end();
});

test('listen wiring: disconnect without speech mode sends nothing', (t) => {
  const log = [];
  const {task, ep} = makeListen(undefined, makeCs(log));
  task.notifyTaskDone = noop;
  ep.emit(ListenEvents.Disconnect, '');
  t.equal(log.length, 0, 'nothing sent');
  t.end();
});

test('listen wiring: connect failure relays stream_closed connect_failed', (t) => {
  const log = [];
  const {task, ep} = makeListen({speech: {mode: 'shadow'}}, makeCs(log));
  task.notifyTaskDone = noop;
  ep.emit(ListenEvents.ConnectFailure, {reason: 'x'});
  t.equal(log.length, 1, 'one relay');
  t.equal(log[0].params.speech.reason, 'connect_failed', 'connect_failed');
  t.end();
});

test('listen wiring: nothing is relayed or cut after stream_closed was reported', (t) => {
  const log = [];
  const {task, ep} = makeListen({speech: {mode: 'drive'}}, makeCs(log));
  task.notifyTaskDone = noop;
  ep.emit(ListenEvents.ConnectFailure, {reason: 'x'});
  t.equal(log.length, 1, 'stream_closed relayed');
  ep.emit(ListenEvents.JsonMessage,
    {type: 'json', data: {v: 1, kind: 'speech', event: 'speech_started', stream_id: 's', seq: 9, epoch: 1, turn: 3}});
  t.equal(log.length, 1, 'a later speech event is neither relayed nor allowed to kill');
  t.end();
});

test('listen wiring: session kill relays stream_closed task_ended once', async(t) => {
  const log = [];
  const {task} = makeListen({speech: {mode: 'shadow'}}, makeCs(log));
  task.notifyTaskDone = noop;
  await task.kill(task.cs);
  await task.kill(task.cs);
  t.equal(log.length, 1, 'one relay');
  t.equal(log[0].params.speech.reason, 'task_ended', 'task_ended');
  t.end();
});

test('listen wiring: send failure is caught, never awaited', async(t) => {
  const log = [];
  const cs = makeCs(log);
  cs.requestor.request = () => Promise.reject(new Error('socket gone'));
  const {ep} = makeListen({speech: {mode: 'drive'}}, cs);
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started')));
  await new Promise((resolve) => setImmediate(resolve));
  t.deepEqual(log, [{kill: true, current: 'say'}], 'kill happened, rejected send did not throw');
  t.end();
});

test('listen wiring: no speech mode, kill and connect failure send nothing', async(t) => {
  const log = [];
  const {task, ep} = makeListen(undefined, makeCs(log));
  task.notifyTaskDone = noop;
  ep.emit(ListenEvents.ConnectFailure, {reason: 'x'});
  await task.kill(task.cs);
  t.equal(log.length, 0, 'nothing sent');
  t.end();
});
