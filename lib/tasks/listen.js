const Task = require('./task');
const {TaskName, TaskPreconditions, ListenEvents, ListenStatus} = require('../utils/constants.json');
const makeTask = require('./make_task');
const moment = require('moment');
const {
  getSpeechMode, getListenId, parseSpeechMessage, decideCut, appliedCut, isSpeechStarted,
  buildSpeechRelay, streamClosed, speechLogFields, createAdmission, admitSpeechEvent, NOT_ADMITTED_CUT
} = require('../utils/speech-events');
const {redactUrl, redactListenOpts} = require('../utils/listen-redact');
const MAX_PLAY_AUDIO_QUEUE_SIZE = 10;
const DTMF_SPAN_NAME = 'dtmf';
const SESSION_RECORD_BUGNAME = 'jambonz-session-record';

/*
 * Audio-fork listen tasks registered on each endpoint. mod_audio_fork events carry no bugname, so
 * with more than one fork on an endpoint a task cannot tell whose socket an event is about.
 */
const forkListens = new WeakMap();

function escapeString(str) {
  return str
    .replace(/\\/g, '\\\\')   // Escape backslashes
    .replace(/"/g, '\\"')     // Escape double quotes
    .replace(/[\b]/g, '\\b')  // Escape backspace (NOTE: [\b] not \b)
    .replace(/\f/g, '\\f')    // Escape formfeed
    .replace(/\n/g, '\\n')    // Escape newlines
    .replace(/\r/g, '\\r')    // Escape carriage returns
    .replace(/\t/g, '\\t');   // Escape tabs
}

class TaskListen extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts);
    /**
     * @deprecated
     * use bidirectionalAudio.enabled
     */
    this.disableBidirectionalAudio = opts.disableBidirectionalAudio;
    this.preconditions = TaskPreconditions.Endpoint;

    [
      'action', 'auth', 'method', 'url', 'finishOnKey', 'maxLength', 'mixType', 'passDtmf', 'playBeep',
      'sampleRate', 'timeout', 'transcribe', 'wsAuth', 'disableBidirectionalAudio', 'channel'
    ].forEach((k) => this[k] = this.data[k]);

    //Escape JSON special characters in metadata
    if (this.data.metadata) {
      this.metadata = {};
      for (const key in this.data.metadata) {
        if (this.data.metadata.hasOwnProperty(key)) {
          const value = this.data.metadata[key];
          this.metadata[key] = typeof value === 'string' ? escapeString(value) : value;
        }
      }
    }

    this.mixType = this.mixType || 'mono';
    this.sampleRate = this.sampleRate || 8000;
    this.earlyMedia = this.data.earlyMedia === true;
    /* 'shadow' | 'drive' | null; null keeps today's behaviour (no speech event handling) */
    this.speechMode = getSpeechMode(this.data.metadata);
    /* the application's id for this listen, copied into every relay; never read otherwise */
    this.listenId = getListenId(this.data.metadata);
    /* per-stream seq/turn guard applied before a speech_started may cut (speech mode only) */
    if (this.speechMode) this._admission = createAdmission();
    this.parentTask = parentTask;
    this.nested = parentTask instanceof Task;

    this.results = {};
    this.playAudioQueue = [];
    this.isPlayingAudioFromQueue = false;
    this.bidirectionalAudio = {
      enabled: this.disableBidirectionalAudio === true ? false : true,
      ...(this.data['bidirectionalAudio']),
    };

    // From drachtio-version 3.0.40, forkAudioStart will send empty bugname, metadata together with
    // bidirectionalAudio params that cause old version of freeswitch missunderstand between bugname and
    // bidirectionalAudio params
    this._bugname = 'audio_fork';

    if (this.transcribe) this.transcribeTask = makeTask(logger, {'transcribe': opts.transcribe}, this);
  }

  get name() { return TaskName.Listen; }

  set bugname(name) { this._bugname = name; }

  set ignoreCustomerData(val) { this._ignoreCustomerData = val; }

  async exec(cs, {ep}) {
    await super.exec(cs);
    this.ep = ep;
    this._dtmfHandler = this._onDtmf.bind(this, ep);

    try {
      this.hook = this.normalizeUrl(this.url, 'GET', this.wsAuth);
      this.logger.debug({hook: redactListenOpts(this.hook)}, 'prepared ws url');
      if (this.playBeep) await this._playBeep(ep);
      if (this.transcribeTask) {
        this.logger.debug('TaskListen:exec - starting nested transcribe task');
        const {span, ctx} = this.startChildSpan(`nested:${this.transcribeTask.summary}`);
        this.transcribeTask.span = span;
        this.transcribeTask.ctx = ctx;
        this.transcribeTask.exec(cs, {ep})
          .then((result) => span.end())
          .catch((err) => span.end());
      }
      await this._startListening(cs, ep);
      await this.awaitTaskDone();
      await this.performAction(this.results, !this.nested);
    } catch (err) {
      this.logger.info(err, `TaskListen:exec - error ${redactUrl(this.url)}`);
      this._relayStreamClosed('connect_failed');
    }
    if (this.transcribeTask) this.transcribeTask.kill(cs);
    this._removeListeners(ep);
  }

  async kill(cs) {
    /* claimed now so nothing else is relayed; sent once the fork is stopped and listeners removed */
    const relayTaskEnded = this._claimStreamClosed();
    super.kill(cs);
    this.logger.debug(`TaskListen:kill endpoint connected? ${this.ep && this.ep.connected}`);
    this._clearTimer();
    this.playAudioQueue = [];
    if (this.ep && this.ep.connected) {
      this.logger.debug('TaskListen:kill closing websocket');
      try {
        const args = this._bugname ? [this._bugname] : [];
        await this.ep.forkAudioStop(...args);
        this.logger.debug('TaskListen:kill successfully closed websocket');
      } catch (err) {
        this.logger.info(err, 'TaskListen:kill');
      }
    }
    if (this.recordStartTime) {
      const duration = moment().diff(this.recordStartTime, 'seconds');
      this.results.dialCallDuration = duration;
    }
    if (this.transcribeTask) {
      await this.transcribeTask.kill(cs);
      this.transcribeTask = null;
    }
    this.ep && this._removeListeners(this.ep);
    if (relayTaskEnded) this._sendStreamClosed('task_ended');
    this.notifyTaskDone();
  }

  async updateListen(status, silence = false) {
    if (!this.killed && this.ep && this.ep.connected) {
      const args = [
        ...(this._bugname ? [this._bugname] : []),
        ...(status === ListenStatus.Pause ? ([silence]) : []),
      ];
      this.logger.info(`TaskListen:updateListen status ${status}`);
      switch (status) {
        case ListenStatus.Pause:
          await this.ep.forkAudioPause(...args)
            .catch((err) => this.logger.info(err, 'TaskListen: error pausing audio'));
          break;
        case ListenStatus.Resume:
          await this.ep.forkAudioResume(...args)
            .catch((err) => this.logger.info(err, 'TaskListen: error resuming audio'));
          break;
      }
    }
  }

  async _playBeep(ep) {
    await ep.play('tone_stream://L=1;%(500, 0, 1500)')
      .catch((err) => this.logger.info(err, 'TaskListen:_playBeep Error playing beep'));
  }

  async _startListening(cs, ep) {
    this._initListeners(ep);
    const ci = this.nested ? this.parentTask.sd.callInfo : cs.callInfo.toJSON();
    if (this._ignoreCustomerData) {
      delete ci.customerData;
    }
    const metadata = Object.assign(
      {sampleRate: this.sampleRate, mixType: this.mixType},
      ci,
      this.metadata);
    if (this.hook.auth) {
      await this.ep.set({
        'MOD_AUDIO_BASIC_AUTH_USERNAME': this.hook.auth.username,
        'MOD_AUDIO_BASIC_AUTH_PASSWORD': this.hook.auth.password
      });
    }
    /* a connect event from here on may be this fork's own */
    this._forkStartIssued = true;
    await ep.forkAudioStart({
      wsUrl: this.hook.url,
      mixType: this.mixType,
      sampling: this.sampleRate,
      ...(this._bugname && {bugname: this._bugname}),
      metadata,
      bidirectionalAudio: this.bidirectionalAudio || {}
    });
    this.recordStartTime = moment();
    if (this.maxLength) {
      this._timer = setTimeout(() => {
        this.logger.debug(`TaskListen terminating task due to timeout of ${this.timeout}s reached`);
        this.kill(cs);
      }, this.maxLength * 1000);
    }
  }

  /**
   * mod_audio_fork events carry no bugname: every listen on this endpoint (the speech listen and
   * the call recording among them) receives every fork's events. Each task therefore keeps
   * references to the handlers it added and removes only those, never another fork's.
   */
  _initListeners(ep) {
    if (!this._epHandlers || this._epHandlersEp !== ep) {
      if (this._epHandlers) this._removeListeners(this._epHandlersEp);
      this._epHandlersEp = ep;
      this._epHandlers = [
        [ListenEvents.Connect, this._onConnect.bind(this, ep)],
        [ListenEvents.ConnectFailure, this._onConnectFailure.bind(this, ep)],
        [ListenEvents.Error, this._onError.bind(this, ep)],
        /* support bi-directional audio */
        ...(this.bidirectionalAudio.enabled ? [[ListenEvents.PlayAudio, this._onPlayAudio.bind(this, ep)]] : []),
        [ListenEvents.KillAudio, this._onKillAudio.bind(this, ep)],
        [ListenEvents.Disconnect, this._onDisconnect.bind(this, ep)],
        ...(this.speechMode ? [[ListenEvents.JsonMessage, this._onSpeechMessage.bind(this, ep)]] : [])
      ];
    }
    for (const [event, handler] of this._epHandlers) ep.addCustomEventListener(event, handler);
    if (!forkListens.has(ep)) forkListens.set(ep, new Set());
    forkListens.get(ep).add(this);
    if (this.finishOnKey || this.passDtmf) {
      ep.on('dtmf', this._dtmfHandler);
    }
  }

  _removeListeners(ep) {
    if (this.finishOnKey || this.passDtmf) {
      ep.removeListener('dtmf', this._dtmfHandler);
    }
    for (const [event, handler] of this._epHandlers || []) {
      ep.removeCustomEventListener(event, handler);
    }
    forkListens.get(ep)?.delete(this);
  }

  _onDtmf(ep, evt) {
    const {dtmf, duration} = evt;
    this.logger.debug({evt}, `TaskListen:_onDtmf received dtmf ${dtmf}`);
    if (this.passDtmf && this.ep?.connected) {
      const obj = {event: 'dtmf', dtmf, duration};
      const args = this._bugname ? [this._bugname, obj] : [obj];
      this.ep.forkAudioSendText(...args)
        .catch((err) => this.logger.info({err}, 'TaskListen:_onDtmf error sending dtmf'));
    }

    /* add a child span for the dtmf event */
    const msDuration = Math.floor((duration / 8000) * 1000);
    const {span} = this.startChildSpan(`${DTMF_SPAN_NAME}:${dtmf}`);
    span.setAttributes({
      channel: 1,
      dtmf,
      duration: `${msDuration}ms`
    });
    span.end();

    if (evt.dtmf === this.finishOnKey) {
      this.logger.info(`TaskListen:_onDtmf terminating task due to dtmf ${evt.dtmf}`);
      this.results.digits = evt.dtmf;
      this.kill();
    }
  }

  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
  _onConnect(ep) {
    this.logger.info('TaskListen:_onConnect');
    if (this._forkStartIssued) this._sawConnect = true;
  }

  /**
   * @returns {boolean} true if another audio-fork listen task is registered on this endpoint
   */
  _otherForkActive(ep) {
    const set = forkListens.get(ep);
    return !!set && (set.size > 1 || (set.size === 1 && !set.has(this)));
  }

  /**
   * Policy for a fork event this task cannot attribute (no bugname on mod_audio_fork events).
   * Weighing the costs of being wrong:
   * - session recording stops itself on a foreign disconnect or error: the customer loses the rest
   *   of the recording. Ignoring its own real one loses nothing more: the socket is already gone
   *   and FreeSWITCH closes the bug at hangup. So the recording ignores both while another fork
   *   listen is active on the endpoint.
   * - connect_failed after this listen saw a connect (with another fork active) cannot be its own.
   * - every other listen (speech, beep-only, application) still acts on disconnect and error: for
   *   the speech listen a foreign one costs one stream restart by the application.
   * - kill_audio (uuid_break on agent playback) and play_audio cannot stop a recording: unchanged.
   * With one fork on the endpoint nothing is ignored, exactly as before.
   * @returns {boolean} true if the event is ignored (one info line, no url)
   */
  _ignoreForeignForkEvent(ep, event) {
    if (!this._otherForkActive(ep)) return false;
    const ignore = event === ListenEvents.ConnectFailure ?
      this._sawConnect === true :
      this._bugname === SESSION_RECORD_BUGNAME;
    if (ignore) {
      this.logger.info(
        `TaskListen: ignoring ${event} on ${this._bugname}, another audio fork is active on this endpoint`);
    }
    return ignore;
  }

  _onConnectFailure(ep, evt) {
    if (this._ignoreForeignForkEvent(ep, ListenEvents.ConnectFailure)) return;
    this.logger.info(evt, 'TaskListen:_onConnectFailure');
    this._relayStreamClosed('connect_failed');
    this.notifyTaskDone();
  }

  async _playAudio(ep, evt, logger) {
    try {
      const results = await ep.play(evt.file);
      logger.debug(`Finished playing file, result: ${JSON.stringify(results)}`);
      const obj = {
        type: 'playDone',
        data: {
          id: evt.id,
          ...results
        }
      };
      const args = this._bugname ? [this._bugname, obj] : [obj];
      ep.forkAudioSendText(...args);
    } catch (err) {
      logger.error({err}, 'Error playing file');
    }
  }

  async _onPlayAudio(ep, evt) {
    this.logger.info(`received play_audio event: ${JSON.stringify(evt)}`);
    if (!evt.queuePlay) {
      this.playAudioQueue = [];
      this._playAudio(ep, evt, this.logger);
      this.isPlayingAudioFromQueue = false;
      return;
    }

    if (this.playAudioQueue.length <= MAX_PLAY_AUDIO_QUEUE_SIZE) {
      this.playAudioQueue.push(evt);
    }

    if (this.isPlayingAudioFromQueue) return;

    this.isPlayingAudioFromQueue = true;
    while (this.playAudioQueue.length > 0) {
      await this._playAudio(ep, this.playAudioQueue.shift(), this.logger);
    }
    this.isPlayingAudioFromQueue = false;
  }

  _onKillAudio(ep) {
    this.logger.info('received kill_audio event');
    ep.api('uuid_break', ep.uuid);
  }

  _onDisconnect(ep, cs) {
    if (this._ignoreForeignForkEvent(ep, ListenEvents.Disconnect)) return;
    this.logger.debug('_onDisconnect: TaskListen terminating task');
    this._relayStreamClosed('disconnected');
    this.kill(cs);
  }

  /**
   * Relay one stream_closed per task when a speech mode is on. No-op otherwise.
   */
  _relayStreamClosed(reason) {
    if (this._claimStreamClosed()) this._sendStreamClosed(reason);
  }

  /**
   * @returns {boolean} true if this caller now owns the one stream_closed relay of this task
   */
  _claimStreamClosed() {
    if (!this.speechMode || this._streamClosedSent || this.killed || !this.cs) return false;
    this._streamClosedSent = true;
    return true;
  }

  _sendStreamClosed(reason) {
    try {
      this.logger.info(`TaskListen: relaying speech stream_closed, reason ${reason}`);
      this.notifyStatus(
        buildSpeechRelay(streamClosed(reason, this.cs.callSid), undefined, Date.now(), this.listenId));
    } catch (err) {
      this.logger.info({err}, 'TaskListen:_relayStreamClosed error');
    }
  }

  /**
   * mod_audio_fork::json from the listen socket. Only registered when metadata.speech.mode
   * is 'shadow' or 'drive'. Must never throw: drachtio-fsmrf calls this inside its own try.
   */
  _onSpeechMessage(ep, msg) {
    const fsReceivedMs = Date.now();
    try {
      const body = parseSpeechMessage(msg);
      /* nothing is relayed once this task has reported its stream closed */
      if (!body || this.killed || this._streamClosedSent || !this.cs) return;
      const cs = this.cs;
      const admitted = admitSpeechEvent(this._admission, body);
      let cut;
      let killAudio = false;
      if (isSpeechStarted(body) && !admitted) {
        /* a repeated or out-of-order start: relayed for the application to count, never a cut */
        cut = NOT_ADMITTED_CUT;
        this.logger.info({speech: speechLogFields(body), cut}, 'TaskListen: speech_started not admitted');
      }
      else if (isSpeechStarted(body)) {
        const decision = decideCut({
          mode: this.speechMode,
          botModeEnabled: cs.isBotModeEnabled,
          usingWebsockets: cs.appIsUsingWebsockets
        });
        cut = decision.cut;
        if (decision.kill) {
          /* as today: the gather's audio kill runs even if the session kill threw */
          killAudio = true;
          const task = cs.currentTask;
          try {
            cs.kill(true);
            cut = appliedCut(task);
          } catch (err) {
            this.logger.info({err}, 'TaskListen:_onSpeechMessage error killing current task');
            cut = {applied: false, reason: 'kill_error'};
          }
        }
        this.logger.info({speech: speechLogFields(body), cut}, 'TaskListen: speech_started');
      }
      else {
        this.logger.debug({speech: speechLogFields(body)}, 'TaskListen: speech event');
      }
      /* sent synchronously after the kill, before any awaited work */
      this.notifyStatus(buildSpeechRelay(body, cut, fsReceivedMs, this.listenId));
      if (killAudio) this._killAudioAfterCut(cs);
    } catch (err) {
      this.logger.info({err}, 'TaskListen:_onSpeechMessage error');
    }
  }

  /**
   * Drive mode: what the background bargeIn gather does right after speech-bargein-detected
   * today (gather.js _killAudio, the branch for a gather with no nested say or play):
   * uuid_break on the session endpoint, then clear a background TTS stream.
   */
  _killAudioAfterCut(cs) {
    const ep = cs.ep;
    if (!ep?.connected) return;
    ep.api('uuid_break', ep.uuid)
      .catch((err) => this.logger.info({err}, 'TaskListen: error killing audio'));
    if (cs.isTtsStreamEnabled) cs.clearTtsStream();
  }

  _onError(ep, evt) {
    if (this._ignoreForeignForkEvent(ep, ListenEvents.Error)) return;
    this.logger.info(evt, 'TaskListen:_onError');
    this._relayStreamClosed('disconnected');
    this.notifyTaskDone();
  }

  /**
   * play or say something during the call
   * @param {*} tasks - array of play/say tasks to execute
   */
  async whisper(tasks, callSid) {
    try {
      const cs = this.callSession;
      this.logger.debug('Listen:whisper tasks starting');
      while (tasks.length && !cs.callGone) {
        const task = tasks.shift();
        await task.exec(cs, {ep: this.ep});
      }
      this.logger.debug('Listen:whisper tasks complete');
    } catch (err) {
      this.logger.error(err, 'Listen:whisper error');
    }
  }

}

module.exports = TaskListen;
