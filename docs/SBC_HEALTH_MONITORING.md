# SBC Health Monitoring Solution (External Module)

> **📋 Consolidated Documentation**: This document contains all documentation for the SBC health monitoring feature. No changes were made to `README.md` to keep it clean and avoid merge conflicts.

## Problem Summary

The original SBC pinger system had a critical flaw: **stale SBC entries never got removed from the active pool**. When SBCs crashed, lost network connectivity, or became unresponsive without graceful shutdown, they remained in the `active-sip` Redis set indefinitely.

This caused:
- Failed call routing attempts to dead SBCs
- Degraded system performance  
- Poor user experience
- Operational overhead from manual cleanup

## Solution Overview

We've implemented **external SBC health monitoring** with the following features:

### 🔧 **External Module Design**
- **Separate file**: `lib/utils/sbc-health-monitor.js` - no merge conflicts!
- **Minimal integration**: Only 3 lines changed in `sbc-pinger.js`
- **Non-breaking**: Fully backward compatible with existing deployments
- **Safe defaults**: Enabled by default with conservative settings

### 🛡️ **Safety First**
- **Last SBC protection**: Never removes the final SBC (prevents total routing failure)
- **Configurable thresholds**: Tune failure limits for your environment  
- **Graceful degradation**: Better to have 1 bad SBC than 0 SBCs
- **Easy disable**: Set `SBC_HEALTH_CHECK_ENABLED=false` to disable

### 🔍 **Health Detection**
- Tracks failed OPTIONS ping attempts per SBC
- Monitors timeouts, connection errors, and non-2xx responses
- Configurable failure thresholds

### 🚫 **Automatic Removal**
- Removes unhealthy SBCs from Redis `active-sip` set
- Updates local SBC arrays in feature servers
- Logs all health events for monitoring

### ✅ **Auto-Recovery**
- Automatically re-adds SBCs when they come back online
- Resets failure counters on successful pings
- Provides recovery notifications

## Implementation Details

### Files Created/Modified

**📁 New Files Created:**
- `lib/utils/sbc-health-monitor.js` - External health monitoring module (main logic)
- `test/sbc-health-monitoring.test.js` - Comprehensive test suite
- `SBC_HEALTH_MONITORING.md` - This documentation file

**🔧 Minimal Changes to Existing Files:**
- `lib/config.js` - Added health monitoring config options
- `lib/utils/sbc-pinger.js` - Added 3 integration points (surgical changes)

**✅ Files Kept Clean:**
- `README.md` - No changes (avoided merge conflicts)

### Minimal Code Changes

**New External Module**: `lib/utils/sbc-health-monitor.js`
- Complete health monitoring logic
- Safety checks and last SBC protection
- Configurable thresholds and timeouts

**Surgical Changes to** `sbc-pinger.js`:
```javascript
// Only these 3 integration points added:
const SbcHealthMonitor = require('./sbc-health-monitor');
const healthMonitor = new SbcHealthMonitor(logger, config);

// In ping loop:
healthMonitor.beforePing(sbc);
healthMonitor.onPingResponse(sbc, res.status);
healthMonitor.onPingError(sbc, err);

// After ping cycle:
const sbcsToRemove = healthMonitor.getSbcsToRemove();
// Process removals...
```

### Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `SBC_HEALTH_CHECK_ENABLED` | `true` | Enable/disable automatic SBC health monitoring |
| `SBC_MAX_FAILED_PINGS` | `3` | Number of consecutive failed pings before removing an SBC |
| `SBC_PING_TIMEOUT_MS` | `5000` | Timeout in milliseconds for OPTIONS ping responses |

### Safety Features

#### Last SBC Protection ✅
```javascript
// Will NOT remove the last SBC even if unhealthy
if (sbcList.length <= 1) {
  logger.warn(`SBC ${sbc} is unhealthy but not removing as it's the last SBC. ` +
    'This may cause call routing issues but prevents total system failure.');
  return { removed: false, reason: 'last_sbc_protection' };
}
```

#### Conservative Defaults ✅
- Enabled by default but easily disabled
- 3 failures before removal (not aggressive)
- 5 second timeout (accommodates slow networks)
- Prevents removing last SBC (prevents total outage)

### Example Configuration

```bash
# Production recommended settings (default)
SBC_HEALTH_CHECK_ENABLED=true
SBC_MAX_FAILED_PINGS=3
SBC_PING_TIMEOUT_MS=5000

# More aggressive (faster failure detection)
SBC_MAX_FAILED_PINGS=2
SBC_PING_TIMEOUT_MS=3000

# Conservative (slow networks, high tolerance)
SBC_MAX_FAILED_PINGS=5
SBC_PING_TIMEOUT_MS=10000

# Disable completely (revert to original behavior)
SBC_HEALTH_CHECK_ENABLED=false
```

## Monitoring

The system logs important health events:

```bash
# SBC failure detection
WARN: SBC 192.168.1.100:5060 failed ping 2/3 (reason: timeout)

# SBC removal
ERROR: Removed unhealthy SBC 192.168.1.100:5060 from active-sip set after 3 failed pings

# Last SBC protection
WARN: SBC 192.168.1.100:5060 is unhealthy but not removing as it's the last SBC

# SBC recovery  
INFO: SBC 192.168.1.100:5060 back online after 2 failed pings

