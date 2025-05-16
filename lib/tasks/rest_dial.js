const Task = require('./task');
const {TaskName} = require('../utils/constants');
const makeTask = require('./make_task');
const { normalizeJambones } = require('@jambonz/verb-specifications');
const moment = require('moment');

/**
 * Manages an outdial made via REST API
 */
class TaskRestDial extends Task {
  constructor(logger, opts) {
    super(logger, opts);

    this.from = this.data.from;
    this.callerName = this.data.callerName;
    this.timeLimit = this.data.timeLimit;
    this.fromHost = this.data.fromHost;
    this.to = this.data.to;
    this.call_hook = this.data.call_hook;
    this.timeout = this.data.timeout || 60;
    this.sipRequestWithinDialogHook = this.data.sipRequestWithinDialogHook;
    this.referHook = this.data.referHook;
    
    // TESTING ONLY: Hard-coded to true for testing early media connect
    // Will be replaced with this.data.early_media_connect when adding to API
    this.earlyMediaConnect = true;

    this.on('connect', this._onConnect.bind(this));
    this.on('callStatus', this._onCallStatus.bind(this));
    this.on('earlyMedia', (earlyDlg) => this._onEarlyMedia(earlyDlg));
  }

  get name() { return TaskName.RestDial; }

  set appJson(app_json) {
    this.app_json = app_json;
  }

  /**
   * INVITE has just been sent at this point
  */
  async exec(cs) {
    await super.exec(cs);
    this.cs = cs;
    this.canCancel = true;

    if (this.data.amd) {
      this.startAmd = cs.startAmd;
      this.on('amd', this._onAmdEvent.bind(this, cs));
    }
    this.stopAmd = cs.stopAmd;

    this._setCallTimer();
    await this.awaitTaskDone();
  }

  turnOffAmd() {
    if (this.callSession.ep && this.callSession.ep.amd) this.stopAmd(this.callSession.ep, this);
  }

  kill(cs) {
    super.kill(cs);
    this._clearCallTimer();
    if (this.canCancel && !this.earlyMediaConnected) {
      this.canCancel = false;
      cs?.req?.cancel();
    }
    this.notifyTaskDone();
  }

  async _onConnect(dlg) {
    this.canCancel = false;
    const cs = this.callSession;
    
    this.logger.info({
      callSid: cs.callSid,
      earlyMediaConnected: this.earlyMediaConnected,
      hasEndpoint: !!cs.ep
    }, '*** TaskRestDial:_onConnect - CALL CONNECTED ***');
    
    cs.setDialog(dlg);
    cs.referHook = this.referHook;
    if (this.timeLimit) {
      cs.startMaxCallDurationTimer(this.timeLimit);
    }
    this.logger.debug('TaskRestDial:_onConnect - call connected');
    if (this.sipRequestWithinDialogHook) this._initSipRequestWithinDialogHandler(cs, dlg);
    try {
      const b3 = this.getTracingPropagation();
      const httpHeaders = b3 && {b3};
      const params = {
        ...(cs.callInfo.toJSON()),
        defaults: {
          synthesizer: {
            vendor: cs.speechSynthesisVendor,
            language: cs.speechSynthesisLanguage,
            voice: cs.speechSynthesisVoice,
            label: cs.speechSynthesisLabel,
          },
          recognizer: {
            vendor:  cs.speechRecognizerVendor,
            language: cs.speechRecognizerLanguage,
            label: cs.speechRecognizerLabel,
          }
        }
      };
      if (this.startAmd) {
        try {
          this.logger.debug('TaskRestDial:_onConnect - starting AMD after connection');
          this.startAmd(this.callSession, this.callSession.ep, this, this.data.amd);
          this.logger.debug('TaskRestDial:_onConnect - AMD started successfully');
        } catch (err) {
          this.logger.info({err}, 'Rest:dial:Call established - Error calling startAmd');
        }
      }
      let tasks;
      if (this.app_json) {
        this.logger.debug('TaskRestDial: using app_json from task data');
        tasks = JSON.parse(this.app_json);
      } else {
        this.logger.debug({call_hook: this.call_hook}, 'TaskRestDial: retrieving application');
        this.logger.info(`TaskRestDial:_onConnect - sending session:new webhook to ${this.call_hook.url}`);
        tasks = await cs.requestor.request('session:new', this.call_hook, params, httpHeaders);
        this.logger.info({taskCount: tasks?.length || 0}, 'TaskRestDial:_onConnect - received application response');
      }
      if (tasks && Array.isArray(tasks)) {
        this.logger.debug({taskTypes: tasks.map(t => Object.keys(t)[0])}, `TaskRestDial: replacing application with ${tasks.length} tasks`);
        cs.replaceApplication(normalizeJambones(this.logger, tasks).map((tdata) => makeTask(this.logger, tdata)));
        this.logger.info('TaskRestDial:_onConnect - application successfully started');
      }
    } catch (err) {
      this.logger.error({err}, 'TaskRestDial:_onConnect error retrieving or parsing application, ending call');
      this.notifyTaskDone();
    }
  }

