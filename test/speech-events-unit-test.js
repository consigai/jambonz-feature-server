const test = require('tape');
const Emitter = require('events');
const {
  getSpeechMode, getListenId, parseSpeechMessage, decideCut, appliedCut, isSpeechStarted,
  buildSpeechRelay, streamClosed, speechLogFields, createAdmission, admitSpeechEvent
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

function makeCs(log, {botMode = true, notifyEvents = true, ws = true, sessionEp = false, ttsStream = false} = {}) {
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
    },
    isTtsStreamEnabled: ttsStream,
    clearTtsStream() { log.push({clearTtsStream: true}); }
  };
  if (sessionEp) {
    cs.ep = {
      connected: true,
      uuid: 'ep-uuid-1',
      api(cmd, arg) {
        log.push({api: cmd, arg});
        return Promise.resolve();
      }
    };
  }
  return cs;
}

function makeListen(metadata, cs, logger = {error: noop, info: noop, debug: noop}) {
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

test('listen wiring: drive mode, bot mode on: kill, relay, uuid_break, clear tts stream, in one tick', (t) => {
  const log = [];
  const {ep} = makeListen({speech: {mode: 'drive'}}, makeCs(log, {sessionEp: true, ttsStream: true}));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started')));
  t.equal(log.length, 4, 'all four happened synchronously');
  t.deepEqual(log[0], {kill: true, current: 'say'}, 'cs.kill(true) first');
  t.deepEqual(log[2], {api: 'uuid_break', arg: 'ep-uuid-1'}, 'then uuid_break on the session endpoint');
  t.deepEqual(log[3], {clearTtsStream: true}, 'then the background tts stream is cleared');
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

test('listen wiring: connect failure relays stream_closed connect_failed', async(t) => {
  const log = [];
  const {task, ep} = makeListen({speech: {mode: 'shadow'}}, makeCs(log));
  task.notifyTaskDone = noop;
  ep.emit(ListenEvents.ConnectFailure, {reason: 'x'});
  await new Promise((resolve) => setImmediate(resolve));
  t.equal(log.length, 1, 'one relay');
  t.equal(log[0].params.speech.reason, 'connect_failed', 'connect_failed');
  t.end();
});

test('listen wiring: nothing is relayed or cut after stream_closed was reported', async(t) => {
  const log = [];
  const {task, ep} = makeListen({speech: {mode: 'drive'}}, makeCs(log));
  task.notifyTaskDone = noop;
  const start = {type: 'json', data: {v: 1, kind: 'speech', event: 'speech_started', stream_id: 's', seq: 9,
    epoch: 1, turn: 3}};
  ep.emit(ListenEvents.ConnectFailure, {reason: 'x'});
  ep.emit(ListenEvents.JsonMessage, start);
  t.equal(log.length, 0, 'nothing relayed or cut while the fork is stopping');
  await new Promise((resolve) => setImmediate(resolve));
  t.equal(log.length, 1, 'stream_closed relayed');
  ep.emit(ListenEvents.JsonMessage, {...start, data: {...start.data, seq: 10, turn: 4}});
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

const kind = (e) => {
  if (e.kill !== undefined) return 'kill';
  return e.type || e.api || 'clear';
};

test('listen wiring: drive cut audio kill follows the gather: tts stream off, endpoint gone', (t) => {
  let log = [];
  let {ep} = makeListen({speech: {mode: 'drive'}}, makeCs(log, {sessionEp: true}));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started')));
  t.deepEqual(log.map(kind),
    ['kill', 'verb:status', 'uuid_break'], 'no tts stream: no clearTtsStream');

  log = [];
  const cs = makeCs(log, {sessionEp: true, ttsStream: true});
  cs.ep.connected = false;
  ({ep} = makeListen({speech: {mode: 'drive'}}, cs));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started')));
  t.deepEqual(log.map(kind),
    ['kill', 'verb:status'], 'endpoint not connected: no uuid_break, no clearTtsStream (same gate as the gather)');
  t.end();
});

test('listen wiring: no audio kill unless the cut applies', (t) => {
  for (const [mode, opts, reason] of [
    ['shadow', {}, 'shadow'],
    ['drive', {botMode: false}, 'bargein_off'],
    ['drive', {ws: false}, 'not_websocket']
  ]) {
    const log = [];
    const {ep} = makeListen({speech: {mode}}, makeCs(log, {sessionEp: true, ttsStream: true, ...opts}));
    ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started')));
    t.equal(log.length, 1, `${reason}: relay only`);
    t.equal(log[0].params.cut.reason, reason, reason);
  }
  t.end();
});

test('listen wiring: kill error still kills audio, as the gather path does', (t) => {
  const log = [];
  const cs = makeCs(log, {sessionEp: true, ttsStream: true});
  cs.kill = () => { throw new Error('boom'); };
  const {ep} = makeListen({speech: {mode: 'drive'}}, cs);
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started')));
  t.deepEqual(log[0].params.cut, {applied: false, reason: 'kill_error'}, 'kill_error relayed');
  t.deepEqual(log.slice(1), [{api: 'uuid_break', arg: 'ep-uuid-1'}, {clearTtsStream: true}], 'audio still killed');
  t.end();
});

test('listen wiring: uuid_break failure is caught', async(t) => {
  const log = [];
  const cs = makeCs(log, {sessionEp: true});
  cs.ep.api = () => Promise.reject(new Error('no such channel'));
  const {ep} = makeListen({speech: {mode: 'drive'}}, cs);
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started')));
  await new Promise((resolve) => setImmediate(resolve));
  t.equal(log.length, 2, 'kill and relay, rejection swallowed');
  t.end();
});

test('listen wiring: a second speech_started with nothing current kills again and reports task null', (t) => {
  const log = [];
  const {ep} = makeListen({speech: {mode: 'drive'}}, makeCs(log, {sessionEp: true}));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started', {turn: 2})));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started', {turn: 3, seq: 9})));
  t.equal(log.length, 6, 'each start: kill, relay, uuid_break');
  t.deepEqual(log[3], {kill: true, current: null}, 'second kill(true) runs with no current task');
  t.deepEqual(log[4].params.cut, {applied: true, task: null, verb_id: null}, 'cut names no task');
  t.end();
});

test('listen wiring: turn_interim is relayed with no cut, no kill, logged at debug only', (t) => {
  const log = [];
  const calls = {info: 0, debug: 0};
  const logger = {error: noop, info: () => calls.info++, debug: () => calls.debug++};
  const {ep} = makeListen({speech: {mode: 'drive'}}, makeCs(log, {sessionEp: true, ttsStream: true}), logger);
  calls.info = 0;
  calls.debug = 0;
  for (let i = 0; i < 4; i++) {
    ep.emit(ListenEvents.JsonMessage, frame(ev('turn_interim', {seq: 10 + i, transcript: 'so far'})));
  }
  t.equal(log.length, 4, 'four relays and nothing else');
  t.ok(log.every((e) => e.type === 'verb:status' && !('cut' in e.params)), 'no cut on turn_interim');
  t.equal(log[0].params.speech.transcript, 'so far', 'body relayed unchanged');
  t.equal(calls.info, 0, 'no info logs');
  t.equal(calls.debug, 4, 'one debug line each');
  t.end();
});

test('speech-events: listen_id', (t) => {
  t.equal(getListenId(undefined), undefined, 'no metadata');
  t.equal(getListenId({speech: {mode: 'drive'}}), undefined, 'absent');
  t.equal(getListenId({speech: {listen_id: 7}}), undefined, 'not a string');
  t.equal(getListenId({speech: 'x'}), undefined, 'speech not an object');
  t.equal(getListenId({speech: {listen_id: 'L-1'}}), 'L-1', 'string');
  const body = ev('turn_ended');
  t.equal(buildSpeechRelay(body, undefined, 1, 'L-1').listen_id, 'L-1', 'event relay carries it');
  t.notOk('listen_id' in buildSpeechRelay(body, undefined, 1, undefined), 'omitted when undefined');
  t.end();
});

test('listen wiring: listen_id on every relay, unchanged, all three stream_closed reasons', async(t) => {
  const id = 'abc "q" \\ 9';
  const meta = () => ({speech: {mode: 'drive', listen_id: id}});

  let log = [];
  let {task, ep} = makeListen(meta(), makeCs(log));
  t.equal(task.listenId, id, 'read once in the constructor, nested string not escaped');
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started')));
  ep.emit(ListenEvents.JsonMessage, frame(ev('turn_interim', {transcript: 'x'})));
  const relays = log.filter((e) => e.type === 'verb:status');
  t.equal(relays.length, 2, 'two relays');
  t.ok(relays.every((e) => e.params.listen_id === id), 'speech events carry listen_id');

  for (const [reason, fire] of [
    ['disconnected', (tk, e) => e.emit(ListenEvents.Disconnect, '')],
    ['connect_failed', (tk, e) => e.emit(ListenEvents.ConnectFailure, {reason: 'x'})],
    ['task_ended', (tk) => tk.kill(tk.cs)]
  ]) {
    log = [];
    ({task, ep} = makeListen(meta(), makeCs(log)));
    task.notifyTaskDone = noop;
    await fire(task, ep);
    await new Promise((resolve) => setImmediate(resolve));
    t.equal(log.length, 1, `${reason}: one relay`);
    t.equal(log[0].params.speech.reason, reason, reason);
    t.equal(log[0].params.listen_id, id, `${reason}: carries listen_id`);
  }

  log = [];
  ({task, ep} = makeListen({speech: {mode: 'drive'}}, makeCs(log)));
  ep.emit(ListenEvents.JsonMessage, frame(ev('turn_ended')));
  await task.kill(task.cs);
  t.equal(log.length, 2, 'event and stream_closed');
  t.ok(log.every((e) => !('listen_id' in e.params)), 'omitted when the metadata has none');
  t.end();
});

test('listen wiring: task_ended is relayed only after forkAudioStop completes and listeners are removed', async(t) => {
  const log = [];
  const {task, ep} = makeListen({speech: {mode: 'shadow', listen_id: 'L'}}, makeCs(log));
  task.notifyTaskDone = noop;
  const pending = [];
  ep.forkAudioStop = () => new Promise((resolve) => pending.push(resolve));
  const done = task.kill(task.cs);
  ep.emit(ListenEvents.JsonMessage, frame(ev('turn_ended')));
  ep.emit(ListenEvents.Disconnect, '');
  await new Promise((resolve) => setImmediate(resolve));
  t.equal(log.length, 0, 'nothing relayed while the fork is stopping');
  pending.forEach((resolve) => resolve());
  await done;
  await new Promise((resolve) => setImmediate(resolve));
  t.equal(log.length, 1, 'one relay after the stop');
  t.equal(log[0].params.speech.reason, 'task_ended', 'task_ended');
  t.equal(ep.listenerCount(ListenEvents.Disconnect), 0, 'listeners were removed before it was sent');
  t.end();
});

/* Fix 1: log and trace views of a listen's url and options */
const {urlForLog, listenForLog} = require('../lib/utils/listen-redact');

test('listen-redact: urlForLog keeps scheme, host and first path segment only', (t) => {
  t.equal(urlForLog('wss://a.example/stream?cid=c1&exp=1&sig=SECRET'), 'wss://a.example/stream', 'query dropped');
  t.equal(urlForLog('wss://a.example/s#frag?x'), 'wss://a.example/s', 'fragment dropped');
  t.equal(urlForLog('wss://user:pw@a.example/s?sig=1'), 'wss://a.example/s', 'userinfo dropped');
  t.equal(urlForLog('wss://a.example/v1/record/aws_s3'), 'wss://a.example/v1/…', 'deeper path not logged');
  t.equal(urlForLog('wss://a.example/calls/+15551234567/x'), 'wss://a.example/calls/…', 'identifier in path dropped');
  t.equal(urlForLog('wss://a.example'), 'wss://a.example', 'host only');
  t.equal(urlForLog('/relative/+15551234567?sig=1'), '/relative/…', 'relative url');
  t.equal(urlForLog('not a url'), '[url]', 'unrecognised');
  t.equal(urlForLog(undefined), undefined, 'non-string');
  t.end();
});

test('listen-redact: listenForLog is an allowlist and never mutates', (t) => {
  const opts = {
    url: 'wss://a.example/stream/+15551234567?cid=c1&sig=SECRET',
    wsAuth: {username: 'u', password: 'PW'},
    mixType: 'stereo', sampleRate: 8000, disableBidirectionalAudio: true, patient_phone: '+15551234567',
    metadata: {
      call_id: 'c1', patient_phone: '+15551234567', from: '+15550000000',
      speech: {mode: 'drive', engine: 'deepgram_flux', listen_id: 'L-1_a', language: 'en-US', interim: true,
        engine_options: {eot_threshold: 0.7, keyterms: ['Jane Patient', 'Lisinopril']}}
    }
  };
  const before = JSON.stringify(opts);
  const out = listenForLog(opts, 'jambonz-background-listen');
  t.equal(JSON.stringify(opts), before, 'input not mutated (the wire is unchanged)');
  t.deepEqual(out, {
    url: 'wss://a.example/stream/…', mixType: 'stereo', sampleRate: 8000, bugname: 'jambonz-background-listen',
    auth: true, speech: {mode: 'drive', engine: 'deepgram_flux', keyterm_count: 2, listen_id: 'L-1_a'}
  }, 'only the allowlisted fields');
  const str = JSON.stringify(out);
  t.notOk(['SECRET', 'Jane', 'PW', '555'].some((x) => str.includes(x)), 'no token, keyterm, password or number');
  t.equal(listenForLog({metadata: {speech: {listen_id: 'has space or +1555'}}}).speech.listen_id, '[invalid]',
    'listen_id outside the pattern is replaced');
  t.equal(listenForLog({metadata: {speech: {listen_id: 'x'.repeat(65)}}}).speech.listen_id, '[invalid]', 'too long');
  t.equal(listenForLog({mixType: '+1555'}).mixType, '[invalid]', 'unexpected values replaced');
  t.notOk('speech' in listenForLog({url: 'ws://x/y', metadata: {a: 1}}), 'no speech, no speech field');
  t.equal(listenForLog({metadata: {speech: {mode: 'shadow'}}}).speech.keyterm_count, 0, 'no keyterms');
  t.deepEqual(listenForLog(undefined), {}, 'undefined');
  t.end();
});

test('listen-redact: config summary (span name) has no signed query', (t) => {
  const task = makeTask({error: noop, info: noop, debug: noop},
    {config: {listen: {enable: true, url: 'wss://a.example/stream?cid=c1&sig=SECRET'}}});
  t.ok(task.summary.includes('listen wss://a.example/stream'), 'url path kept');
  t.notOk(task.summary.includes('SECRET') || task.summary.includes('?'), 'query dropped');
  t.end();
});

test('listen-redact: exec error log line has no signed query', async(t) => {
  const lines = [];
  const logger = {error: noop, debug: noop, info: (a, b) => lines.push(JSON.stringify([a && a.message, b]))};
  const task = makeTask(logger, {listen: {url: 'wss://a.example/stream?sig=SECRET'}});
  const cs = makeCs([]);
  cs.normalizeUrl = () => { throw new Error('boom'); };
  task.notifyTaskDone = noop;
  await task.exec(cs, {ep: new FakeEp()});
  t.ok(lines.some((l) => l.includes('TaskListen:exec - error wss://a.example/stream')), 'error logged');
  t.notOk(lines.some((l) => l.includes('SECRET')), 'no token');
  t.end();
});

/* Fix 2: admission before the cut */
const cutOf = (log) => log.filter((e) => e.type === 'verb:status').map((e) => e.params.cut);
const kills = (log) => log.filter((e) => e.kill !== undefined).length;

test('speech-events: admitSpeechEvent rules', (t) => {
  const st = createAdmission();
  t.ok(admitSpeechEvent(st, ev('source_ready', {seq: 1, turn: undefined})), 'first event');
  t.notOk(admitSpeechEvent(st, ev('heartbeat', {seq: 1})), 'same seq rejected');
  t.notOk(admitSpeechEvent(st, ev('heartbeat', {seq: 0})), 'lower seq rejected');
  t.notOk(admitSpeechEvent(st, ev('heartbeat', {seq: '3'})), 'non-integer seq rejected');
  t.ok(admitSpeechEvent(st, ev('speech_started', {seq: 3, turn: 0})), 'start turn 0, gap allowed');
  t.notOk(admitSpeechEvent(st, ev('speech_started', {seq: 4, turn: 0})), 'second start for turn 0');
  t.ok(admitSpeechEvent(st, ev('turn_ended', {seq: 5, turn: 0})), 'end turn 0');
  t.notOk(admitSpeechEvent(st, ev('speech_started', {seq: 6, turn: undefined})), 'start without a turn');
  t.ok(admitSpeechEvent(st, ev('speech_started', {seq: 7, turn: 1})), 'start turn 1');
  t.deepEqual(st, {seen: true, streamId: 's1', lastSeq: 7, lastStartedTurn: 1, lastEndedTurn: 0, retired: []},
    'rejections changed nothing');
  t.ok(admitSpeechEvent(st, ev('speech_started', {stream_id: 's2', seq: 1, turn: 0})), 'new stream: fresh scope');
  t.end();
});

test('listen admission: duplicate speech_started is relayed with not_admitted and no kill', (t) => {
  const log = [];
  const {ep} = makeListen({speech: {mode: 'drive'}}, makeCs(log, {sessionEp: true}));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started', {seq: 1, turn: 0})));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started', {seq: 1, turn: 0})));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started', {seq: 2, turn: 0})));
  t.equal(kills(log), 1, 'one kill');
  t.equal(log.filter((e) => e.api === 'uuid_break').length, 1, 'one audio kill');
  t.deepEqual(cutOf(log), [
    {applied: true, task: 'say', verb_id: 'say-1'},
    {applied: false, reason: 'not_admitted'},
    {applied: false, reason: 'not_admitted'}
  ], 'repeats relayed as not_admitted');
  t.end();
});

