const CallSession = require('./call-session');
const {CallStatus} = require('../utils/constants');
const moment = require('moment');
/**
 * @classdesc Subclass of CallSession.  This represents a CallSession that is
 * created for an outbound call that is initiated via the REST API.
 * @extends CallSession
 */
class RestCallSession extends CallSession {
  constructor({logger, application, srf, req, ep, ep2, tasks, callInfo, accountInfo, rootSpan}) {
    super({
      logger,
      application,
      srf,
      callSid: callInfo.callSid,
      tasks,
      callInfo,
      accountInfo,
      rootSpan
    });
    this.req = req;
    this.ep = ep;
    this.ep2 = ep2;
    // keep restDialTask reference for closing AMD
    if (tasks.length) {
      this.restDialTask = tasks[0];
    }

    // Track early media connection state
    this.earlyMediaConnected = false;
    this.sessionNewSent = false;
    this.callMoved = false;

    this.logger.debug({
      callSid: this.callSid,
      earlyMediaConnected: this.earlyMediaConnected,
      tasksCount: tasks ? tasks.length : 0
    }, 'RestCallSession: constructor initialized');

    this.on('callStatusChange', this._notifyCallStatusChange.bind(this));
    this._notifyCallStatusChange({
      callStatus: CallStatus.Trying,
      sipStatus: 100,
      sipReason: 'Trying'
    });
  }

  /**
   * Stores the sip dialog that is created when the far end answers.
   * @param {Dialog} dlg - sip dialog
   */
  setDialog(dlg) {
    // If we already have a dialog, we're transitioning from early media to connected
    if (this.dlg) {
      this.logger.info({
        callSid: this.callSid,
        oldDialogId: this.dlg.id,
        newDialogId: dlg.id,
        earlyMediaConnected: this.earlyMediaConnected
      }, '*** RestCallSession:setDialog - Transitioning from early media to connected call. Calling updateDialog. ***');
      this.updateDialog(dlg);
      return;
    }

    this.logger.info({
      callSid: this.callSid,
      dialogId: dlg ? dlg.id : 'N/A',
      earlyMediaConnected: this.earlyMediaConnected,
      dlgSip: dlg ? dlg.sip : null,
      dlgLocalUri: dlg && dlg.local && dlg.local.uri ? dlg.local.uri : 'N/A',
      dlgRemoteUri: dlg && dlg.remote && dlg.remote.uri ? dlg.remote.uri : 'N/A',
      dlgCallingNumber: dlg ? dlg.callingNumber : 'N/A',
      dlgCalledNumber: dlg ? dlg.calledNumber : 'N/A'
    }, '*** RestCallSession:setDialog - INITIAL DIALOG SETUP ***');
    
    this.dlg = dlg;
    this.logger.debug({ callSid: this.callSid, dialogId: this.dlg.id }, 'RestCallSession:setDialog - Attaching initial listeners');
    dlg.on('destroy', this._callerHungup.bind(this));
    dlg.on('refer', this._onRefer.bind(this));
    dlg.on('modify', this._onReinvite.bind(this));
    this.logger.debug({ callSid: this.callSid, dialogId: this.dlg.id }, 'RestCallSession:setDialog - Listeners attached');
    this.wrapDialog(dlg);
  }

