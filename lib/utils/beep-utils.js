const {
  AmdEvents,
  AvmdEvents
} = require('./constants');

const activeBeepDetectors = new Set(); // Keep track of active call session IDs

module.exports = (logger) => {
  const onBeep = (cs, ep, task, evt, fsEvent) => {
    logger.info('onBeep');
    logger.debug({evt, fsEvent}, 'onBeep');
    const frequency = Math.floor(fsEvent.getHeader('Frequency'));
    const variance = Math.floor(fsEvent.getHeader('Frequency-variance'));
    stopBeep(ep, cs);
    task.emit('beep', {type: AmdEvents.ToneDetected, frequency, variance});
  };

  const startBeep = async(cs, ep, task, options = {}) => {
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
    const mergedOptions = { ...defaultOptions, ...options };
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

  const stopBeep = (ep, cs) => {
    const callSid = cs.callSid; // Retrieve the call session ID
    logger.info(`Stopping beep detector for callSid: ${callSid}`);

    if (activeBeepDetectors.has(callSid)) {
      activeBeepDetectors.delete(callSid); // Remove from active detectors
    } else {
      logger.info(`No active beep detector found for callSid: ${callSid}`);
    }

    if (ep.connected) {
      ep.execute('avmd_stop').catch((err) => this.logger.info(err, 'Error stopping avmd'));
    }
    ep.removeCustomEventListener(AvmdEvents.Beep);
  };

  return {startBeep, stopBeep};
};