test('listen admission: reordered start after its turn ended is not a cut', (t) => {
  const log = [];
  const {ep} = makeListen({speech: {mode: 'drive'}}, makeCs(log, {sessionEp: true}));
  ep.emit(ListenEvents.JsonMessage, frame(ev('turn_ended', {seq: 4, turn: 3})));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started', {seq: 5, turn: 3})));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started', {seq: 6, turn: 2})));
  t.equal(kills(log), 0, 'no kill');
  const na = {applied: false, reason: 'not_admitted'};
  t.deepEqual(cutOf(log), [undefined, na, na], 'both starts relayed, not admitted');
  t.end();
});

test('listen admission: a normal sequence is unchanged', (t) => {
  const log = [];
  const {ep} = makeListen({speech: {mode: 'drive'}}, makeCs(log, {sessionEp: true}));
  const seqd = [
    ['source_ready', {turn: undefined}], ['speech_started', {turn: 0}], ['turn_interim', {turn: 0}],
    ['turn_end_likely', {turn: 0}], ['turn_resumed', {turn: 0}], ['turn_ended', {turn: 0}],
    ['heartbeat', {turn: undefined}], ['speech_started', {turn: 1}], ['source_down', {turn: undefined}],
    ['source_up', {turn: undefined, epoch: 2}], ['speech_started', {turn: 2}], ['turn_ended', {turn: 2}]
  ];
  seqd.forEach(([name, extra], i) => ep.emit(ListenEvents.JsonMessage, frame(ev(name, {seq: i + 1, ...extra}))));
  t.equal(kills(log), 3, 'every start cuts');
  t.equal(log.filter((e) => e.type === 'verb:status').length, seqd.length, 'every event relayed');
  t.ok(cutOf(log).filter(Boolean).every((c) => c.applied === true), 'every cut applied');
  t.end();
});