# Low SBC count warning
WARN: Only 1 SBC remaining! Consider investigating SBC health issues.
```

### Alert Patterns for Monitoring

```bash
# Set up alerts for these patterns:
"failed ping.*reason:" # SBC failure detection
"Removed unhealthy SBC" # Critical: SBC removed
"not removing as it's the last SBC" # Critical: Last SBC failing
"back online after.*failed pings" # Info: SBC recovered
"Only.*SBC remaining" # Warning: Getting low on SBCs
```

## Testing

### Comprehensive Test Suite
```bash
# Run the complete SBC health monitoring test suite
npm test test/sbc-health-monitoring.test.js
```

**Test Coverage Includes:**

**Standalone Health Monitor Tests:**
- ✅ Basic failure tracking and removal logic
- ✅ Last SBC protection safety feature (critical!)
- ✅ Recovery after failures and counter reset
- ✅ Disabled mode behavior (backward compatibility)
- ✅ Timeout handling and automatic cleanup
- ✅ Multiple SBC removal safety checks
- ✅ Resource leak prevention

**Integration Tests:**
- ✅ SBC pinger module initialization with health monitor
- ✅ Configuration validation (enabled/disabled modes)
- ✅ Edge case configuration handling (invalid values)
- ✅ Graceful fallback to defaults

**Safety Verification:**
- ✅ Last SBC is never removed (prevents total outage)
- ✅ Invalid configs don't break the system
- ✅ Cleanup prevents resource leaks
- ✅ Module works when health monitoring is disabled

### Integration Testing
1. **Normal operation**: Verify SBCs stay in pool when healthy
2. **Failure scenario**: Stop an SBC, verify removal after 3 failures
3. **Last SBC protection**: Fail the only SBC, verify it stays
4. **Recovery scenario**: Restart failed SBC, verify it's re-included
5. **Disabled mode**: Set `SBC_HEALTH_CHECK_ENABLED=false`, verify no changes

## Deployment Strategy

### Phase 1: Safe Deployment ✅
```bash
# Deploy with monitoring only (no removals)
SBC_HEALTH_CHECK_ENABLED=true
SBC_MAX_FAILED_PINGS=100  # Very high threshold
```
Monitor logs for failure patterns without any SBC removals.

### Phase 2: Conservative Testing ✅  
```bash
# Enable with conservative settings
SBC_MAX_FAILED_PINGS=5
SBC_PING_TIMEOUT_MS=10000
```
Allow removals but with high tolerance for network issues.

### Phase 3: Production Tuning ✅
```bash
# Tune for your environment
SBC_MAX_FAILED_PINGS=3
SBC_PING_TIMEOUT_MS=5000
```
Adjust based on observed network conditions and failure patterns.

## Rollback Plan

If issues arise, disable health monitoring immediately:

```bash
# Instant rollback - reverts to original behavior
export SBC_HEALTH_CHECK_ENABLED=false

# Restart feature servers to apply
systemctl restart jambonz-feature-server
```

**No code changes needed** - the external module simply becomes inactive.

## Operational Benefits

### ✅ **Merge-Safe**
- External module in separate file
- Minimal changes to existing code
- No upstream merge conflicts

### ✅ **Production-Safe**  
- Last SBC protection prevents total outages
- Conservative defaults
- Easy to disable/rollback

### ✅ **Operational Excellence**
- Clear monitoring and alerting
- Comprehensive logging
- Health status visibility

## Registration Lifecycle Analysis

### How SBCs Register

**Initial Registration**: SBCs self-register once when connecting to drachtio:
```javascript
srf.on('connect', () => {
  // Parse hostports, identify private IPs
  srf.locals.addToRedis = () => addToSet(setName, hostport);
  srf.locals.addToRedis(); // <- One-time registration
});
```

**Limited Re-registration**: Only occurs during:
- AWS lifecycle events (standby exit)
- Manual restart/reconnection

**No Periodic Heartbeats**: SBCs don't re-register themselves over time.

### Graceful Shutdown Cleanup ✅

SBCs have excellent cleanup for planned shutdowns:

```javascript
process.on('SIGTERM', handle);
process.on('SIGUSR2', handle);

function handle(removeFromSet, setName, signal) {
  logger.info(`removing ${srf.locals.privateSipAddress} from set ${setName}`);
  removeFromSet(setName, srf.locals.privateSipAddress);
}
```

### The Gap: Ungraceful Failures ❌

| Failure Type | Registration | Cleanup | Result |
|--------------|-------------|---------|---------|
| Normal shutdown | N/A | ✅ Automatic | ✅ Clean |
| AWS scale-in | N/A | ✅ Automatic | ✅ Clean |
| **Power failure** | N/A | ❌ None | ❌ **Stale** |
| **Process crash** | N/A | ❌ None | ❌ **Stale** |
| **Network partition** | N/A | ❌ None | ❌ **Stale** |
| **Container restart** | N/A | ❌ None | ❌ **Stale** |

This is why the health monitoring solution is essential - it's the **only mechanism** that detects and cleans up ungraceful failures.

## Support

For issues or questions:
1. Check feature server logs for health events
2. Verify Redis `active-sip` set contents  
3. Review configuration settings
4. Test health monitor with: `healthMonitor.getHealthStatus()`

This solution provides robust, automatic SBC health management while maintaining system stability, operational safety, and upstream compatibility. 