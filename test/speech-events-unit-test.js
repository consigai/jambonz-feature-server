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
const {redactUrl, redactListenOpts} = require('../lib/utils/listen-redact');

test('listen-redact: redactUrl drops the query, fragment and credentials', (t) => {
  t.equal(redactUrl('wss://a.example/stream?cid=c1&exp=1&sig=SECRET'), 'wss://a.example/stream', 'query dropped');
  t.equal(redactUrl('wss://a.example/s#frag?x'), 'wss://a.example/s', 'fragment dropped');
  t.equal(redactUrl('wss://user:pw@a.example/s?sig=1'), 'wss://a.example/s', 'userinfo dropped');
  t.equal(redactUrl('wss://a.example/record/aws_s3'), 'wss://a.example/record/aws_s3', 'plain url unchanged');
  t.equal(redactUrl('/relative?sig=1'), '/relative', 'relative url');
  t.equal(redactUrl(undefined), undefined, 'non-string unchanged');
  t.end();
});

test('listen-redact: redactListenOpts reduces speech, hides secrets, keeps the rest, never mutates', (t) => {
  const opts = {
    url: 'wss://a.example/stream?cid=c1&sig=SECRET',
    wsAuth: {username: 'u', password: 'PW'},
    disableBidirectionalAudio: true,
    metadata: {
      call_id: 'c1', beep_source: 'avmd',
      speech: {mode: 'drive', engine: 'deepgram_flux', listen_id: 'L-1', language: 'en-US', interim: true,
        engine_options: {eot_threshold: 0.7, keyterms: ['Jane Patient', 'Lisinopril']}}
    }
  };
  const before = JSON.stringify(opts);
  const out = redactListenOpts(opts);
  t.equal(JSON.stringify(opts), before, 'input not mutated (the wire is unchanged)');
  t.equal(out.url, 'wss://a.example/stream', 'url without query');
  t.equal(out.wsAuth, '[redacted]', 'wsAuth hidden');
  t.equal(out.disableBidirectionalAudio, true, 'other fields kept');
  t.deepEqual(out.metadata.speech, {mode: 'drive', engine: 'deepgram_flux', listen_id: 'L-1', keyterm_count: 2},
    'speech reduced to mode, engine, listen_id, keyterm count');
  t.equal(out.metadata.beep_source, 'avmd', 'other metadata kept');
  const s = JSON.stringify(out);
  t.notOk(s.includes('SECRET') || s.includes('Jane') || s.includes('PW'), 'no token, keyterm or password');
  t.deepEqual(redactListenOpts({url: 'ws://x/y', metadata: {a: 1}}), {url: 'ws://x/y', metadata: {a: 1}},
    'no speech, no secrets: same content');
  t.equal(redactListenOpts({metadata: {speech: {mode: 'shadow'}}}).metadata.speech.keyterm_count, 0, 'no keyterms');
  t.deepEqual(redactListenOpts({url: 'ws://x/y?k=1', method: 'GET', auth: {username: 'u', password: 'p'}}),
    {url: 'ws://x/y', method: 'GET', auth: '[redacted]'}, 'a ws hook');
  t.equal(redactListenOpts(undefined), undefined, 'undefined');
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
  t.deepEqual(st, {streamId: 's1', lastSeq: 7, lastStartedTurn: 1, lastEndedTurn: 0}, 'rejections changed nothing');
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

test('listen admission: shadow mode reports not_admitted the same way', (t) => {
  const log = [];
  const {ep} = makeListen({speech: {mode: 'shadow'}}, makeCs(log));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started', {seq: 1, turn: 0})));
  ep.emit(ListenEvents.JsonMessage, frame(ev('speech_started', {seq: 2, turn: 0})));
  t.deepEqual(cutOf(log), [{applied: false, reason: 'shadow'}, {applied: false, reason: 'not_admitted'}], 'cuts');
  t.end();
});