test('listen admission: a new stream_id on the same socket starts a fresh scope', (t) => {
  const log = [];
  const {ep} = makeListen({speech: {mode: 'drive'}}, makeCs(log, {sessionEp: true}));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started', {stream_id: 'a', seq: 9, turn: 5})));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started', {stream_id: 'b', seq: 1, turn: 0})));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started', {stream_id: 'b', seq: 1, turn: 0})));
  t.equal(kills(log), 2, 'first start of each stream cuts');
  t.deepEqual(cutOf(log)[2], {applied: false, reason: 'not_admitted'}, 'repeat within b rejected');
  t.end();
});

test('listen admission: shadow mode reports shadow for a start it does not admit', (t) => {
  const log = [];
  const {ep} = makeListen({speech: {mode: 'shadow'}}, makeCs(log));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started', {seq: 1, turn: 0})));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started', {seq: 2, turn: 0})));
  t.deepEqual(cutOf(log), [{applied: false, reason: 'shadow'}, {applied: false, reason: 'shadow'}],
    'shadow never cuts and reports shadow');
  t.end();
});

/*
 * Fix 3: a listen's cleanup removes only its own handlers. Uses drachtio-fsmrf's real
 * add/removeCustomEventListener and _onCustomEvent, with no FreeSWITCH connection:
 * mod_audio_fork events carry no bugname, so every listen on the endpoint receives them.
 */
