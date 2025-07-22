const test = require('tape');
const sinon = require('sinon');
const SbcHealthMonitor = require('../lib/utils/sbc-health-monitor');

// =============================================================================
// Standalone SBC Health Monitor Tests
// =============================================================================

test('SBC Health Monitor - basic functionality', (t) => {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {}
  };

  const monitor = new SbcHealthMonitor(logger, {
    enabled: true,
    maxFailedPings: 2,
    timeoutMs: 100,
    preventLastSbcRemoval: true
  });

  // Test successful ping
  monitor.beforePing('192.168.1.100:5060');
  monitor.onPingResponse('192.168.1.100:5060', 200);
  
  let status = monitor.getHealthStatus();
  t.equals(Object.keys(status).length, 0, 'No failures recorded for successful ping');

  // Test failed ping
  monitor.beforePing('192.168.1.100:5060');
  monitor.onPingError('192.168.1.100:5060', new Error('timeout'));
  
  status = monitor.getHealthStatus();
  t.equals(status['192.168.1.100:5060'].failures, 1, 'One failure recorded');
  t.equals(status['192.168.1.100:5060'].healthy, true, 'Still healthy after one failure');

  // Second failure should mark for removal
  monitor.beforePing('192.168.1.100:5060');
  monitor.onPingError('192.168.1.100:5060', new Error('timeout'));
  
  const toRemove = monitor.getSbcsToRemove();
  t.equals(toRemove.length, 1, 'SBC marked for removal after max failures');
  t.equals(toRemove[0], '192.168.1.100:5060', 'Correct SBC marked for removal');

  monitor.cleanup();
  t.end();
});

test('SBC Health Monitor - last SBC protection', async (t) => {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {}
  };

  const monitor = new SbcHealthMonitor(logger, {
    enabled: true,
    maxFailedPings: 1,
    preventLastSbcRemoval: true
  });

  const sbcList = ['192.168.1.100:5060']; // Only one SBC
  const mockRemoveFromSet = async () => {};

  const result = await monitor.removeUnhealthySbc('192.168.1.100:5060', sbcList, mockRemoveFromSet);
  
  t.equals(result.removed, false, 'Last SBC not removed');
  t.equals(result.reason, 'last_sbc_protection', 'Correct reason for not removing');
  t.equals(sbcList.length, 1, 'SBC list unchanged');

  monitor.cleanup();
  t.end();
});

test('SBC Health Monitor - recovery after failures', (t) => {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {}
  };

  const monitor = new SbcHealthMonitor(logger, {
    enabled: true,
    maxFailedPings: 3,
    timeoutMs: 100
  });

  const sbc = '192.168.1.100:5060';

  // Record two failures
  monitor.onPingError(sbc, new Error('timeout'));
  monitor.onPingError(sbc, new Error('timeout'));
  
  let status = monitor.getHealthStatus();
  t.equals(status[sbc].failures, 2, 'Two failures recorded');

  // Successful ping should reset counter
  monitor.onPingResponse(sbc, 200);
  
  status = monitor.getHealthStatus();
  t.equals(Object.keys(status).length, 0, 'Failures cleared after successful ping');

  monitor.cleanup();
  t.end();
});

test('SBC Health Monitor - disabled mode', (t) => {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {}
  };

  const monitor = new SbcHealthMonitor(logger, {
    enabled: false
  });

  // Should not track anything when disabled
  monitor.onPingError('192.168.1.100:5060', new Error('timeout'));
  monitor.onPingError('192.168.1.100:5060', new Error('timeout'));
  
  const status = monitor.getHealthStatus();
  t.equals(Object.keys(status).length, 0, 'No tracking when disabled');
  
  const toRemove = monitor.getSbcsToRemove();
  t.equals(toRemove.length, 0, 'No SBCs marked for removal when disabled');

  monitor.cleanup();
  t.end();
});

test('SBC Health Monitor - timeout handling', (t) => {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {}
  };

  const monitor = new SbcHealthMonitor(logger, {
    enabled: true,
    maxFailedPings: 2,
    timeoutMs: 50
  });

  const sbc = '192.168.1.100:5060';

  // Start ping and let it timeout
  monitor.beforePing(sbc);
  
  // Wait for timeout + buffer
  setTimeout(() => {
    const status = monitor.getHealthStatus();
    t.equals(status[sbc].failures, 1, 'Timeout recorded as failure');
    t.equals(status[sbc].lastFailureReason, 'timeout', 'Timeout reason recorded');
    
    monitor.cleanup();
    t.end();
  }, 100);
});

test('SBC Health Monitor - multiple SBC removal safety', async (t) => {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {}
  };

  const monitor = new SbcHealthMonitor(logger, {
    enabled: true,
    maxFailedPings: 1,
    preventLastSbcRemoval: true
  });

  const sbcList = ['192.168.1.100:5060', '192.168.1.101:5060'];
  const mockRemoveFromSet = sinon.stub().resolves();

  // Remove first SBC - should succeed
  const result1 = await monitor.removeUnhealthySbc('192.168.1.100:5060', sbcList, mockRemoveFromSet);
  t.equals(result1.removed, true, 'First SBC removed successfully');
  t.equals(sbcList.length, 1, 'One SBC remaining in list');

  // Try to remove last SBC - should be protected
  const result2 = await monitor.removeUnhealthySbc('192.168.1.101:5060', sbcList, mockRemoveFromSet);
  t.equals(result2.removed, false, 'Last SBC protected from removal');
  t.equals(result2.reason, 'last_sbc_protection', 'Correct protection reason');
  t.equals(sbcList.length, 1, 'Last SBC still in list');

  monitor.cleanup();
  t.end();
});

