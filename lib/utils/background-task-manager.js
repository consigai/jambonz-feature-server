const { normalizeJambones } = require('@jambonz/verb-specifications');
const makeTask = require('../tasks/make_task');
const { JAMBONZ_RECORD_WS_BASE_URL, JAMBONZ_RECORD_WS_USERNAME, JAMBONZ_RECORD_WS_PASSWORD } = require('../config');
const Emitter = require('events');
// CONSIG: LOG-REDACT and FORK-SERIAL imports. listenForLog gives log-safe views of listen options;
// getSpeechMode tells newTask whether a listen is a speech listen (only those may be cancelled by stop()).
const {listenForLog} = require('./listen-redact');
const {getSpeechMode} = require('./speech-events');

// CONSIG: FORK-SERIAL. begin fork-serial-constants.
/* audio-fork task types: a new start waits for the previous task's stop (same bugname) */
const FORK_TYPES = ['listen', 'record'];
/* bound on that wait; the listen's own fork stop is bounded at 1 s */
const STOP_WAIT_MS = 1500;
// CONSIG: end fork-serial-constants.

// CONSIG: LOG-REDACT. Every place in this file that logs a listen goes through this helper or listenForLog.
/* listen opts and listen tasks carry a signed url and keyterms: log a redacted view */
const logSafeTask = (task) => (task && task.name === 'listen' ? listenForLog(task.data, task._bugname) : task);

class BackgroundTaskManager extends Emitter {
  constructor({cs, logger, rootSpan}) {
    super();
    this.tasks = new Map();
    // CONSIG: FORK-SERIAL. `starting` and `stopping` are the two maps that serialise stop and start per type.
    /* type -> {promise, cancelled}: a start in progress (between newTask and tasks.set) */
    this.starting = new Map();
    /* type -> promise of the previous task's stop (audio-fork types only) */
    this.stopping = new Map();
    this.cs = cs;
    this.logger = logger;
    this.rootSpan = rootSpan;
  }

  isTaskRunning(type) {
    return this.tasks.has(type);
  }

  getTask(type) {
    if (this.tasks.has(type)) {
      return this.tasks.get(type);
    }
  }

  count() {
    return this.tasks.size;
  }

  async newTask(type, opts, sticky = false) {
    this.logger.info({opts: type === 'listen' ? listenForLog(opts) : opts}, `initiating Background task ${type}`);
    // CONSIG: FORK-SERIAL, RECORD-DEDUP. begin newTask-serialise. Two rules, in this order:
    // 1. A start waits for the previous task's stop of the same type (audio-fork types only). Without it
    //    a late forkAudioStop of the old listen stops the replacement's fork (same bugname).
    // 2. Concurrent starts of one type collapse to one (RECORD-DEDUP). The account-level record start and
    //    a forced early-media record start can arrive together; without this there are two record forks.
    //    Only for the audio-fork types (FORK_TYPES: record, listen). Every other type (bargeIn, transcribe,
    //    ttsStream) starts as in upstream: two overlapping starts both run and keep their own options.
    // Both waits must stay before the `tasks.has(type)` check: after they finish, the tracked task is
    // the one to compare with.
    /*
     * Concurrent starts of one type collapse to one: a second start waits for the first. If the
     * first produced a task, the second returns it; if it produced none (for example a record
     * start without force while a forced one is waiting), the second starts its own.
     */
    if (this.stopping.has(type)) await this._waitForStop(type);
    while (FORK_TYPES.includes(type) && this.starting.has(type)) {
      const task = await this.starting.get(type).promise;
      if (task && this.tasks.get(type) === task) {
        this.logger.info(`Background task ${type} was starting, skipped`);
        return task;
      }
    }
    if (this.tasks.has(type)) {
      this.logger.info(`Background task ${type} is running, skipped`);
      return;
    }
    // CONSIG: FORK-SERIAL. end newTask-serialise; the next lines register the start so stop() can see it.
    /* only a speech listen's start may be cancelled by a stop; anything else behaves as before */
    const entry = {cancelled: false, cancellable: type === 'listen' && getSpeechMode(opts?.metadata) !== null};
    entry.promise = this._startTask(type, opts, sticky, entry);
    this.starting.set(type, entry);
    try {
      return await entry.promise;
    } finally {
      if (this.starting.get(type) === entry) this.starting.delete(type);
    }
  }

