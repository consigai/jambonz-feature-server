/**
 * CONSIG: BEEP-DETECT. This whole file is Consig's (it does not exist upstream).
 *
 * Purpose: background beep (voicemail tone) detection on the call endpoint with FreeSWITCH AVMD, driven
 * by the `beep` option of the config verb. Each beep is emitted as a 'beep' event on the config task,
 * which sends it to beep.actionHook (lib/tasks/config.js _onBeepEvent).
 * Why a separate file: lib/tasks/config.js only calls startBeep / stopBeep.
 * Called by: lib/tasks/config.js (exec).
 * Needs: the config.beep property in the @jambonz/verb-specifications fork (VERB-SPEC-PIN).
 *
 * Invariants:
 * - One detector per call: activeBeepDetectors is keyed by callSid and startBeep returns early if the
 *   call already has one. Two detectors on one channel produced duplicate events.
 * - FreeSWITCH sometimes sends the same beep twice; onBeep keeps only events whose Event-Sequence is
 *   greater than task.beep.lastEvent. Do not remove that check.
 * - AVMD sends one event per start, so onBeep stops the detector first and restarts it only when
 *   beep.sticky is set.
 * - stopBeep calls ep.removeCustomEventListener(AvmdEvents.Beep) without a handler, which removes every
 *   listener for that event on the endpoint. lib/utils/amd-utils.js (upstream's answering machine
 *   detection) also listens for AvmdEvents.Beep, so stopping the beep detector can remove AMD's
 *   listener too. Not verified whether the two are ever run on one call.
 * - Tests: none in test/ drive this file (test/scenarios has voicemail and beep audio for manual runs).
 */
const {
  AmdEvents,
  AvmdEvents
} = require('./constants');

const activeBeepDetectors = new Set(); // Keep track of active call session IDs

module.exports = (logger) => {
  // Beep handler
  const onBeep = (cs, ep, task, evt, fsEvent) => {
    // Grab the event serial number
    const eventSeq = fsEvent.getHeader('Event-Sequence');

    // make sure the serial number is greater then the last event we sent
    if (eventSeq > task.beep.lastEvent) {
      logger.debug({evt, fsEvent}, `onBeep - ${eventSeq}`);
      task.beep.lastEvent = eventSeq;

      // Extract a few key values out of the free switch event that we will send on the hook
      const frequency = Math.floor(fsEvent.getHeader('Frequency'));
      const variance = Math.floor(fsEvent.getHeader('Frequency-variance'));

      // Stop the beep engine - AVMD only will send a single event so might as well kill
      stopBeep(cs, ep);

      // send the event
      task.emit('beep', {type: AmdEvents.ToneDetected, frequency, variance});

      // if we were asked to be sticky, restart the detector
      if (task.data.beep.sticky) {
        startBeep(cs, ep, task);
      }
    } else {
      // We already saw the event so don't send again. This happens for some reason in
      // freeswitch where we get two versions of the event.
      logger.info(`onBeep - dup event ${eventSeq}`);
    }
  };

  const startBeep = async(cs, ep, task) => {
    const callSid = cs.callSid; // Retrieve the call session ID
    if (activeBeepDetectors.has(callSid)) {
      logger.info(`Beep detector already active for callSid: ${callSid}`);
      return;
    }

    logger.info(`Starting beep detector for callSid: ${callSid}`);
    activeBeepDetectors.add(callSid);

    // Default options for AVMD
    const defaultOptions = {
      inbound_channel: 1,
      outbound_channel: 1,
    };

    // Merge user-provided options with defaults
    const mergedOptions = { ...defaultOptions, ...task.data.beep.options };
    const optionString = Object.entries(mergedOptions)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');

    logger.info(`startBeep - ${optionString}`);
    try {
      ep.addCustomEventListener(AvmdEvents.Beep, onBeep.bind(null, cs, ep, task));
      await ep.execute('avmd_start', optionString);
    } catch (err) {
      logger.error(err, `Error starting AVMD for callSid: ${callSid}`);
      activeBeepDetectors.delete(callSid); // Cleanup if there was an error
    }
  };

  const stopBeep = (cs, ep) => {
    const callSid = cs.callSid; // Retrieve the call session ID
    logger.info(`Stopping beep detector for callSid: ${callSid}`);

    if (activeBeepDetectors.has(callSid)) {
      activeBeepDetectors.delete(callSid); // Remove from active detectors
    } else {
      logger.info(`No active beep detector found for callSid: ${callSid}`);
    }

    if (ep.connected) {
      // CONSIG: known defect, not fixed here (docs-only change): `this` is not the logger in this arrow
      // function, so a failed avmd_stop would throw inside the catch handler. Use `logger`.
      ep.execute('avmd_stop').catch((err) => this.logger.info(err, 'Error stopping avmd'));
    }
    ep.removeCustomEventListener(AvmdEvents.Beep);
  };

  return {startBeep, stopBeep};
};