  /**
   * Handle early media events - this will be called when we receive a 183 with SDP
   * and earlyMediaConnect is enabled
   * @param {Dialog} earlyDlg - The dialog object from the provisional response
   */
  async _onEarlyMedia(earlyDlg) {
    if (!this.earlyMediaConnect || this.earlyMediaConnected) {
      this.logger.info({
        callSid: this.callSession?.callSid,
        earlyMediaConnect: this.earlyMediaConnect,
        earlyMediaConnected: this.earlyMediaConnected,
        hasEarlyDlg: !!earlyDlg
      }, 'TaskRestDial:_onEarlyMedia - skipping, already connected or feature disabled');
      return;
    }
    
    const cs = this.callSession;
    if (!cs) {
      this.logger.error('TaskRestDial:_onEarlyMedia - callSession is not defined, cannot proceed.');
      return;
    }

    if (!earlyDlg) {
      this.logger.error({callSid: cs.callSid}, 'TaskRestDial:_onEarlyMedia - received null earlyDlg, cannot set up dialog for early media.');
      // Optionally, could decide to not set earlyMediaConnected = true here, or handle as an error
      return;
    }

    this.logger.info({
      callSid: cs.callSid,
      earlyDialogId: earlyDlg.id,
      earlyDialogState: earlyDlg.state
    }, 'TaskRestDial:_onEarlyMedia - Setting up with early dialog');

    // Set the dialog on the call session with the early media dialog
    cs.setDialog(earlyDlg);
    
    // Set connect time as this is when we consider the call connected in early media
    if (cs.dlg) { // cs.dlg should now be earlyDlg
      cs.dlg.connectTime = moment();
      cs.callInfo.answeredTime = cs.dlg.connectTime; // Keep consistent with normal connect
      this.logger.info({
        callSid: cs.callSid,
        connectTime: cs.dlg.connectTime.toISOString(),
        answeredTime: cs.callInfo.answeredTime.toISOString()
      }, 'TaskRestDial:_onEarlyMedia - Set connectTime and answeredTime on early dialog');
    } else {
      this.logger.error({callSid: cs.callSid}, 'TaskRestDial:_onEarlyMedia - cs.dlg is null after setDialog(earlyDlg). This is unexpected.');
      // Not setting earlyMediaConnected to true if dialog setup failed
      return;
    }

    this.earlyMediaConnected = true;
    cs.earlyMediaConnected = true; // Indicate to the call session that we're connected in early media mode
    
    this.logger.info({
      callSid: cs.callSid,
      earlyMediaConnect: this.earlyMediaConnect,
      earlyMediaConnected: cs.earlyMediaConnected,
      hasEndpoint: !!cs.ep,
      dialogId: cs.dlg.id // Log the dialog ID that was set
    }, '*** TaskRestDial:_onEarlyMedia - EARLY MEDIA CONNECT TRIGGERED AND DIALOG SET ***');
    
    try {
      const b3 = this.getTracingPropagation();
      const httpHeaders = b3 && {b3};
      const params = {
        ...(cs.callInfo.toJSON()),
        early_media: true,
        defaults: {
          synthesizer: {
            vendor: cs.speechSynthesisVendor,
            language: cs.speechSynthesisLanguage,
            voice: cs.speechSynthesisVoice,
            label: cs.speechSynthesisLabel,
          },
          recognizer: {
            vendor:  cs.speechRecognizerVendor,
            language: cs.speechRecognizerLanguage,
            label: cs.speechRecognizerLabel,
          }
        }
      };
      
      if (this.startAmd) {
        try {
          this.logger.debug('TaskRestDial:_onEarlyMedia - attempting to start AMD during early media');
          this.startAmd(this.callSession, this.callSession.ep, this, this.data.amd);
          this.logger.debug('TaskRestDial:_onEarlyMedia - successfully started AMD during early media');
        } catch (err) {
          this.logger.info({err}, 'Rest:dial:Early media - Error calling startAmd');
        }
      }
      
      let tasks;
      if (this.app_json) {
        this.logger.debug('TaskRestDial: using app_json from task data in early media');
        tasks = JSON.parse(this.app_json);
      } else {
        this.logger.debug({call_hook: this.call_hook}, 'TaskRestDial: retrieving application in early media');
        this.logger.info(`TaskRestDial:_onEarlyMedia - sending session:new webhook with early_media=true to ${this.call_hook.url}`);
        tasks = await cs.requestor.request('session:new', this.call_hook, params, httpHeaders);
        this.logger.info({taskCount: tasks?.length || 0}, 'TaskRestDial:_onEarlyMedia - received application response');
      }
      
      if (tasks && Array.isArray(tasks)) {
        this.logger.debug({taskTypes: tasks.map(t => Object.keys(t)[0])}, `TaskRestDial: replacing application with ${tasks.length} tasks in early media`);
        cs.replaceApplication(normalizeJambones(this.logger, tasks).map((tdata) => makeTask(this.logger, tdata)));
        this.logger.info('TaskRestDial:_onEarlyMedia - successfully started application in early media state');
      }
    } catch (err) {
      this.logger.error({err}, 'TaskRestDial:_onEarlyMedia error retrieving or parsing application');
      // Don't end the call here, since we're still waiting for the actual connect
    }
  }