const Endpoint = require('drachtio-fsmrf/lib/endpoint');

function realEp() {
  const ep = Object.create(Endpoint.prototype);
  Emitter.call(ep);
  ep._customEvents = [];
  ep._conn = {subscribe: noop};
  Object.defineProperty(ep, 'connected', {value: true});
  ep.forkAudioStop = async() => {};
  /* what FreeSWITCH sends: Event-Subclass only, body optional */
  ep.fire = (name, body) => ep._onCustomEvent({
    getHeader: () => name,
    getBody: () => (body === undefined ? '' : JSON.stringify(body))
  });
  return ep;
}

function startListen(ep, data, cs, bugname) {
  const task = makeTask({error: noop, info: noop, debug: noop}, {listen: data});
  task.bugname = bugname;
  task.cs = cs;
  task.ep = ep;
  task._dtmfHandler = task._onDtmf.bind(task, ep);
  task._initListeners(ep);
  return task;
}

const RECORD = {url: 'wss://rec.example/record/aws_s3', disableBidirectionalAudio: true, mixType: 'stereo',
  passDtmf: true};
const SPEECH = (id) => ({url: 'wss://a.example/stream', disableBidirectionalAudio: true,
  metadata: {speech: {mode: 'drive', listen_id: id}}});
const FORK_EVENTS = ['Connect', 'ConnectFailure', 'Error', 'KillAudio', 'Disconnect'].map((k) => ListenEvents[k]);
const owns = (ep, task) => FORK_EVENTS.every((e) =>
  ep.listeners(e).some((h) => task._epHandlers.some(([ev, mine]) => ev === e && mine === h)));

test('listen cleanup: killing the speech listen leaves the recording fork\'s handlers in place', async(t) => {
  const ep = realEp();
  const cs = makeCs([]);
  const record = startListen(ep, RECORD, cs, 'jambonz-session-record');
  const speech = startListen(ep, SPEECH('L1'), cs, 'jambonz-background-listen');
  speech.notifyTaskDone = noop;
  await speech.kill(cs);
  t.ok(owns(ep, record), 'record keeps connect, connect_failed, error, kill_audio, disconnect');
  t.equal(ep.listenerCount('dtmf'), 1, 'record keeps its dtmf handler');
  t.notOk(owns(ep, speech), 'speech handlers gone');
  t.equal(ep.listenerCount(ListenEvents.JsonMessage), 0, 'speech json handler gone');
  t.end();
});

test('listen cleanup: a failed listen (exec error path) leaves the other fork\'s handlers in place', (t) => {
  const ep = realEp();
  const cs = makeCs([]);
  const record = startListen(ep, RECORD, cs, 'jambonz-session-record');
  const speech = startListen(ep, SPEECH('L1'), cs, 'jambonz-background-listen');
  record._removeListeners(ep);
  t.ok(owns(ep, speech), 'speech keeps its handlers when the recording task cleans up');
  t.equal(ep.listenerCount(ListenEvents.JsonMessage), 1, 'speech events still delivered');
  t.end();
});

test('listen cleanup: restart, the old listen\'s late cleanup leaves the new listen\'s handlers', async(t) => {
  const ep = realEp();
  const log = [];
  const cs = makeCs(log);
  const record = startListen(ep, RECORD, cs, 'jambonz-session-record');
  const old = startListen(ep, SPEECH('L1'), cs, 'jambonz-background-listen');
  old.notifyTaskDone = noop;
  let release;
  ep.forkAudioStop = () => new Promise((resolve) => { release = resolve; });
  const stopping = old.kill(cs);
  const fresh = startListen(ep, SPEECH('L2'), cs, 'jambonz-background-listen');
  ep.forkAudioStop = async() => {};
  release();
  await stopping;
  t.ok(owns(ep, fresh), 'new speech listen keeps its handlers');
  t.ok(owns(ep, record), 'recording keeps its handlers');
  ep.fire(ListenEvents.JsonMessage, frame(ev('turn_ended', {seq: 1})));
  const relays = log.filter((e) => e.type === 'verb:status' && e.params.speech.event === 'turn_ended');
  t.deepEqual(relays.map((e) => e.params.listen_id), ['L2'], 'only the new listen relays');
  t.end();
});

