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
      }, '*** RestCallSession:setDialog - TRANSITIONING FROM EARLY MEDIA TO CONNECTED CALL ***');
      this.updateDialog(dlg);
      return;
    }

    this.logger.info({
      callSid: this.callSid,
      dialogId: dlg.id,
      earlyMediaConnected: this.earlyMediaConnected
    }, '*** RestCallSession:setDialog - INITIAL DIALOG SETUP ***');
    
    this.dlg = dlg;
    dlg.on('destroy', this._callerHungup.bind(this));
    dlg.on('refer', this._onRefer.bind(this));
    dlg.on('modify', this._onReinvite.bind(this));
    this.wrapDialog(dlg);
  }

  /**
   * Updates the dialog when transitioning from early media to connected state
   * @param {Dialog} dlg - the new SIP dialog
   */
  updateDialog(dlg) {
    // 'this.dlg' is the dialog established during early media (e.g., from this.srf.createDialog(prov)).
    // 'dlg' is the argument from the 200 OK (e.g., what srf.createUAC resolved with).
    // We assume drachtio-srf updates the original this.dlg instance in-place,
    // or if 'dlg' is a new object, it contains the final state information.
    // The key is to preserve this.dlg as the primary reference.

    this.logger.debug({
      callSid: this.callSid,
      currentDialogId: this.dlg.id,
      finalDialogObjectId: dlg ? dlg.id : null,
      areDialogObjectsSame: this.dlg === dlg,
      currentConnectTime: this.dlg.connectTime ? this.dlg.connectTime.toISOString() : null,
      currentLastSdp: this.dlg.lastSdp
    }, 'RestCallSession:updateDialog - received 200 OK, ensuring connect time and status on existing dialog');

    // Listeners and wrapping were done when this.dlg was first set (on early media via the initial setDialog call).
    // No need to remove listeners, re-assign this.dlg, or re-wrap if we are using the same dialog object.

    // Ensure connectTime is set on the existing this.dlg.
    if (!this.dlg.connectTime) {
      this.dlg.connectTime = moment();
      this.logger.info({
        callSid: this.callSid,
        connectTime: this.dlg.connectTime.toISOString()
      }, 'RestCallSession:updateDialog - setting connect time on dialog from 200 OK');
    } else {
      this.logger.info({
        callSid: this.callSid,
        connectTime: this.dlg.connectTime.toISOString()
      }, 'RestCallSession:updateDialog - connect time was already set on dialog');
    }

    // Update lastSdp on this.dlg if it has changed with the 200 OK.
    // 'dlg' (finalDialogData from 200 OK) should have the authoritative remote SDP.
    const newRemoteSdp = dlg && dlg.remote && dlg.remote.sdp ? dlg.remote.sdp : null;
    if (newRemoteSdp && this.dlg.lastSdp !== newRemoteSdp) {
      this.logger.info({callSid: this.callSid}, 'RestCallSession:updateDialog - updating lastSdp from 200 OK data');
      this.dlg.lastSdp = newRemoteSdp;
    } else if (!newRemoteSdp && this.dlg.remote && this.dlg.remote.sdp && this.dlg.lastSdp !== this.dlg.remote.sdp) {
      // Fallback: if dlg didn't provide sdp but this.dlg itself was updated in-place by srf
      this.logger.info({callSid: this.callSid}, 'RestCallSession:updateDialog - refreshing lastSdp from current dialog remoteSdp after 200 OK');
      this.dlg.lastSdp = this.dlg.remote.sdp;
    }

    this.logger.info({
      callSid: this.callSid,
      dialogId: this.dlg.id, // Should still be the original dialog's ID
      connectTime: this.dlg.connectTime.toISOString()
    }, '*** RestCallSession:updateDialog - DIALOG STATE CONFIRMED for 200 OK (using original dialog object) ***');
  }

  /**
   * This is invoked when the called party hangs up, in order to calculate the call duration.
   */
  _callerHungup() {
    this._hangup('caller');
  }

  _jambonzHangup() {
    this._hangup();
  }

  _hangup(terminatedBy = 'jambonz') {
    if (this.restDialTask) {
      this.restDialTask.turnOffAmd();
    }
    this.callInfo.callTerminationBy = terminatedBy;
    const duration = moment().diff(this.dlg.connectTime, 'seconds');
    this.emit('callStatusChange', {callStatus: CallStatus.Completed, duration});
    this.logger.info(`RestCallSession: called party hung up by ${terminatedBy}`);
    this._callReleased();
  }
}

module.exports = RestCallSession;