  // CONSIG: FORK-SERIAL. The old body of newTask(), moved here so newTask can track it in `starting`.
  async _startTask(type, opts, sticky, entry) {
    let task;
    switch (type) {
      case 'listen':
        task = await this._initListen(opts);
        break;
      case 'bargeIn':
        task = await this._initBargeIn(opts);
        break;
      case 'record':
        // CONSIG: EARLY-RECORD. opts.force starts the record task even when the account/app flag is off.
        task = await this._initRecord(opts && opts.force === true);
        break;
      case 'transcribe':
        task = await this._initTranscribe(opts);
        break;
      case 'ttsStream':
        task = await this._initTtsStream(opts);
        break;
      default:
        break;
    }
    // CONSIG: FORK-SERIAL. A stop() that arrived while this start was in flight set entry.cancelled; the
    // new task is then stopped instead of tracked, so a stop is never lost to a start that finishes later.
    if (task && entry.cancelled) {
      /* stopped while it was starting: do not track it, stop it */
      this.logger.info(`Background task ${type} was stopped while starting`);
      await this._stopTask(task);
      return undefined;
    }
    // CONSIG: BGTASK-GUARDS. Track only a task that has a span. A start that raced with early call
    // termination (quick CANCEL) can yield a partial task; tracking it crashed the manager.
    if (task && task.span) {
      this.tasks.set(type, task);
    }
    if (task && sticky) task.sticky = true;
    return task;
  }

  stop(type) {
    // CONSIG: FORK-SERIAL. begin stop-serialise. stop() no longer kills synchronously: it records the stop
    // promise per type (_trackStop) so the next newTask() of that type waits for it. A speech listen that
    // is still starting is cancelled, not left to finish.
    const starting = this.starting.get(type);
    if (starting && starting.cancellable) {
      /*
       * a speech listen start in progress is cancelled; the next start waits until it has started
       * and stopped, so it is a genuine replacement on the same bugname
       */
      starting.cancelled = true;
      this.starting.delete(type);
      this._trackStop(type, starting.promise);
    }
    const task = this.getTask(type);
    if (task) {
      this.logger.info(`stopping background task: ${type}`);
      this._trackStop(type, this._stopTask(task));
      // Remove task from managed List
      this.tasks.delete(type);
    }
    // CONSIG: end stop-serialise.
  }

  // CONSIG: FORK-SERIAL. Remember an in-flight stop for audio-fork types; cleared when it settles.
  _trackStop(type, promise) {
    if (!FORK_TYPES.includes(type)) return;
    const p = Promise.resolve(promise).catch(() => {});
    this.stopping.set(type, p);
    p.then(() => {
      if (this.stopping.get(type) === p) this.stopping.delete(type);
      return;
    }).catch(() => {});
  }

  // CONSIG: FORK-SERIAL. Wait for the previous stop, at most STOP_WAIT_MS, so a stuck FreeSWITCH call
  // delays a restart but cannot block it.
  async _waitForStop(type) {
    let timer;
    const timeout = new Promise((resolve) => timer = setTimeout(resolve, STOP_WAIT_MS));
    await Promise.race([this.stopping.get(type), timeout]);
    clearTimeout(timer);
  }

