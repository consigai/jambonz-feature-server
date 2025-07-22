const debug = require('debug')('jambonz:sbc-health-monitor');

/**
 * External SBC Health Monitoring Module
 * 
 * This module provides health tracking and automatic cleanup for SBCs
 * without requiring major changes to the existing sbc-pinger implementation.
 */
class SbcHealthMonitor {
  constructor(logger, config = {}) {
    this.logger = logger || { info: () => {}, warn: () => {}, error: () => {} };
    
    // Configuration with safe defaults
    this.enabled = config.enabled !== false; // Default to enabled
    this.maxFailedPings = parseInt(config.maxFailedPings) || 3;
    this.timeoutMs = parseInt(config.timeoutMs) || 5000;
    this.preventLastSbcRemoval = config.preventLastSbcRemoval !== false; // Default to safe
    this.clusterId = config.clusterId || 'default';
    
    // Internal state
    this.healthTracker = new Map(); // SBC -> failure count
    this.pendingTimeouts = new Map(); // SBC -> timeout handle
    
    this.logger.info({
      enabled: this.enabled,
      maxFailedPings: this.maxFailedPings,
      timeoutMs: this.timeoutMs,
      preventLastSbcRemoval: this.preventLastSbcRemoval
    }, 'SBC Health Monitor initialized');
  }

  /**
   * Called before sending OPTIONS ping to an SBC
   * Sets up timeout handling for the ping
   */
  beforePing(sbc) {
    if (!this.enabled) return null;
    
    // Clear any existing timeout for this SBC
    this.clearTimeout(sbc);
    
    // Set up timeout for this ping
    const timeoutHandle = setTimeout(() => {
      const result = this.handleFailedPing(sbc, 'timeout');
      // Timeout failures will be picked up by getSbcsToRemove()
    }, this.timeoutMs);
    
    this.pendingTimeouts.set(sbc, timeoutHandle);
    
    return timeoutHandle;
  }

  /**
   * Called when OPTIONS ping gets a response
   * Clears timeout and handles success/failure
   */
  onPingResponse(sbc, statusCode) {
    if (!this.enabled) return;
    
    this.clearTimeout(sbc);
    
    if (statusCode >= 200 && statusCode < 300) {
      this.handleSuccessfulPing(sbc);
    } else {
      this.handleFailedPing(sbc, `status_${statusCode}`);
    }
  }

  /**
   * Called when OPTIONS ping encounters an error
   */
  onPingError(sbc, error) {
    if (!this.enabled) return;
    
    this.clearTimeout(sbc);
    this.handleFailedPing(sbc, error.message || 'unknown_error');
  }

  /**
   * Handle successful ping - reset failure counter
   */
  handleSuccessfulPing(sbc) {
    if (this.healthTracker.has(sbc)) {
      const prevFailures = this.healthTracker.get(sbc);
      this.healthTracker.delete(sbc);
      
      if (prevFailures > 0) {
        this.logger.info(`SBC ${sbc} back online after ${prevFailures} failed pings`);
      }
    }
  }

  /**
   * Handle failed ping - increment counter and check threshold
   */
  handleFailedPing(sbc, reason) {
    const failedCount = (this.healthTracker.get(sbc) || 0) + 1;
    this.healthTracker.set(sbc, failedCount);
    
    this.logger.warn(`SBC ${sbc} failed ping ${failedCount}/${this.maxFailedPings} (reason: ${reason})`);
    
    if (failedCount >= this.maxFailedPings) {
      // Mark for removal but don't emit immediately
      this.healthTracker.set(sbc, failedCount + 1000); // Flag as needing removal
      return { shouldRemove: true, failedCount, reason };
    }
    
    return { shouldRemove: false, failedCount, reason };
  }

  /**
   * Get list of SBCs that should be removed due to health failures
   */
  getSbcsToRemove() {
    const toRemove = [];
    for (const [sbc, failures] of this.healthTracker.entries()) {
      if (failures > 1000) { // Flagged for removal
        toRemove.push(sbc);
      }
    }
    return toRemove;
  }

  /**
   * Remove unhealthy SBC with safety checks
   */
  async removeUnhealthySbc(sbc, sbcList, removeFromSetFn) {
    if (!this.enabled) return { removed: false, reason: 'disabled' };
    
    // Safety check: never remove the last SBC
    if (this.preventLastSbcRemoval && sbcList.length <= 1) {
      this.logger.warn(`SBC ${sbc} is unhealthy but not removing as it's the last SBC. ` +
        'This may cause call routing issues but prevents total system failure.');
      return { removed: false, reason: 'last_sbc_protection' };
    }
    
    try {
      const setName = `${this.clusterId}:active-sip`;
      
      // Remove from Redis
      await removeFromSetFn(setName, sbc);
      
      // Clear our tracking
      this.healthTracker.delete(sbc);
      this.clearTimeout(sbc);
      
      // Remove from local array
      const index = sbcList.indexOf(sbc);
      if (index > -1) {
        sbcList.splice(index, 1);
        this.logger.error(`Removed unhealthy SBC ${sbc} from active-sip set after ${this.maxFailedPings} failed pings`);
        this.logger.info(`Updated local SBC list, removed ${sbc}. Active SBCs: ${sbcList.length}`);
      }
      
      // Alert if getting low on SBCs
      if (sbcList.length <= 1) {
        this.logger.warn('WARNING: Only 1 SBC remaining! Consider investigating SBC health issues.');
      }
      
      return { removed: true, reason: 'health_check_failure' };
      
    } catch (err) {
      this.logger.error({ err, sbc }, 'Failed to remove unhealthy SBC from Redis set');
      return { removed: false, reason: 'removal_error', error: err };
    }
  }

  /**
   * Clear timeout for an SBC
   */
  clearTimeout(sbc) {
    const timeoutHandle = this.pendingTimeouts.get(sbc);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      this.pendingTimeouts.delete(sbc);
    }
  }

  /**
   * Get health status for all tracked SBCs
   */
  getHealthStatus() {
    const status = {};
    for (const [sbc, failures] of this.healthTracker.entries()) {
      status[sbc] = {
        failures,
        healthy: failures < this.maxFailedPings,
        pendingTimeout: this.pendingTimeouts.has(sbc)
      };
    }
    return status;
  }

  /**
   * Clean up all timeouts (for shutdown)
   */
  cleanup() {
    for (const timeoutHandle of this.pendingTimeouts.values()) {
      clearTimeout(timeoutHandle);
    }
    this.pendingTimeouts.clear();
    this.healthTracker.clear();
    this.logger.info('SBC Health Monitor cleaned up');
  }
}

module.exports = SbcHealthMonitor; 