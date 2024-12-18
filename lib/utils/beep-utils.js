const {
  AmdEvents,
  AvmdEvents
} = require('./constants');

module.exports = (logger) => {
  const onBeep = (cs, ep, task, evt, fsEvent) => {
    logger.info('onBeep');
    logger.debug({evt, fsEvent}, 'onBeep');
    const frequency = Math.floor(fsEvent.getHeader('Frequency'));
    const variance = Math.floor(fsEvent.getHeader('Frequency-variance'));
    stopBeep(ep, task);
    task.emit('beep', {type: AmdEvents.ToneDetected, frequency, variance});
  };

  const startBeep = async(cs, ep, task) => {
    logger.info('startBeep');
    ep.addCustomEventListener(AvmdEvents.Beep, onBeep.bind(null, cs, ep, task));
    ep.execute('avmd_start', 'inbound_channel=1,outbound_channel=1')
      .catch((err) => this.logger.info(err, 'Error starting avmd'));
  };

  const stopBeep = (ep, task) => {
    logger.info('stopBeep');
    if (ep.connected) {
      ep.execute('avmd_stop').catch((err) => this.logger.info(err, 'Error stopping avmd'));
    }
    ep.removeCustomEventListener(AvmdEvents.Beep);
  };

  return {startBeep, stopBeep};
};