  // CONSIG: FORK-SERIAL. Upstream called task.kill() and ignored its promise; a rejected kill was an
  // unhandled rejection. Here the kill is awaited by whoever tracks it and errors are logged.
  /**
   * @returns {Promise} settles when the task's kill does; never rejects (a kill error is logged)
   */
  _stopTask(task) {
    task.removeAllListeners();
    // CONSIG: BGTASK-GUARDS. span.end() is guarded here and in _taskCompleted/_taskError: a task that never
    // got a span (early termination) must not throw from cleanup.
    if (task.span && typeof task.span.end === 'function') task.span.end();
    return Promise.resolve()
      .then(() => task.kill(this.cs))
      .catch((err) => this.logger.info({err}, `BackgroundTaskManager: error stopping ${task.name} task`));
  }

  stopAll() {
    this.logger.debug('BackgroundTaskManager:stopAll');
    for (const key of this.tasks.keys()) {
      this.stop(key);
    }
  }

  // Initiate Listen
  async _initListen(opts, bugname = 'jambonz-background-listen', ignoreCustomerData = false, type = 'listen') {
    let task;
    try {
      const t = normalizeJambones(this.logger, [opts]);
      task = makeTask(this.logger, t[0]);
      task.bugname = bugname;
      task.ignoreCustomerData = ignoreCustomerData;
      const resources = await this.cs._evaluatePreconditions(task);
      const {span, ctx} = this.rootSpan.startChildSpan(`background-${type}:${task.summary}`);
      task.span = span;
      task.ctx = ctx;
      task.exec(this.cs, resources)
        .then(this._taskCompleted.bind(this, type, task))
        .catch(this._taskError.bind(this, type, task));
    } catch (err) {
      this.logger.info({err, opts: listenForLog(opts, bugname)},
        `BackgroundTaskManager:_initListen - Error creating ${bugname} task`);
      // CONSIG: BGTASK-GUARDS. Return no task when creation failed, so newTask() does not track a half-built one.
      return undefined;
    }
    return task;
  }

  // Initiate Gather
  async _initBargeIn(opts) {
    let task;
    try {
      const copy = JSON.parse(JSON.stringify(opts));
      const t = normalizeJambones(this.logger, [opts]);
      task = makeTask(this.logger, t[0]);
      task
        .once('dtmf', this._bargeInTaskCompleted.bind(this))
        .once('vad', this._bargeInTaskCompleted.bind(this))
        .once('transcription', this._bargeInTaskCompleted.bind(this))
        .once('timeout', this._bargeInTaskCompleted.bind(this));
      const resources = await this.cs._evaluatePreconditions(task);
      const {span, ctx} = this.rootSpan.startChildSpan(`background-bargeIn:${task.summary}`);
      task.span = span;
      task.ctx = ctx;
      task.bugname_prefix = 'background_bargeIn_';
      task.exec(this.cs, resources)
        .then(() => {
          this._taskCompleted('bargeIn', task);
          if (task.sticky && !this.cs.callGone && !this.cs._stopping) {
            this.logger.info('BackgroundTaskManager:_initBargeIn: restarting background bargeIn');
            this._bargeInHandled = false;
            this.newTask('bargeIn', copy, true);
          }
          return;
        })
        .catch(this._taskError.bind(this, 'bargeIn', task));
    } catch (err) {
      this.logger.info(err, 'BackgroundTaskManager:_initGather - Error creating bargeIn task');
      // CONSIG: BGTASK-GUARDS. Return no task when creation failed, so newTask() does not track a half-built one.
      return undefined;
    }
    return task;
  }

