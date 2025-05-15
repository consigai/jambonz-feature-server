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
    // Store the old dialog temporarily
    const oldDlg = this.dlg;
    
    this.logger.debug({
      callSid: this.callSid,
      oldDialogId: oldDlg.id,
      newDialogId: dlg.id,
      hasOldConnectTime: !!oldDlg.connectTime
    }, 'RestCallSession:updateDialog - dialog details');
    
    // Remove listeners from old dialog
    oldDlg.removeAllListeners('destroy');
    oldDlg.removeAllListeners('refer');
    oldDlg.removeAllListeners('modify');
    
    // Set up the new dialog
    this.dlg = dlg;
    dlg.on('destroy', this._callerHungup.bind(this));
    dlg.on('refer', this._onRefer.bind(this));
    dlg.on('modify', this._onReinvite.bind(this));
    this.wrapDialog(dlg);
    
    // Set the connect time if this is the first real dialog
    if (!oldDlg.connectTime) {
      dlg.connectTime = moment();
      this.logger.info({
        callSid: this.callSid,
        connectTime: dlg.connectTime.toISOString()
      }, 'RestCallSession:updateDialog - setting new connect time on dialog');
    } else {
      // Copy the connect time from the early media dialog
      dlg.connectTime = oldDlg.connectTime;
      this.logger.info({
        callSid: this.callSid,
        connectTime: dlg.connectTime.toISOString()
      }, 'RestCallSession:updateDialog - copying connect time from early media dialog');
    }
    
    this.logger.info({
      callSid: this.callSid,
      oldDialogId: oldDlg.id,
      newDialogId: dlg.id
    }, '*** RestCallSession:updateDialog - DIALOG UPDATED FROM EARLY MEDIA TO CONNECTED CALL ***');
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