/*
 * Fix 4: fork events a listen cannot attribute. Real tasks run through the real
 * BackgroundTaskManager on the fsmrf-backed endpoint stub (no FreeSWITCH).
 */
const BackgroundTaskManager = require('../lib/utils/background-task-manager');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeCall(log = []) {
  const ep = realEp();
  ep.stopped = [];
  ep.started = [];
  ep.set = async() => {};
  ep.forkAudioStart = async(o) => { ep.started.push(o.bugname); };
  ep.forkAudioStop = async(bugname) => { ep.stopped.push(bugname); };
  const cs = makeCs(log);
  cs.normalizeUrl = (url, method, auth) => ({url, method, ...(auth && {auth})});
  cs.callInfo = {toJSON: () => ({callSid: 'call-sid-1'})};
  cs._evaluatePreconditions = async() => ({ep});
  const span = {end: noop, setAttributes: noop};
  const mgr = new BackgroundTaskManager({cs, logger: {error: noop, info: noop, debug: noop},
    rootSpan: {startChildSpan: () => ({span, ctx: {}})}});
  /* record as _initRecord starts it, without the account and env lookups */
  mgr._initRecord = () => mgr._initListen({verb: 'listen', ...RECORD}, 'jambonz-session-record', true, 'record');
  cs.backgroundTaskManager = mgr;
  return {ep, cs, mgr, log};
}
const startSpeech = (mgr, id) => mgr.newTask('listen', {verb: 'listen', ...SPEECH(id)});
const closed = (log) => log.filter((e) => e.type === 'verb:status' && e.params.speech.event === 'stream_closed')
  .map((e) => `${e.params.listen_id}:${e.params.speech.reason}`);

test('fork events (1): record + speech, far-end disconnect: record keeps running, speech relays', async(t) => {
  const {ep, mgr, log} = makeCall();
  const record = await mgr.newTask('record');
  await startSpeech(mgr, 'L1');
  await tick();
  ep.fire(ListenEvents.Connect);
  ep.fire(ListenEvents.Connect);
  ep.fire(ListenEvents.Disconnect);
  await tick();
  t.deepEqual(ep.stopped, ['jambonz-background-listen'], 'only the speech fork is stopped');
  t.deepEqual(closed(log), ['L1:disconnected'], 'speech relays stream_closed disconnected');
  t.equal(mgr.getTask('record'), record, 'record still tracked');
  t.notOk(mgr.isTaskRunning('listen'), 'speech listen gone');
  t.ok(owns(ep, record), 'record keeps its handlers');
  t.end();
});

test('fork events (2): record alone, disconnect: record stops as today', async(t) => {
  const {ep, mgr} = makeCall();
  await mgr.newTask('record');
  await tick();
  ep.fire(ListenEvents.Connect);
  ep.fire(ListenEvents.Disconnect);
  await tick();
  t.deepEqual(ep.stopped, ['jambonz-session-record'], 'record fork stopped');
  t.notOk(mgr.isTaskRunning('record'), 'record task completed');
  t.end();
});

test('fork events: record alone, error and connect_failed: as today', async(t) => {
  for (const ev of [ListenEvents.Error, ListenEvents.ConnectFailure]) {
    const {ep, mgr} = makeCall();
    await mgr.newTask('record');
    await tick();
    ep.fire(ListenEvents.Connect);
    ep.fire(ev, {reason: 'x'});
    await tick();
    t.notOk(mgr.isTaskRunning('record'), `${ev}: record task done, as before`);
  }
  t.end();
});

test('fork events (3): record connected, speech connect_failed: record unaffected and tracked', async(t) => {
  const {ep, mgr, log} = makeCall();
  const record = await mgr.newTask('record');
  await tick();
  ep.fire(ListenEvents.Connect);
  await startSpeech(mgr, 'L1');
  await tick();
  ep.fire(ListenEvents.ConnectFailure, {reason: 'refused'});
  await tick();
  t.equal(mgr.getTask('record'), record, 'record still tracked');
  t.ok(owns(ep, record), 'record keeps its handlers');
  t.deepEqual(closed(log), ['L1:connect_failed'], 'speech reports its own failure');
  t.notOk(mgr.isTaskRunning('listen'), 'speech listen done');
  t.end();
});

test('fork events: record + speech, analyzer error message: record ignores it, speech acts', async(t) => {
  const {ep, mgr, log} = makeCall();
  const record = await mgr.newTask('record');
  await startSpeech(mgr, 'L1');
  await tick();
  ep.fire(ListenEvents.Error, {error: 'x'});
  await tick();
  t.equal(mgr.getTask('record'), record, 'record still tracked');
  t.deepEqual(closed(log), ['L1:disconnected'], 'speech relays');
  t.end();
});

test('fork events: beep-only listen + record, disconnect: both act as today', async(t) => {
  const {ep, mgr} = makeCall();
  await mgr.newTask('record');
  await mgr.newTask('listen', {verb: 'listen', url: 'wss://a.example/stream', metadata: {beep_source: 'avmd'}});
  await tick();
  ep.fire(ListenEvents.Disconnect);
  await tick();
  t.deepEqual(ep.stopped, ['jambonz-background-listen'], 'beep listen stops; record ignores it');
  t.end();
});

test('fork events (4): speech restart with record active keeps record handlers', async(t) => {
  const {ep, mgr, log} = makeCall();
  const record = await mgr.newTask('record');
  await startSpeech(mgr, 'L1');
  await tick();
  t.ok(owns(ep, record), 'before');
  mgr.stop('listen');
  await startSpeech(mgr, 'L2');
  await tick();
  t.ok(owns(ep, record), 'after');
  t.equal(mgr.getTask('record'), record, 'record still tracked');
  t.deepEqual(ep.started, ['jambonz-session-record', 'jambonz-background-listen', 'jambonz-background-listen'],
    'record once, speech twice');
  ep.fire(ListenEvents.Disconnect);
  await tick();
  t.deepEqual(ep.stopped, ['jambonz-background-listen', 'jambonz-background-listen'],
    'the stop, then the new listen on the far-end close; never the record');
  t.ok(closed(log).includes('L2:disconnected'), 'new listen relays its close');
  t.end();
});