// =============================================================================
// Integration Tests with SBC Pinger
// =============================================================================

const mockConfig = {
  JAMBONES_SBCS: null,
  K8S: false,
  K8S_SBC_SIP_SERVICE_NAME: null,
  AWS_SNS_TOPIC_ARN: null,
  OPTIONS_PING_INTERVAL: 60000,
  AWS_REGION: null,
  NODE_ENV: 'test',
  JAMBONES_CLUSTER_ID: 'test',
  SBC_MAX_FAILED_PINGS: '3',
  SBC_HEALTH_CHECK_ENABLED: true,
  SBC_PING_TIMEOUT_MS: '1000'
};

const createMockSrf = () => ({
  request: sinon.stub(),
  locals: {
    dbHelpers: {
      removeFromSet: sinon.stub().resolves(),
      monitorSet: sinon.stub()
    },
    getFreeswitch: sinon.stub().returns({}),
    sessionTracker: { count: 0 },
    serviceUrl: 'http://test:3000'
  }
});

test('SBC Pinger Integration - health monitor initialization', async (t) => {
  const mockLogger = {
    info: sinon.stub(),
    warn: sinon.stub(),
    error: sinon.stub()
  };

  // Mock the config require
  const Module = require('module');
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function(...args) {
    if (args[0] === '../config') {
      return mockConfig;
    }
    return originalRequire.apply(this, args);
  };

  try {
    // Require the module after mocking
    const sbcPinger = require('../lib/utils/sbc-pinger')(mockLogger);
    
    t.ok(sbcPinger, 'SBC pinger module loaded successfully');
    t.ok(sbcPinger.healthMonitor, 'Health monitor exposed for debugging');
    t.equals(typeof sbcPinger.cleanup, 'function', 'Cleanup function available');
    
    // Cleanup
    if (sbcPinger.cleanup) {
      sbcPinger.cleanup();
    }
    
  } catch (err) {
    t.fail(`Failed to initialize SBC pinger with health monitoring: ${err.message}`);
  } finally {
    // Restore require
    Module.prototype.require = originalRequire;
  }

  t.end();
});

test('SBC Pinger Integration - configuration validation', async (t) => {
  const mockLogger = { info: () => {}, warn: () => {}, error: () => {} };

  // Test with disabled health monitoring
  const disabledConfig = {
    ...mockConfig,
    SBC_HEALTH_CHECK_ENABLED: false
  };

  const Module = require('module');
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function(...args) {
    if (args[0] === '../config') {
      return disabledConfig;
    }
    return originalRequire.apply(this, args);
  };

  try {
    const sbcPinger = require('../lib/utils/sbc-pinger')(mockLogger);
    
    // Health monitor should still exist but be disabled
    if (sbcPinger.healthMonitor) {
      t.equals(sbcPinger.healthMonitor.enabled, false, 'Health monitoring properly disabled');
    }
    
    if (sbcPinger.cleanup) {
      sbcPinger.cleanup();
    }
    
  } catch (err) {
    t.fail(`Failed with disabled config: ${err.message}`);
  } finally {
    Module.prototype.require = originalRequire;
  }

  t.end();
});

test('SBC Pinger Integration - configuration edge cases', async (t) => {
  const mockLogger = { info: () => {}, warn: () => {}, error: () => {} };

  // Test with edge case configurations
  const edgeConfig = {
    ...mockConfig,
    SBC_MAX_FAILED_PINGS: 'invalid',  // Should fallback to default
    SBC_PING_TIMEOUT_MS: '0',         // Should fallback to default
    JAMBONES_CLUSTER_ID: ''           // Should fallback to 'default'
  };

  const Module = require('module');
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function(...args) {
    if (args[0] === '../config') {
      return edgeConfig;
    }
    return originalRequire.apply(this, args);
  };

  try {
    const sbcPinger = require('../lib/utils/sbc-pinger')(mockLogger);
    
    t.ok(sbcPinger, 'SBC pinger handles invalid config gracefully');
    
    if (sbcPinger.cleanup) {
      sbcPinger.cleanup();
    }
    
  } catch (err) {
    t.fail(`Failed with edge case config: ${err.message}`);
  } finally {
    Module.prototype.require = originalRequire;
  }

  t.end();
});

// Cleanup test - ensures no resource leaks
test('Cleanup test - no resource leaks', (t) => {
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  
  const monitor = new SbcHealthMonitor(logger, {
    enabled: true,
    maxFailedPings: 1,
    timeoutMs: 100
  });

  // Create some timeouts
  monitor.beforePing('192.168.1.100:5060');
  monitor.beforePing('192.168.1.101:5060');
  
  // Cleanup should clear all timeouts
  const beforeCleanup = monitor.pendingTimeouts.size;
  monitor.cleanup();
  const afterCleanup = monitor.pendingTimeouts.size;
  
  t.ok(beforeCleanup > 0, 'Timeouts were created');
  t.equals(afterCleanup, 0, 'All timeouts cleared on cleanup');
  
  t.end();
}); 