  /**
   * Updates the dialog when transitioning from early media to connected state
   * @param {Dialog} dlg - the new SIP dialog from the 200 OK
   */
  updateDialog(dlg) {
    const oldDlg = this.dlg; // The dialog from early media

    this.logger.info({
      callSid: this.callSid,
      oldDialogId: oldDlg ? oldDlg.id : 'N/A',
      oldDialogLocalUri: oldDlg && oldDlg.local && oldDlg.local.uri ? oldDlg.local.uri : 'N/A',
      oldDialogRemoteUri: oldDlg && oldDlg.remote && oldDlg.remote.uri ? oldDlg.remote.uri : 'N/A',
      oldDialogSdp: oldDlg && oldDlg.remote && oldDlg.remote.sdp ? oldDlg.remote.sdp.substring(0, 50) + '...' : 'N/A',
      newDialogId: dlg ? dlg.id : 'N/A',
      newDialogLocalUri: dlg && dlg.local && dlg.local.uri ? dlg.local.uri : 'N/A',
      newDialogRemoteUri: dlg && dlg.remote && dlg.remote.uri ? dlg.remote.uri : 'N/A',
      newDialogSdp: dlg && dlg.remote && dlg.remote.sdp ? dlg.remote.sdp.substring(0, 50) + '...' : 'N/A',
      areDialogObjectsSame: oldDlg === dlg,
      oldConnectTime: oldDlg && oldDlg.connectTime ? oldDlg.connectTime.toISOString() : null
    }, 'RestCallSession:updateDialog - Transitioning from early media to 200 OK');

    if (!dlg) {
      this.logger.error('RestCallSession:updateDialog - Received null dialog for 200 OK, cannot update.');
      // Potentially hang up or error out, as this is an invalid state
      this._callerHungup(); // Or some other error handling
      return;
    }

    // Remove listeners from the old (early media) dialog
    if (oldDlg && oldDlg !== dlg) {
      this.logger.debug({callSid: this.callSid, oldDialogId: oldDlg.id}, 'RestCallSession:updateDialog - Removing listeners from old dialog');
      oldDlg.removeAllListeners('destroy');
      oldDlg.removeAllListeners('refer');
      oldDlg.removeAllListeners('modify');
      this.logger.debug({callSid: this.callSid, oldDialogId: oldDlg.id}, 'RestCallSession:updateDialog - Listeners removed from old dialog');
    }

    this.logger.debug({callSid: this.callSid, currentDlgId: this.dlg ? this.dlg.id : 'N/A'}, 'RestCallSession:updateDialog - State of this.dlg BEFORE assignment');
    // Assign the new dialog from 200 OK as the current dialog
    this.dlg = dlg;
    this.logger.debug({callSid: this.callSid, newAssignedDlgId: this.dlg.id}, 'RestCallSession:updateDialog - State of this.dlg AFTER assignment');

    // Attach listeners to the new dialog
    this.logger.debug({callSid: this.callSid, newDialogId: this.dlg.id}, 'RestCallSession:updateDialog - Attaching listeners to new dialog');
    this.dlg.on('destroy', this._callerHungup.bind(this));
    this.dlg.on('refer', this._onRefer.bind(this));
    this.dlg.on('modify', this._onReinvite.bind(this));
    this.logger.debug({callSid: this.callSid, newDialogId: this.dlg.id}, 'RestCallSession:updateDialog - Listeners attached to new dialog');
    
    // Wrap the new dialog (e.g., for custom properties or methods)
    this.logger.debug({callSid: this.callSid, dialogId: this.dlg.id}, 'RestCallSession:updateDialog - Calling wrapDialog');
    this.wrapDialog(this.dlg);

    // Preserve connect time: If early media established a connectTime, use it.
    // Otherwise, set it now based on the 200 OK.
    this.logger.debug({
      callSid: this.callSid,
      oldDlgConnectTime: oldDlg && oldDlg.connectTime ? oldDlg.connectTime.toISOString() : 'N/A',
      currentThisDlgConnectTime: this.dlg.connectTime ? this.dlg.connectTime.toISOString() : 'N/A'
    }, 'RestCallSession:updateDialog - About to determine connectTime');

    if (oldDlg && oldDlg.connectTime) {
      this.dlg.connectTime = oldDlg.connectTime;
      this.logger.info({
        callSid: this.callSid,
        connectTime: this.dlg.connectTime.toISOString()
      }, 'RestCallSession:updateDialog - Preserved connectTime from early media dialog');
    } else if (!this.dlg.connectTime) {
      this.dlg.connectTime = moment();
      this.logger.info({
        callSid: this.callSid,
        connectTime: this.dlg.connectTime.toISOString()
      }, 'RestCallSession:updateDialog - Setting new connectTime on 200 OK dialog');
    } else {
       this.logger.info({
        callSid: this.callSid,
        connectTime: this.dlg.connectTime.toISOString()
      }, 'RestCallSession:updateDialog - ConnectTime already present on 200 OK dialog (unexpected)');
    }
    
    // Ensure remote SDP is up-to-date on the new dialog reference
    if (dlg.remote && dlg.remote.sdp) {
      this.logger.debug({callSid: this.callSid, newSdp: dlg.remote.sdp.substring(0,50) + '...'}, 'RestCallSession:updateDialog - Updating lastSdp from new dialog');
      this.dlg.lastSdp = dlg.remote.sdp;
    }

    this.logger.info({
      callSid: this.callSid,
      dialogId: this.dlg.id,
      connectTime: this.dlg.connectTime ? this.dlg.connectTime.toISOString() : 'N/A'
    }, '*** RestCallSession:updateDialog - SUCCESSFULLY UPDATED TO NEW DIALOG FOR 200 OK ***');
  }

  /**
   * This is invoked when the called party hangs up, in order to calculate the call duration.
   */
  _callerHungup() {
    this.logger.debug({ callSid: this.callSid, dialogId: this.dlg ? this.dlg.id : 'N/A' }, 'RestCallSession:_callerHungup - Entered');
    this._hangup('caller');
  }

  _jambonzHangup() {
    this.logger.debug({ callSid: this.callSid, dialogId: this.dlg ? this.dlg.id : 'N/A' }, 'RestCallSession:_jambonzHangup - Entered');
    this._hangup();
  }

  _hangup(terminatedBy = 'jambonz') {
    this.logger.debug({ callSid: this.callSid, terminatedBy, dialogId: this.dlg ? this.dlg.id : 'N/A' }, 'RestCallSession:_hangup - Entered');
    if (this.restDialTask) {
      this.logger.debug({ callSid: this.callSid }, 'RestCallSession:_hangup - Turning off AMD');
      this.restDialTask.turnOffAmd();
    }
    this.callInfo.callTerminationBy = terminatedBy;
    const connectTimeForDuration = this.dlg && this.dlg.connectTime ? this.dlg.connectTime : this.callInfo.answeredTime;
    
    this.logger.debug({
      callSid: this.callSid,
      dlgConnectTime: this.dlg && this.dlg.connectTime ? this.dlg.connectTime.toISOString() : 'N/A',
      callInfoAnsweredTime: this.callInfo.answeredTime ? this.callInfo.answeredTime.toISOString() : 'N/A',
      usingConnectTime: connectTimeForDuration ? connectTimeForDuration.toISOString() : 'N/A'
    }, 'RestCallSession:_hangup - Determining connect time for duration calculation');

    const duration = connectTimeForDuration ? moment().diff(connectTimeForDuration, 'seconds') : 0;
    
    this.logger.debug({ callSid: this.callSid, duration, terminatedBy }, 'RestCallSession:_hangup - Calculated duration');

    this.emit('callStatusChange', {callStatus: CallStatus.Completed, duration});
    this.logger.info(`RestCallSession: called party hung up by ${terminatedBy}, duration ${duration}s`);
    this._callReleased();
  }
}

module.exports = RestCallSession;