  // Initiate Record
  // CONSIG: EARLY-RECORD. `force` (only create-call recordEarlyMedia passes it) and the earlyMedia option below.
  async _initRecord(force = false) {
    if (force || this.cs.accountInfo.account.record_all_calls || this.cs.application.record_all_calls) {
      if (!JAMBONZ_RECORD_WS_BASE_URL || !this.cs.accountInfo.account.bucket_credential) {
        this.logger.error('_initRecord: invalid cfg - missing JAMBONZ_RECORD_WS_BASE_URL or bucket config');
        return undefined;
      }
      const listenOpts = {
        url: `${JAMBONZ_RECORD_WS_BASE_URL}/record/${this.cs.accountInfo.account.bucket_credential.vendor}`,
        disableBidirectionalAudio: true,
        mixType : 'stereo',
        passDtmf: true,
        // CONSIG: EARLY-RECORD. The listen verb's earlyMedia flag lets the fork start before answer.
        // allow recording to start during early media when applicable
        earlyMedia: true
      };
      if (JAMBONZ_RECORD_WS_USERNAME && JAMBONZ_RECORD_WS_PASSWORD) {
        listenOpts.wsAuth = {
          username: JAMBONZ_RECORD_WS_USERNAME,
          password: JAMBONZ_RECORD_WS_PASSWORD
        };
      }
      this.logger.debug({listenOpts: listenForLog(listenOpts)}, '_initRecord: enabling listen');
      return await this._initListen({verb: 'listen', ...listenOpts}, 'jambonz-session-record', true, 'record');
    }
  }

  // Initiate Transcribe
  async _initTranscribe(opts) {
    let task;
    try {
      const t = normalizeJambones(this.logger, [opts]);
      task = makeTask(this.logger, t[0]);
      const resources = await this.cs._evaluatePreconditions(task);
      const {span, ctx} = this.rootSpan.startChildSpan(`background-transcribe:${task.summary}`);
      task.span = span;
      task.ctx = ctx;
      task.bugname_prefix = 'background_transcribe_';
      task.exec(this.cs, resources)
        .then(this._taskCompleted.bind(this, 'transcribe', task))
        .catch(this._taskError.bind(this, 'transcribe', task));
    } catch (err) {
      this.logger.info(err, 'BackgroundTaskManager:_initTranscribe - Error creating transcribe task');
      // CONSIG: BGTASK-GUARDS. Return no task when creation failed, so newTask() does not track a half-built one.
      return undefined;
    }
    return task;
  }

  // Initiate Tts Stream
  async _initTtsStream(opts) {
    let task;
    try {
      const t = normalizeJambones(this.logger, [opts]);
      task = makeTask(this.logger, t[0]);
      const resources = await this.cs._evaluatePreconditions(task);
      const {span, ctx} = this.rootSpan.startChildSpan(`background-ttsStream:${task.summary}`);
      task.span = span;
      task.ctx = ctx;
      task.exec(this.cs, resources)
        .then(this._taskCompleted.bind(this, 'ttsStream', task))
        .catch(this._taskError.bind(this, 'ttsStream', task));
    } catch (err) {
      this.logger.info(err, 'BackgroundTaskManager:_initTtsStream - Error creating ttsStream task');
      // CONSIG: BGTASK-GUARDS. Return no task when creation failed, so newTask() does not track a half-built one.
      return undefined;
    }
    return task;
  }

  _taskCompleted(type, task) {
    this.logger.debug({type, task: logSafeTask(task)},
      `BackgroundTaskManager:_taskCompleted: task completed, sticky: ${task.sticky}`);
    task.removeAllListeners();
    if (task.span && typeof task.span.end === 'function') task.span.end();
    // CONSIG: RECORD-DEDUP. A second record start that failed (for example "already attached") would
    // otherwise delete the live record task from the map here and in _taskError, and the recording
    // would be orphaned and never stopped.
    /* only the tracked task may untrack itself; a failed duplicate never removes the live one */
    if (this.tasks.get(type) === task) this.tasks.delete(type);
  }
  _taskError(type, task, error) {
    this.logger.info({type, task: logSafeTask(task), error}, 'BackgroundTaskManager:_taskError: task Error');
    task.removeAllListeners();
    if (task.span && typeof task.span.end === 'function') task.span.end();
    if (this.tasks.get(type) === task) this.tasks.delete(type);
  }

  _bargeInTaskCompleted(evt) {
    if (this._bargeInHandled) return;
    this._bargeInHandled = true;
    this.logger.debug({evt},
      'BackgroundTaskManager:_bargeInTaskCompleted on event from background bargeIn, emitting bargein-done event');
    this.emit('bargeIn-done', evt);
  }
}

module.exports = BackgroundTaskManager;