test('fork events (5): call end stops both', async(t) => {
  const {ep, mgr} = makeCall();
  await mgr.newTask('record');
  await startSpeech(mgr, 'L1');
  await tick();
  mgr.stopAll();
  await tick();
  t.deepEqual(ep.stopped.sort(), ['jambonz-background-listen', 'jambonz-session-record'], 'both forks stopped');
  t.equal(mgr.count(), 0, 'nothing tracked');
  t.equal(ep.listenerCount(ListenEvents.Disconnect), 0, 'no handlers left');
  t.end();
});

/* Fix 5: concurrent starts of one background task type collapse to one */
test('background starts: concurrent record starts (account + forced) make one task, one fork', async(t) => {
  const {ep, mgr} = makeCall();
  const [a, b] = await Promise.all([mgr.newTask('record'), mgr.newTask('record', {force: true})]);
  await tick();
  t.ok(a && a === b, 'both callers get the one task');
  t.equal(mgr.getTask('record'), a, 'tracked');
  t.deepEqual(ep.started, ['jambonz-session-record'], 'one fork start, no duplicate bug');
  t.equal(mgr.starting.size, 0, 'nothing left starting');
  t.end();
});

test('background starts: a failed duplicate cannot untrack the live task', async(t) => {
  const {mgr} = makeCall();
  const live = await mgr.newTask('record');
  const dup = {removeAllListeners: noop, span: {end: noop}};
  mgr._taskCompleted('record', dup);
  mgr._taskError('record', dup, new Error('-ERR Operation Failed'));
  t.equal(mgr.getTask('record'), live, 'live task still tracked');
  t.end();
});

test('background starts: a start that yields nothing lets the waiting (forced) start run', async(t) => {
  const {ep, mgr} = makeCall();
  const real = mgr._initRecord;
  mgr._initRecord = async(force) => {
    await tick();
    return force ? real() : undefined;
  };
  const [a, b] = await Promise.all([mgr.newTask('record'), mgr.newTask('record', {force: true})]);
  await tick();
  t.equal(a, undefined, 'unforced start without the account flag: nothing');
  t.ok(b && mgr.getTask('record') === b, 'forced start ran and is tracked');
  t.deepEqual(ep.started, ['jambonz-session-record'], 'one fork');
  t.end();
});

test('background starts: stop during a start cancels it; the next start is a genuine replacement', async(t) => {
  const {ep, mgr} = makeCall();
  const first = startSpeech(mgr, 'L1');
  mgr.stop('listen');
  const second = startSpeech(mgr, 'L2');
  const [a, b] = await Promise.all([first, second]);
  await tick();
  t.equal(a, undefined, 'cancelled start returns nothing');
  t.ok(b && mgr.getTask('listen') === b && b.listenId === 'L2', 'the replacement is tracked');
  t.ok(ep.stopped.includes('jambonz-background-listen'), 'the cancelled listen was stopped');
  t.end();
});

test('background starts: the old listen completing late does not untrack its replacement', async(t) => {
  const {ep, mgr} = makeCall();
  await startSpeech(mgr, 'L1');
  let release;
  ep.forkAudioStop = () => new Promise((resolve) => { release = resolve; });
  mgr.stop('listen');
  await tick();
  ep.forkAudioStop = async() => {};
  const starting = startSpeech(mgr, 'L2');
  release();
  const fresh = await starting;
  await tick();
  await tick();
  t.equal(mgr.getTask('listen'), fresh, 'replacement still tracked');
  t.end();
});

/* Fix 6: a speech listen that fails stops its own fork so the next start can attach */
function attachRule(ep) {
  /* mod_audio_fork: one bug per bugname per channel */
  ep.attached = new Set();
  ep.calls = [];
  ep.forkAudioStart = async(o) => {
    ep.calls.push(`start:${o.bugname}`);
    if (ep.attached.has(o.bugname)) throw new Error('-ERR Operation Failed');
    ep.attached.add(o.bugname);
  };
  ep.forkAudioStop = async(bugname) => {
    ep.calls.push(`stop:${bugname}`);
    if (!ep.attached.delete(bugname)) throw new Error('-ERR no bug');
  };
}

test('fork failure: speech connect_failed stops its fork; the next start attaches', async(t) => {
  const {ep, mgr, log} = makeCall();
  attachRule(ep);
  const first = await startSpeech(mgr, 'L1');
  await tick();
  ep.fire(ListenEvents.ConnectFailure, {reason: 'HS: ws upgrade response not 101'});
  await tick();
  await tick();
  t.notOk(mgr.isTaskRunning('listen'), 'first listen done');
  t.notOk(ep.attached.has('jambonz-background-listen'), 'its bug was removed');
  const second = await startSpeech(mgr, 'L2');
  await tick();
  t.ok(second && second !== first && mgr.getTask('listen') === second, 'second listen tracked');
  t.ok(ep.attached.has('jambonz-background-listen'), 'second start attached');
  t.deepEqual(closed(log), ['L1:connect_failed'], 'only the first failure reported');
  t.end();
});

test('fork failure: stream_closed is relayed after the stop completes', async(t) => {
  const {ep, mgr, log} = makeCall();
  attachRule(ep);
  await startSpeech(mgr, 'L1');
  await tick();
  let release;
  const stop = ep.forkAudioStop;
  ep.forkAudioStop = (b) => new Promise((resolve) => { release = () => resolve(stop(b)); });
  ep.fire(ListenEvents.ConnectFailure, {reason: 'x'});
  await tick();
  t.deepEqual(closed(log), [], 'nothing relayed while stopping');
  t.ok(mgr.isTaskRunning('listen'), 'not completed while stopping');
  release();
  await tick();
  await tick();
  t.deepEqual(closed(log), ['L1:connect_failed'], 'relayed after the stop');
  t.notOk(mgr.isTaskRunning('listen'), 'then completed');
  t.end();
});

test('fork failure: speech error stops its fork before stream_closed', async(t) => {
  const {ep, mgr, log} = makeCall();
  attachRule(ep);
  await startSpeech(mgr, 'L1');
  await tick();
  ep.fire(ListenEvents.Error, {error: 'x'});
  await tick();
  await tick();
  t.notOk(ep.attached.has('jambonz-background-listen'), 'bug removed');
  t.deepEqual(closed(log), ['L1:disconnected'], 'relayed');
  t.end();
});