  _onCallStatus(status) {
    this.logger.debug(`CallStatus: ${status}`);
    
    // Add more detailed logging
    this.logger.info({
      callSid: this.callSession?.callSid,
      sipStatus: status,
      earlyMediaConnected: this.earlyMediaConnected || false,
      canCancel: this.canCancel
    }, `*** TaskRestDial:_onCallStatus - Received status ${status} ***`);
    
    if (status >= 200) {
      this.canCancel = false;
      this._clearCallTimer();
      if (status !== 200) this.notifyTaskDone();
    }
  }

  _setCallTimer() {
    this.timer = setTimeout(this._onCallTimeout.bind(this), this.timeout * 1000);
  }

  _clearCallTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  _onCallTimeout() {
    this.logger.debug('TaskRestDial: timeout expired without answer, killing task');
    this.timer = null;
    if (this.canCancel) {
      this.canCancel = false;
      this.cs?.req?.cancel();
    }
  }

  _onAmdEvent(cs, evt) {
    this.logger.info({evt}, 'Rest:dial:_onAmdEvent');
    const {actionHook} = this.data.amd;
    this.performHook(cs, actionHook, evt)
      .catch((err) => {
        this.logger.error({err}, 'Rest:dial:_onAmdEvent - error calling actionHook');
      });
  }

  _initSipRequestWithinDialogHandler(cs, dlg) {
    cs.sipRequestWithinDialogHook = this.sipRequestWithinDialogHook;
    dlg.on('info', this._onRequestWithinDialog.bind(this, cs));
    dlg.on('message', this._onRequestWithinDialog.bind(this, cs));
  }

  async _onRequestWithinDialog(cs, req, res) {
    cs._onRequestWithinDialog(req, res);
  }
}

module.exports = TaskRestDial;