test('fork failure: exec failure (already attached) stops the leftover bug; the retry attaches', async(t) => {
  const {ep, mgr, log} = makeCall();
  attachRule(ep);
  ep.attached.add('jambonz-background-listen');
  await startSpeech(mgr, 'L1');
  await tick();
  await tick();
  t.deepEqual(closed(log), ['L1:connect_failed'], 'start failure reported');
  t.notOk(ep.attached.has('jambonz-background-listen'), 'leftover bug removed');
  await startSpeech(mgr, 'L2');
  await tick();
  t.ok(ep.attached.has('jambonz-background-listen') && mgr.isTaskRunning('listen'), 'retry attached');
  t.end();
});

test('fork failure: stop error on a bug that never attached is swallowed', async(t) => {
  const {ep, mgr, log} = makeCall();
  attachRule(ep);
  await startSpeech(mgr, 'L1');
  await tick();
  ep.attached.clear();
  ep.fire(ListenEvents.ConnectFailure, {reason: 'x'});
  await tick();
  await tick();
  t.deepEqual(closed(log), ['L1:connect_failed'], 'still relayed');
  t.notOk(mgr.isTaskRunning('listen'), 'completed');
  t.end();
});

test('fork failure: record listen and non-speech listen do not stop their fork (unchanged)', async(t) => {
  for (const [type, opts, bug] of [
    ['record', undefined, 'jambonz-session-record'],
    ['listen', {verb: 'listen', url: 'wss://a.example/stream', metadata: {beep_source: 'avmd'}},
      'jambonz-background-listen']
  ]) {
    for (const ev of [ListenEvents.ConnectFailure, ListenEvents.Error]) {
      const {ep, mgr} = makeCall();
      attachRule(ep);
      await mgr.newTask(type, opts);
      await tick();
      ep.fire(ev, {reason: 'x'});
      await tick();
      await tick();
      t.notOk(mgr.isTaskRunning(type), `${bug} ${ev}: task done as before`);
      t.ok(ep.attached.has(bug), `${bug} ${ev}: fork not stopped, as before`);
    }
  }
  t.end();
});

test('fork failure: speech connect_failed with record active never stops the record fork', async(t) => {
  const {ep, mgr} = makeCall();
  attachRule(ep);
  const record = await mgr.newTask('record');
  await tick();
  ep.fire(ListenEvents.Connect);
  await startSpeech(mgr, 'L1');
  await tick();
  ep.fire(ListenEvents.ConnectFailure, {reason: 'x'});
  await tick();
  await tick();
  t.ok(ep.attached.has('jambonz-session-record'), 'record bug attached');
  t.notOk(ep.calls.includes('stop:jambonz-session-record'), 'record never stopped');
  t.equal(mgr.getTask('record'), record, 'record tracked');
  t.end();
});

/* Review finding 4: stops are bounded; completion and cleanup never wait on a stuck stop */
test('bounded stop: a stop that never settles still completes kill within the bound', async(t) => {
  const log = [];
  const {task, ep} = makeListen({speech: {mode: 'drive', listen_id: 'L'}}, makeCs(log));
  let done = false;
  task.notifyTaskDone = () => { done = true; };
  ep.forkAudioStop = () => new Promise(noop);
  const began = Date.now();
  await task.kill(task.cs);
  const took = Date.now() - began;
  t.ok(took >= 900 && took < 2000, `kill returned after the bound (${took} ms)`);
  t.ok(done, 'task completed');
  t.equal(ep.listenerCount(ListenEvents.Disconnect), 0, 'handlers removed');
  t.equal(log[0].params.speech.reason, 'task_ended', 'task_ended relayed');
  t.end();
});

test('bounded stop: connect_failed with a stuck stop still relays and completes', async(t) => {
  const {ep, mgr, log} = makeCall();
  await startSpeech(mgr, 'L1');
  await tick();
  ep.forkAudioStop = () => new Promise(noop);
  ep.fire(ListenEvents.ConnectFailure, {reason: 'x'});
  await new Promise((resolve) => setTimeout(resolve, 1200));
  t.deepEqual(closed(log), ['L1:connect_failed'], 'relayed after the bound');
  t.notOk(mgr.isTaskRunning('listen'), 'completed and untracked');
  t.equal(ep.listenerCount(ListenEvents.Disconnect), 0, 'handlers removed');
  t.end();
});

test('bounded stop: a kill that rejects is handled by the manager', async(t) => {
  const {mgr} = makeCall();
  const task = await startSpeech(mgr, 'L1');
  task.kill = () => Promise.reject(new Error('boom'));
  let unhandled = 0;
  const onUnhandled = () => unhandled++;
  process.on('unhandledRejection', onUnhandled);
  mgr.stop('listen');
  await tick();
  await tick();
  process.removeListener('unhandledRejection', onUnhandled);
  t.equal(unhandled, 0, 'no unhandled rejection');
  t.end();
});

/* Review finding 2: a stop then restart on the same bugname never stops the replacement */
const slowPreconditions = (cs, ep) => {
  cs._evaluatePreconditions = async() => {
    await tick();
    return {ep};
  };
};

test('restart: stop then immediate start: the new start is issued after the old stop', async(t) => {
  const {ep, mgr} = makeCall();
  attachRule(ep);
  await startSpeech(mgr, 'L1');
  await tick();
  mgr.stop('listen');
  const b = await startSpeech(mgr, 'L2');
  await tick();
  t.deepEqual(ep.calls, ['start:jambonz-background-listen', 'stop:jambonz-background-listen',
    'start:jambonz-background-listen'], 'stop, then start');
  t.ok(ep.attached.has('jambonz-background-listen') && mgr.getTask('listen') === b, 'replacement attached');
  t.end();
});

test('restart: an old stop that never settles delays the start at most the bound, never stops B', async(t) => {
  const {ep, mgr} = makeCall();
  attachRule(ep);
  await startSpeech(mgr, 'L1');
  await tick();
  const stop = ep.forkAudioStop;
  ep.forkAudioStop = (b) => {
    stop(b);
    return new Promise(noop);
  };
  mgr.stop('listen');
  ep.forkAudioStop = stop;
  const began = Date.now();
  const b = await startSpeech(mgr, 'L2');
  await tick();
  t.ok(Date.now() - began < 2000, 'bounded wait');
  t.ok(ep.attached.has('jambonz-background-listen') && mgr.getTask('listen') === b, 'replacement attached');
  t.end();
});

test('restart: once a replacement owns the bugname, the old task never stops it', async(t) => {
  const {ep, mgr, log} = makeCall();
  attachRule(ep);
  const a = await startSpeech(mgr, 'L1');
  await tick();
  /* A ends without a stop reaching FreeSWITCH (stop timed out after the bug was gone) */
  ep.attached.delete('jambonz-background-listen');
  mgr.stop('listen');
  await tick();
  await tick();
  const b = await startSpeech(mgr, 'L2');
  await tick();
  ep.calls.length = 0;
  a._failSpeechListen('connect_failed');
  await a.kill(a.cs);
  await tick();
  t.deepEqual(ep.calls, [], 'no stop issued by the old task');
  t.ok(ep.attached.has('jambonz-background-listen') && mgr.getTask('listen') === b, 'replacement intact');
  t.notOk(closed(log).includes('L2:connect_failed'), 'nothing reported for B');
  t.end();
});

test('restart: stop during a speech start cancels it; the next start runs after it started and stopped', async(t) => {
  const {ep, cs, mgr} = makeCall();
  attachRule(ep);
  slowPreconditions(cs, ep);
  const first = startSpeech(mgr, 'L1');
  mgr.stop('listen');
  const second = startSpeech(mgr, 'L2');
  const [a, b] = await Promise.all([first, second]);
  await tick();
  t.equal(a, undefined, 'cancelled');
  t.ok(b && mgr.getTask('listen') === b, 'replacement tracked');
  const i = ep.calls.lastIndexOf('stop:jambonz-background-listen');
  t.ok(i === -1 || i < ep.calls.lastIndexOf('start:jambonz-background-listen'), 'no stop after the last start');
  t.ok(ep.attached.has('jambonz-background-listen'), 'replacement attached');
  t.end();
});

test('restart: a listen without metadata.speech is not cancelled by a stop during its start (as before)', async(t) => {
  const {ep, cs, mgr} = makeCall();
  attachRule(ep);
  slowPreconditions(cs, ep);
  const opts = {verb: 'listen', url: 'wss://a.example/stream', metadata: {beep_source: 'avmd'}};
  const first = mgr.newTask('listen', opts);
  mgr.stop('listen');
  const a = await first;
  await tick();
  t.ok(a && mgr.getTask('listen') === a, 'started and tracked, as before');
  t.deepEqual(ep.calls, ['start:jambonz-background-listen'], 'never stopped');
  t.end();
});

/* Review finding 3: a superseded stream is never admitted again */
test('speech-events: superseded stream ids are not admitted', (t) => {
  const st = createAdmission();
  t.ok(admitSpeechEvent(st, ev('speech_started', {stream_id: 'a', seq: 10, turn: 1})), 'a');
  t.ok(admitSpeechEvent(st, ev('speech_started', {stream_id: 'b', seq: 1, turn: 0})), 'b supersedes a');
  t.notOk(admitSpeechEvent(st, ev('speech_started', {stream_id: 'a', seq: 10, turn: 1})), 'late duplicate from a');
  t.notOk(admitSpeechEvent(st, ev('heartbeat', {stream_id: 'a', seq: 11})), 'anything from a');
  t.ok(admitSpeechEvent(st, ev('heartbeat', {stream_id: 'b', seq: 2})), 'b state untouched');
  for (let i = 0; i < 10; i++) admitSpeechEvent(st, ev('heartbeat', {stream_id: `x${i}`, seq: 1}));
  t.ok(st.retired.length <= 8, 'bounded');
  t.end();
});

test('listen admission: a late duplicate start from a superseded stream does not cut', (t) => {
  const log = [];
  const {ep} = makeListen({speech: {mode: 'drive'}}, makeCs(log, {sessionEp: true}));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started', {stream_id: 'a', seq: 10, turn: 1})));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started', {stream_id: 'b', seq: 1, turn: 0})));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started', {stream_id: 'a', seq: 10, turn: 1})));
  t.equal(kills(log), 2, 'a and b cut once each');
  t.deepEqual(cutOf(log)[2], {applied: false, reason: 'not_admitted'}, 'late a rejected');
  t.end();
});

/* Review finding 1: ambiguous timings never stop a healthy recording or silence the speech listen */
test('fork timing: record not yet connected, speech connect_failed: record stays tracked, not stopped', async(t) => {
  const {ep, mgr, log} = makeCall();
  attachRule(ep);
  const record = await mgr.newTask('record');
  await startSpeech(mgr, 'L1');
  await tick();
  ep.fire(ListenEvents.ConnectFailure, {reason: 'x'});
  await tick();
  await tick();
  t.equal(mgr.getTask('record'), record, 'record tracked');
  t.notOk(ep.calls.includes('stop:jambonz-session-record'), 'record fork never stopped');
  t.deepEqual(closed(log), ['L1:connect_failed'], 'speech told');
  t.end();
});

test('fork timing: speech connected, record connect_failed: both keep running', async(t) => {
  const {ep, mgr, log} = makeCall();
  attachRule(ep);
  const record = await mgr.newTask('record');
  await startSpeech(mgr, 'L1');
  await tick();
  ep.fire(ListenEvents.Connect);
  ep.fire(ListenEvents.Connect);
  ep.fire(ListenEvents.ConnectFailure, {reason: 'x'});
  await tick();
  t.equal(mgr.getTask('record'), record, 'record tracked');
  t.ok(mgr.isTaskRunning('listen'), 'speech keeps running (it connected)');
  t.deepEqual(closed(log), [], 'nothing relayed');
  t.end();
});

test('fork timing: beep-only listen with record keeps acting on connect_failed (as before)', async(t) => {
  const {ep, mgr} = makeCall();
  attachRule(ep);
  await mgr.newTask('record');
  await mgr.newTask('listen', {verb: 'listen', url: 'wss://a.example/stream', metadata: {beep_source: 'avmd'}});
  await tick();
  ep.fire(ListenEvents.Connect);
  ep.fire(ListenEvents.ConnectFailure, {reason: 'x'});
  await tick();
  t.notOk(mgr.isTaskRunning('listen'), 'beep listen done, as before');
  t.ok(mgr.isTaskRunning('record'), 'record tracked');
  t.end();
});
