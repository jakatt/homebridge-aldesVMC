import { Service, PlatformAccessory, CharacteristicValue, Logger } from 'homebridge';
import { AldesVMCPlatform } from './platform.js'; 
import { AldesAPI, VmcMode, AldesDeviceStatus } from './aldes_api.js'; 

// Define a type for Service constructors that have a static UUID
type ServiceConstructorWithUUID = typeof Service & { UUID: string };

// --- Constants for Aldes Modes to HomeKit Fan States ---
// Map Aldes modes to HomeKit RotationSpeed percentages
const AldesModeToSpeed: Record<VmcMode, number> = {
    'V': 0,   // Minimum/Daily (represents OFF state speed)
    'Y': 50,  // Boost (middle position)
    'X': 100, // Guests (highest position)
};
// Map HomeKit RotationSpeed percentages back to Aldes modes
const SpeedToAldesMode = (speed: number): VmcMode => {
    // Use exact values due to validValues constraint
    if (speed === 0) return 'V';
    if (speed === 50) return 'Y';
    if (speed === 100) return 'X';
    // Default fallback (shouldn't be reached with validValues)
    return 'V';
};

// Default mode when turning fan ON
const DEFAULT_ACTIVE_MODE: VmcMode = 'Y';
// State update debounce time in milliseconds (reduced for quicker responsiveness)
const STATE_UPDATE_DEBOUNCE_MS = 100; 
// Recovery delay after failed API call
const RECOVERY_DELAY_MS = 2000;
// Maximum number of failed state updates before resetting
const MAX_FAILED_UPDATES = 5;
// Time to wait after state change to refresh status (ensure HomeKit is current)
const POST_CHANGE_REFRESH_DELAY_MS = 5000; // Increased from 2000ms to 5000ms to give device more time to change state
// Maximum number of verification attempts after mode change
const MAX_VERIFICATION_ATTEMPTS = 3;
// Verification attempt delay in milliseconds
const VERIFICATION_ATTEMPT_DELAY_MS = 4000; // 4 seconds between verification attempts
// Time to wait between notifications to HomeKit for staged updates
const STAGED_UPDATE_DELAY_MS = 150; // Increased from 50ms
// Additional repeated notifications to HomeKit to bust cache
const HOMEKIT_CACHE_BUST_INTERVALS = [100, 300, 700, 1500, 3000, 5000]; // Adjusted intervals

export class VmcAccessory {
    private service: Service;
    private deviceId: string | null = null;
    private currentMode: VmcMode = 'V'; // Default to 'V' initially
    private isSelfControlled = false; // Track if VMC is in SELF_CONTROLLED mode
    private lastMode: VmcMode | null = null; // Track last mode to detect changes
    private updateDebounceTimer: NodeJS.Timeout | null = null; // For debouncing updates
    private lastApiUpdate = 0; // Timestamp of last API update
    private failedStateUpdates = 0; // Counter for failed state updates
    private isUpdatingCharacteristic = false; // Flag to prevent update loops
    private lastKnownActiveState: number | null = null; // Track last known active state
    private lastKnownSpeed: number | null = null; // Track last known speed
    private forceNextNotification = false; // Force notification even if value is the same
    private cacheBustTimers: NodeJS.Timeout[] = []; // Timers for cache busting notifications
    private pendingStateChange = false; // Flag to indicate an ongoing state change
    private lastMode24h = ''; // Track the last mode using a string format for persistence  
    private isApiCallInProgress = false; // Mutex flag for API calls

    // ADD: Method to set the StatusFault characteristic
    private setFaultState(isFaulted: boolean) {
        const faultState = isFaulted ? 
            this.platform.Characteristic.StatusFault.GENERAL_FAULT : 
            this.platform.Characteristic.StatusFault.NO_FAULT;
            
        // Check if the characteristic exists before updating
        if (this.service.testCharacteristic(this.platform.Characteristic.StatusFault)) {
            const currentFaultState = this.service.getCharacteristic(this.platform.Characteristic.StatusFault).value;
            if (currentFaultState !== faultState) {
                this.log.info(`Setting StatusFault to: ${isFaulted ? 'GENERAL_FAULT' : 'NO_FAULT'}`);
                this.service.updateCharacteristic(this.platform.Characteristic.StatusFault, faultState);
            }
        } else {
            this.log.warn('Attempted to set StatusFault, but characteristic is not present on the service.');
        }
    }

    constructor(
        private readonly platform: AldesVMCPlatform,
        private readonly accessory: PlatformAccessory,
        private readonly log: Logger,
        private readonly aldesApi: AldesAPI,
    ) {
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Aldes')
            .setCharacteristic(this.platform.Characteristic.Model, 'VMC Fan Control') 
            .setCharacteristic(this.platform.Characteristic.SerialNumber, this.accessory.UUID);

        // --- Remove Old/Unwanted Services ---
        const servicesToRemove: ServiceConstructorWithUUID[] = [
            this.platform.Service.Switch,
            this.platform.Service.Outlet,
            this.platform.Service.Thermostat,
            this.platform.Service.ContactSensor, // Remove any old force mode sensors
        ];
        servicesToRemove.forEach(serviceType => {
            // Access UUID directly from the specific service class constructor
            const serviceUUID = serviceType.UUID;
            if (!serviceUUID) {
                this.log.warn(`Could not find UUID for service type ${serviceType.name}. Skipping removal.`);
                return; // Skip if UUID can't be found
            }

            // Filter service instances by comparing their UUID with the fetched static UUID
            const servicesOfType = this.accessory.services.filter(s => s.UUID === serviceUUID);
            servicesOfType.forEach(service => {
                this.log.info(`Removing existing ${service.displayName} (Type: ${serviceType.name}, UUID: ${serviceUUID}) service.`);
                this.accessory.removeService(service);
            });
        });
        // --- End Remove Old Services ---

        // --- Initialize Fanv2 Service ---
        this.service = this.accessory.getService(this.platform.Service.Fanv2) || this.accessory.addService(this.platform.Service.Fanv2);
        this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

        // --- Configure Fanv2 Characteristics ---
        this.service.getCharacteristic(this.platform.Characteristic.Active)
            .onGet(this.handleActiveGet.bind(this))
            .onSet(this.handleActiveSet.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
             .setProps({
                 minValue: 0,     // 0% for V mode (OFF)
                 maxValue: 100,   // 100% for X mode
                 minStep: 50,     // Force exactly 3 positions: 0%, 50%, 100%
                 validValues: [0, 50, 100] // Explicitly define the only valid values
             })
             .onGet(this.handleRotationSpeedGet.bind(this))
             .onSet(this.handleRotationSpeedSet.bind(this));
             
        // Add a warning indicator when API health degrades
        this.service.addOptionalCharacteristic(this.platform.Characteristic.StatusFault);
        this.service.setCharacteristic(
            this.platform.Characteristic.StatusFault,
            this.platform.Characteristic.StatusFault.NO_FAULT
        );
        // --- End Fanv2 Service Initialization ---

        // Start simplified initialization
        this.getInitialDeviceId(); 
    }

    // Simplified initialization just to get the ID
    async getInitialDeviceId() {
        try {
            this.deviceId = await this.aldesApi.getDeviceId();
            if (!this.deviceId) {
                this.log.error(`Failed to get Device ID during initial setup.`);
                this.setFaultState(true);
                // Optionally schedule a retry for getting the ID
                setTimeout(() => this.getInitialDeviceId(), 30000); // Retry after 30s
            } else {
                this.log.info(`VMC Accessory ready with Device ID: ${this.deviceId}`);
                // Request an initial status update from the platform
                this.platform.requestRefreshAllAccessories(); 
            }
        } catch (error) {
            this.log.error(`Error getting initial Device ID: ${error}`);
            this.setFaultState(true);
            setTimeout(() => this.getInitialDeviceId(), 30000); // Retry after 30s
        }
    }

    // Method to receive status updates from the platform
    public updateStatus(status: AldesDeviceStatus) {
        if (!status || !status.mode) {
            this.log.debug('VMC Accessory received invalid status update');
            return;
        }

        const newMode = status.mode;
        const newSelfControlled = status.isSelfControlled;

        // Check if anything relevant changed
        const modeChanged = this.currentMode !== newMode;
        const selfControlledChanged = this.isSelfControlled !== newSelfControlled;

        if (modeChanged || selfControlledChanged) {
            this.log.info(`Platform update received: Mode ${this.currentMode} → ${newMode}, SelfControlled ${this.isSelfControlled} → ${newSelfControlled}`);
            
            // Update internal state
            this.currentMode = newMode;
            this.isSelfControlled = newSelfControlled;
            
            // Update HomeKit state (use true flag as it originates externally)
            this.updateHomeKitState(true);
        } else {
             // Even if state hasn't changed, ensure HomeKit is aligned periodically
             this.updateHomeKitState(false); 
        }
        
        // Reset failed updates counter on successful update from platform
        this.failedStateUpdates = 0;
        this.setFaultState(false); // Assume API is working if platform provides status
    }

    // Helper method to safely update HomeKit state
    private updateHomeKitState(fromExternal = false) {
        // Prevent update loops and too frequent updates
        if (this.isUpdatingCharacteristic) {
            this.log.debug("Skipping HomeKit update: Update already in progress");
            return;
        }
        
        // Debounce updates to prevent overwhelming HomeKit
        if (this.updateDebounceTimer) {
            clearTimeout(this.updateDebounceTimer);
        }
        
        // Clear any existing cache bust timers
        this.clearCacheBustTimers();
        
        this.updateDebounceTimer = setTimeout(() => {
            try {
                this.isUpdatingCharacteristic = true;
                
                // Calculate all state values up front to avoid using before declaration
                const isActiveState = this.currentMode !== 'V';
                const currentSpeed = AldesModeToSpeed[this.currentMode];
                const currentActiveState = isActiveState ? 
                    this.platform.Characteristic.Active.ACTIVE : 
                    this.platform.Characteristic.Active.INACTIVE;
                
                // Track if values actually changed or force notification is needed
                const activeChanged = this.lastKnownActiveState !== currentActiveState || this.forceNextNotification;
                const speedChanged = this.lastKnownSpeed !== currentSpeed || this.forceNextNotification;
                
                if (activeChanged || speedChanged) {
                    this.log.info(`Updating HomeKit state: Active=${currentActiveState}, Speed=${currentSpeed}% (Mode: ${this.currentMode})`);
                    
                    // Save current state for persistent tracking
                    this.lastMode24h = `${this.currentMode}-${Date.now()}`;
                    
                    // If we're in the middle of a state transition, force the update more aggressively
                    const isStateTransition = this.pendingStateChange || fromExternal;
                    
                    // Update HomeKit in a specific sequence with small delays between updates
                    // This helps HomeKit process the changes correctly without state confusion
                    
                    // Step 1: If turning ON or CHANGING SPEED while on, update Active state first, then speed
                    if (currentActiveState === this.platform.Characteristic.Active.ACTIVE) {
                        // Update Active state first if needed
                        if (activeChanged) {
                            this.lastKnownActiveState = currentActiveState;
                            this.service.updateCharacteristic(this.platform.Characteristic.Active, currentActiveState);
                            
                            // Then update Speed after a small delay
                            if (speedChanged) {
                                setTimeout(() => {
                                    this.lastKnownSpeed = currentSpeed;
                                    this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, currentSpeed);
                                    this.log.debug(`Staged update complete: ON at ${currentSpeed}%`);
                                    
                                    // Set up repeated broadcasts of the final state
                                    if (isStateTransition) {
                                        this.setupCacheBustBroadcasts(currentActiveState, currentSpeed);
                                    }
                                }, STAGED_UPDATE_DELAY_MS);
                            }
                        } else if (speedChanged) {
                            // Just update speed if active state is already correct
                            this.lastKnownSpeed = currentSpeed;
                            this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, currentSpeed);
                            
                            // Set up repeated broadcasts of the final state
                            if (isStateTransition) {
                                this.setupCacheBustBroadcasts(currentActiveState, currentSpeed);
                            }
                        }
                    } 
                    // Step 2: If turning OFF, update Speed first, then Active state
                    else {
                        // Update Speed to 0 first if needed
                        if (speedChanged) {
                            this.lastKnownSpeed = currentSpeed; // Should be 0
                            this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, currentSpeed);
                            
                            // Then update Active state after a small delay
                            if (activeChanged) {
                                setTimeout(() => {
                                    this.lastKnownActiveState = currentActiveState;
                                    this.service.updateCharacteristic(this.platform.Characteristic.Active, currentActiveState);
                                    this.log.debug(`Staged update complete: OFF at ${currentSpeed}%`);
                                    
                                    // Set up repeated broadcasts of the final state
                                    if (isStateTransition) {
                                        this.setupCacheBustBroadcasts(currentActiveState, currentSpeed);
                                    }
                                }, STAGED_UPDATE_DELAY_MS);
                            }
                        } else if (activeChanged) {
                            // Just update active state if speed is already correct
                            this.lastKnownActiveState = currentActiveState;
                            this.service.updateCharacteristic(this.platform.Characteristic.Active, currentActiveState);
                            
                            // Set up repeated broadcasts of the final state
                            if (isStateTransition) {
                                this.setupCacheBustBroadcasts(currentActiveState, currentSpeed);
                            }
                        }
                    }
                    
                    // Reset force notification flag
                    this.forceNextNotification = false;
                    
                    // Update logging
                    this.log.info(`HomeKit UI updated: ${isActiveState ? 'ON' : 'OFF'} at ${currentSpeed}%`);
                } else {
                    this.log.debug(`No change in HomeKit state values: Active=${currentActiveState}, Speed=${currentSpeed}%`);
                }
            } catch (error) {
                this.log.error(`Error updating HomeKit state: ${error}`);
            } finally {
                this.isUpdatingCharacteristic = false;
                this.updateDebounceTimer = null;
            }
        }, STATE_UPDATE_DEBOUNCE_MS);
    }
    
    // New method to set up repeated characteristic broadcasts to ensure HomeKit caching is busted
    private setupCacheBustBroadcasts(activeState: number, speed: number) {
        // Clear any existing timers
        this.clearCacheBustTimers();
        
        // Create a sequence of delayed broadcasts to ensure HomeKit gets the update
        HOMEKIT_CACHE_BUST_INTERVALS.forEach(delay => {
            const timer = setTimeout(() => {
                try {
                    this.log.debug(`Cache-bust broadcast at ${delay}ms: Active=${activeState}, Speed=${speed}%`);
                    
                    // Resend the exact same values to trigger HomeKit cache refresh
                    // HomeKit sometimes needs multiple broadcasts to properly update its state
                    if (activeState === this.platform.Characteristic.Active.ACTIVE) {
                        // If we're ON, update Active state first, then speed
                        this.service.updateCharacteristic(this.platform.Characteristic.Active, activeState);
                        
                        // Small delay between the two updates
                        setTimeout(() => {
                            this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, speed);
                        }, 20);
                    } else {
                        // If we're OFF, update Speed first, then Active
                        this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, speed);
                        
                        // Small delay between the two updates
                        setTimeout(() => {
                            this.service.updateCharacteristic(this.platform.Characteristic.Active, activeState);
                        }, 20);
                    }
                    
                } catch (error) {
                    this.log.error(`Error in cache-bust broadcast: ${error}`);
                }
            }, delay);
            
            this.cacheBustTimers.push(timer);
        });
    }
    
    // Helper method to clear cache bust timers
    private clearCacheBustTimers() {
        // Clear all existing cache bust timers
        this.cacheBustTimers.forEach(timer => clearTimeout(timer));
        this.cacheBustTimers = [];
    }

    async handleActiveGet(): Promise<CharacteristicValue> {
        if (!this.deviceId) {
             this.log.warn(`Cannot get active state: Device ID not available.`);
             throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        // V mode is now considered OFF (inactive)
        const isActiveState = this.currentMode !== 'V';
        const state = isActiveState ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;
        this.log.debug(`GET Active: Returning ${state} (Mode: ${this.currentMode})`);
        return state;
    }

    async handleActiveSet(value: CharacteristicValue) {
        // Remove temporary log now that we're implementing proper fixes
        // this.log.warn('>>>>>> RUNNING MODIFIED handleActiveSet v1 <<<<<<'); 

        if (!this.deviceId) {
            this.log.warn(`Cannot set active state: Device ID not available.`);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        
        // Check API health before attempting to change state
        const health = this.aldesApi.getApiHealth();
        if (!health.healthy) {
            this.log.warn("Cannot change mode: API appears to be unhealthy");
            this.setFaultState(true);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        
        // Check if VMC is in SELF_CONTROLLED mode
        if (this.isSelfControlled) {
            this.log.warn(`Cannot change mode: Device is in SELF_CONTROLLED (force) mode.`);
            
            // ONLY throw the error. Rely on polling/refresh to correct the UI.
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE
            );
        }

        // --- Add Mutex Check ---
        if (this.isApiCallInProgress) {
            this.log.warn(`API call already in progress. Ignoring Active state change.`);
            // Reset characteristic to current value
            const currentActiveState = this.currentMode !== 'V' ?
                this.platform.Characteristic.Active.ACTIVE :
                this.platform.Characteristic.Active.INACTIVE;
            setTimeout(() => {
                this.service.updateCharacteristic(this.platform.Characteristic.Active, currentActiveState);
            }, 100);
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.RESOURCE_BUSY
            );
        }
        // --- End Mutex Check ---
        
        // Check for rapid changes
        const now = Date.now();
        const timeSinceLastUpdate = now - this.lastApiUpdate;
        if (timeSinceLastUpdate < 1000) { // Less than 1 second
            this.log.warn(`Rate limiting: Ignoring Active state change, last change was ${timeSinceLastUpdate}ms ago`);
            
            // Reset characteristic to current value
            const currentActiveState = this.currentMode !== 'V' ? 
                this.platform.Characteristic.Active.ACTIVE : 
                this.platform.Characteristic.Active.INACTIVE;
                
            setTimeout(() => {
                this.service.updateCharacteristic(this.platform.Characteristic.Active, currentActiveState);
                // Also update speed to ensure full UI consistency
                const currentSpeed = AldesModeToSpeed[this.currentMode];
                this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, currentSpeed);
            }, 50);
            
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.RESOURCE_BUSY
            );
        }
        
        const targetActiveState = value as number; // ACTIVE or INACTIVE
        const targetIsActive = targetActiveState === this.platform.Characteristic.Active.ACTIVE;
        this.log.info(`SET Active to: ${targetActiveState} (${targetIsActive ? 'ON' : 'OFF'})`);

        const currentIsActive = this.currentMode !== 'V';

        if (targetIsActive === currentIsActive) {
            this.log.debug(`Active state is already ${targetIsActive ? 'ON' : 'OFF'}. No change needed.`);
            // Ensure HomeKit UI matches internal state if needed
            setTimeout(() => {
                this.service.updateCharacteristic(this.platform.Characteristic.Active, targetActiveState);
                // Also update speed to ensure full UI consistency
                const currentSpeed = AldesModeToSpeed[this.currentMode];
                this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, currentSpeed);
            }, 50);
            return;
        }

        // Determine target mode: 'V' if turning OFF, DEFAULT_ACTIVE_MODE ('Y') if turning ON
        const targetMode: VmcMode = targetIsActive ? DEFAULT_ACTIVE_MODE : 'V';

        this.log.info(`Setting Active=${targetIsActive ? 'ON' : 'OFF'} by setting mode to ${targetMode}`);

        try {
            // --- Set Mutex ---
            this.isApiCallInProgress = true;
            // --- End Set Mutex ---
            
            // Flag that we're starting a state change
            this.pendingStateChange = true;

            this.lastApiUpdate = Date.now(); // Record update time
            const success = await this.aldesApi.setVmcMode(this.deviceId!, targetMode);
            if (!success) {
                this.log.error(`API call failed to set mode to ${targetMode}`);
                throw new Error('API call failed');
            }

            // Update HomeKit characteristics with accurate sequencing
            const targetSpeed = AldesModeToSpeed[targetMode];
            
            // Force update even if values haven't changed
            this.forceNextNotification = true;
            
            // Update state based on whether we're turning on or off
            if (targetIsActive) {
                // First set to active, then update speed
                this.service.updateCharacteristic(this.platform.Characteristic.Active, targetActiveState);
                setTimeout(() => {
                    this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, targetSpeed);
                    this.log.info(`Successfully sent command to set mode to ${targetMode}`);
                }, STAGED_UPDATE_DELAY_MS);
            } else {
                // First set speed to 0, then set to inactive
                this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, targetSpeed);
                setTimeout(() => {
                    this.service.updateCharacteristic(this.platform.Characteristic.Active, targetActiveState);
                    this.log.info(`Successfully sent command to set mode to ${targetMode}`);
                }, STAGED_UPDATE_DELAY_MS);
            }
            
            // Update last known values - we update this optimistically to avoid UI flicker
            this.lastKnownActiveState = targetActiveState;
            this.lastKnownSpeed = targetSpeed;
            
            // Temporarily update the internal state - this will be corrected if verification fails
            const previousMode = this.currentMode;
            this.currentMode = targetMode;
            
            // MODIFY: Request immediate status refresh 
            this.log.info(`Requesting immediate status refresh after setting mode to ${targetMode}...`);
            this.platform.requestRefreshAllAccessories(); // Ask platform to refresh soon

            // Set up cache bust broadcasts for the optimistic state
            // Don't set up cache bust broadcasts immediately, wait until after verification
            // this.setupCacheBustBroadcasts(targetActiveState, targetSpeed);

            // Implement multi-attempt verification with increasing delays
            let verificationSuccessful = false;
            let verifiedMode: VmcMode | null = null;
            
            for (let attempt = 1; attempt <= MAX_VERIFICATION_ATTEMPTS; attempt++) {
                // Wait progressively longer between verification attempts
                // Aldes VMC devices can take several seconds to change mode
                await new Promise(resolve => setTimeout(resolve, 
                    attempt === 1 ? POST_CHANGE_REFRESH_DELAY_MS : VERIFICATION_ATTEMPT_DELAY_MS));
                
                if (!this.deviceId) break; // Safety check
                
                try {
                    this.log.debug(`Verification attempt ${attempt}/${MAX_VERIFICATION_ATTEMPTS} for mode change to ${targetMode}...`);
                    const refreshedStatus = await this.aldesApi.getDeviceStatus(this.deviceId);
                    
                    if (refreshedStatus && refreshedStatus.mode) {
                        this.log.info(`[Verification ${attempt}] Status: Mode=${refreshedStatus.mode}, SelfControlled=${refreshedStatus.isSelfControlled}`);
                        
                        // Always store the verified mode for later use
                        verifiedMode = refreshedStatus.mode;
                        
                        if (refreshedStatus.mode === targetMode) {
                            // Mode change verified! ✅
                            verificationSuccessful = true;
                            this.log.info(`[Verification ${attempt}] ✅ SUCCESS: Mode successfully changed to ${targetMode}.`);
                            
                            // Update internal state to match actual device state (should be the same)
                            this.currentMode = refreshedStatus.mode;
                            this.isSelfControlled = refreshedStatus.isSelfControlled;
                            break; // Exit verification loop
                        } else {
                            this.log.warn(`[Verification ${attempt}] ⚠️ MISMATCH: Expected ${targetMode}, but device reports ${refreshedStatus.mode}.`);
                            
                            if (attempt === MAX_VERIFICATION_ATTEMPTS) {
                                // This is our last attempt - update internal state to match actual device state
                                this.log.warn(`[Verification] Final attempt failed. Device did not change to requested mode after ${MAX_VERIFICATION_ATTEMPTS} verification attempts.`);
                                this.log.info(`[Verification] Updating internal state to match actual device state: ${refreshedStatus.mode}`);
                                
                                // Update our internal state to match what the device actually reports
                                this.currentMode = refreshedStatus.mode;
                                this.isSelfControlled = refreshedStatus.isSelfControlled;
                                
                                // Update HomeKit UI to match actual device state
                                const actualActiveState = refreshedStatus.mode !== 'V' ? 
                                    this.platform.Characteristic.Active.ACTIVE : 
                                    this.platform.Characteristic.Active.INACTIVE;
                                const actualSpeed = AldesModeToSpeed[refreshedStatus.mode];
                                
                                this.log.info(`[Verification] Correcting HomeKit UI to actual device state: Active=${actualActiveState}, Speed=${actualSpeed}%`);
                                
                                // Force immediate update to the correct state
                                this.service.updateCharacteristic(this.platform.Characteristic.Active, actualActiveState);
                                this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, actualSpeed);
                                
                                // Save the updated state values
                                this.lastKnownActiveState = actualActiveState;
                                this.lastKnownSpeed = actualSpeed;
                            } else {
                                this.log.info(`[Verification] Will retry verification in ${VERIFICATION_ATTEMPT_DELAY_MS/1000} seconds...`);
                            }
                        }
                    } else {
                        this.log.warn(`[Verification ${attempt}] Failed to get valid device status.`);
                    }
                    
                } catch (verifyError) {
                    this.log.error(`[Verification ${attempt}] Error checking device status: ${verifyError}`);
                }
            }
            
            // After all verification attempts, set up cache busting with the ACTUAL verified state
            if (verifiedMode) {
                const verifiedActiveState = verifiedMode !== 'V' ? 
                    this.platform.Characteristic.Active.ACTIVE : 
                    this.platform.Characteristic.Active.INACTIVE;
                const verifiedSpeed = AldesModeToSpeed[verifiedMode];
                
                // IMPORTANT: Setup the cache bust broadcasts based on the ACTUAL device state now, not the target state
                this.log.info(`Setting up cache bust broadcasts with VERIFIED state: Mode=${verifiedMode}, Active=${verifiedActiveState}, Speed=${verifiedSpeed}%`);
                this.setupCacheBustBroadcasts(verifiedActiveState, verifiedSpeed);
                
                // Force immediate UI update to match the verified state
                this.service.updateCharacteristic(this.platform.Characteristic.Active, verifiedActiveState);
                this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, verifiedSpeed);
                
                // Update last known values with verified values
                this.lastKnownActiveState = verifiedActiveState;
                this.lastKnownSpeed = verifiedSpeed;
            }
            
            // Log the final verification result
            if (verificationSuccessful) {
                this.log.info(`Mode change to ${targetMode} was successfully verified.`);
            } else {
                this.log.warn(`Failed to verify mode change to ${targetMode} after ${MAX_VERIFICATION_ATTEMPTS} attempts. Using verified mode: ${verifiedMode || 'unknown'}`);
            }

            // Reset pending state change flag
            this.pendingStateChange = false;
            
            // Reset failed update counter after successful update (even if verification failed)
            this.failedStateUpdates = 0;
            // Reset fault state if present
            this.setFaultState(false);

        } catch (error) {
            this.log.error(`Error setting mode to ${targetMode}: ${error}`);
            this.pendingStateChange = false;
            
            this.failedStateUpdates++;
            if (this.failedStateUpdates >= MAX_FAILED_UPDATES) {
                this.log.warn(`Too many failed updates (${this.failedStateUpdates}), triggering API state reset`);
                this.aldesApi.resetApiState();
                this.failedStateUpdates = 0;
            }
            
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        } finally {
             // --- Release Mutex ---
             this.isApiCallInProgress = false;
             // --- End Release Mutex ---
        }
    }

    async handleRotationSpeedGet(): Promise<CharacteristicValue> {
         if (!this.deviceId) {
             this.log.warn(`Cannot get speed: Device ID not available.`);
             throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        const speed = AldesModeToSpeed[this.currentMode];
        this.log.debug(`GET RotationSpeed: Returning ${speed}% (Mode: ${this.currentMode})`);
        return speed;
    }

    async handleRotationSpeedSet(value: CharacteristicValue) {
         if (!this.deviceId) {
            this.log.warn(`Cannot set speed: Device ID not available.`);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        
        // Check API health before attempting to change state
        const health = this.aldesApi.getApiHealth();
        if (!health.healthy) {
            this.log.warn("Cannot change speed: API appears to be unhealthy");
            this.setFaultState(true);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        
        // Check if VMC is in SELF_CONTROLLED mode
        if (this.isSelfControlled) {
            this.log.warn(`Cannot change speed: Device is in SELF_CONTROLLED (force) mode.`);
            
            // ONLY throw the error. Rely on polling/refresh to correct the UI.
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE
            );
        }
        
        // --- Add Mutex Check ---
        if (this.isApiCallInProgress) {
            this.log.warn(`API call already in progress. Ignoring RotationSpeed change.`);
            // Reset characteristic to current value
            const currentSpeed = AldesModeToSpeed[this.currentMode];
            setTimeout(() => {
                this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, currentSpeed);
            }, 100);
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.RESOURCE_BUSY
            );
        }
        // --- End Mutex Check ---
        
        // Check for rapid changes
        const now = Date.now();
        const timeSinceLastUpdate = now - this.lastApiUpdate;
        if (timeSinceLastUpdate < 1000) { // Less than 1 second
            this.log.warn(`Rate limiting: Ignoring speed change, last change was ${timeSinceLastUpdate}ms ago`);
            
            // Reset characteristic to current value
            const currentSpeed = AldesModeToSpeed[this.currentMode];
                
            setTimeout(() => {
                this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, currentSpeed);
            }, 100);
            
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.RESOURCE_BUSY
            );
        }
        
        const speed = value as number;
        this.log.info(`SET RotationSpeed to: ${speed}%`);

        // Determine target Aldes mode based on speed
        const targetMode = SpeedToAldesMode(speed);
        const targetSpeed = AldesModeToSpeed[targetMode]; // Get the canonical speed for the target mode
        const targetIsActive = targetMode !== 'V';
        const targetActiveState = targetIsActive ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;

        // Check if the mode is already correct
        if (this.currentMode === targetMode) {
            this.log.debug(`Mode is already ${targetMode}. Ensuring speed (${targetSpeed}) and active state (${targetActiveState}) are correct.`);
            
            // Ensure HomeKit UI is consistent by updating both values
            setTimeout(() => {
                this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, targetSpeed);
                setTimeout(() => {
                    this.service.updateCharacteristic(this.platform.Characteristic.Active, targetActiveState);
                }, STAGED_UPDATE_DELAY_MS);
            }, 50);
            return;
        }

        // Flag that we're starting a state change
        this.pendingStateChange = true;
        
        this.log.info(`Setting speed to ${speed}% by setting mode to ${targetMode}`);
        try {
            // --- Set Mutex ---
            this.isApiCallInProgress = true;
            // --- End Set Mutex ---

            this.lastApiUpdate = Date.now(); // Record update time
            const success = await this.aldesApi.setVmcMode(this.deviceId!, targetMode);
            if (!success) {
                this.log.error(`API call failed to set mode to ${targetMode}`);
                this.pendingStateChange = false;
                throw new Error('API call failed');
            }

            // Update HomeKit in optimal sequence
            if (targetIsActive) {
                // If turning ON or changing speed while ON
                if (this.lastKnownActiveState !== this.platform.Characteristic.Active.ACTIVE) {
                    // First set to active, then update speed
                    this.service.updateCharacteristic(this.platform.Characteristic.Active, targetActiveState);
                    setTimeout(() => {
                        this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, targetSpeed);
                        // Set up cache-bust broadcasts for the final state
                        this.setupCacheBustBroadcasts(targetActiveState, targetSpeed);
                    }, STAGED_UPDATE_DELAY_MS);
                } else {
                    // Just update speed if already active
                    this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, targetSpeed);
                    // Set up cache-bust broadcasts for the final state
                    this.setupCacheBustBroadcasts(targetActiveState, targetSpeed);
                }
            } else {
                // If turning OFF
                // First set speed to 0, then set to inactive
                this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, targetSpeed);
                setTimeout(() => {
                    this.service.updateCharacteristic(this.platform.Characteristic.Active, targetActiveState);
                    // Set up cache-bust broadcasts for the final state
                    this.setupCacheBustBroadcasts(targetActiveState, targetSpeed);
                }, STAGED_UPDATE_DELAY_MS);
            }
            
            // Update last known values - we update this optimistically to avoid UI flicker
            this.lastKnownActiveState = targetActiveState;
            this.lastKnownSpeed = targetSpeed;
            
            // Temporarily update the internal state - this will be corrected if verification fails
            const previousMode = this.currentMode;
            this.currentMode = targetMode;

            // Force update even if values haven't changed
            this.forceNextNotification = true;
            
            this.log.info(`Successfully sent command to set mode to ${targetMode}`);

            // MODIFY: Request immediate status refresh 
            this.log.info(`Requesting immediate status refresh after setting mode to ${targetMode}...`);
            this.platform.requestRefreshAllAccessories(); // Ask platform to refresh soon

            // Set up cache bust broadcasts for the optimistic state
            // Don't set up cache bust broadcasts immediately, wait until after verification
            // this.setupCacheBustBroadcasts(targetActiveState, targetSpeed);

            // Implement multi-attempt verification with increasing delays
            let verificationSuccessful = false;
            let verifiedMode: VmcMode | null = null;
            
            for (let attempt = 1; attempt <= MAX_VERIFICATION_ATTEMPTS; attempt++) {
                // Wait progressively longer between verification attempts
                // Aldes VMC devices can take several seconds to change mode
                await new Promise(resolve => setTimeout(resolve, 
                    attempt === 1 ? POST_CHANGE_REFRESH_DELAY_MS : VERIFICATION_ATTEMPT_DELAY_MS));
                
                if (!this.deviceId) break; // Safety check
                
                try {
                    this.log.debug(`Verification attempt ${attempt}/${MAX_VERIFICATION_ATTEMPTS} for mode change to ${targetMode}...`);
                    const refreshedStatus = await this.aldesApi.getDeviceStatus(this.deviceId);
                    
                    if (refreshedStatus && refreshedStatus.mode) {
                        this.log.info(`[Verification ${attempt}] Status: Mode=${refreshedStatus.mode}, SelfControlled=${refreshedStatus.isSelfControlled}`);
                        
                        // Always store the verified mode for later use
                        verifiedMode = refreshedStatus.mode;
                        
                        if (refreshedStatus.mode === targetMode) {
                            // Mode change verified! ✅
                            verificationSuccessful = true;
                            this.log.info(`[Verification ${attempt}] ✅ SUCCESS: Mode successfully changed to ${targetMode}.`);
                            
                            // Update internal state to match actual device state (should be the same)
                            this.currentMode = refreshedStatus.mode;
                            this.isSelfControlled = refreshedStatus.isSelfControlled;
                            break; // Exit verification loop
                        } else {
                            this.log.warn(`[Verification ${attempt}] ⚠️ MISMATCH: Expected ${targetMode}, but device reports ${refreshedStatus.mode}.`);
                            
                            if (attempt === MAX_VERIFICATION_ATTEMPTS) {
                                // This is our last attempt - update internal state to match actual device state
                                this.log.warn(`[Verification] Final attempt failed. Device did not change to requested mode after ${MAX_VERIFICATION_ATTEMPTS} verification attempts.`);
                                this.log.info(`[Verification] Updating internal state to match actual device state: ${refreshedStatus.mode}`);
                                
                                // Update our internal state to match what the device actually reports
                                this.currentMode = refreshedStatus.mode;
                                this.isSelfControlled = refreshedStatus.isSelfControlled;
                                
                                // Update HomeKit UI to match actual device state
                                const actualActiveState = refreshedStatus.mode !== 'V' ? 
                                    this.platform.Characteristic.Active.ACTIVE : 
                                    this.platform.Characteristic.Active.INACTIVE;
                                const actualSpeed = AldesModeToSpeed[refreshedStatus.mode];
                                
                                this.log.info(`[Verification] Correcting HomeKit UI to actual device state: Active=${actualActiveState}, Speed=${actualSpeed}%`);
                                
                                // Force immediate update to the correct state
                                this.service.updateCharacteristic(this.platform.Characteristic.Active, actualActiveState);
                                this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, actualSpeed);
                                
                                // Save the updated state values
                                this.lastKnownActiveState = actualActiveState;
                                this.lastKnownSpeed = actualSpeed;
                            } else {
                                this.log.info(`[Verification] Will retry verification in ${VERIFICATION_ATTEMPT_DELAY_MS/1000} seconds...`);
                            }
                        }
                    } else {
                        this.log.warn(`[Verification ${attempt}] Failed to get valid device status.`);
                    }
                    
                } catch (verifyError) {
                    this.log.error(`[Verification ${attempt}] Error checking device status: ${verifyError}`);
                }
            }
            
            // After all verification attempts, set up cache busting with the ACTUAL verified state
            if (verifiedMode) {
                const verifiedActiveState = verifiedMode !== 'V' ? 
                    this.platform.Characteristic.Active.ACTIVE : 
                    this.platform.Characteristic.Active.INACTIVE;
                const verifiedSpeed = AldesModeToSpeed[verifiedMode];
                
                // IMPORTANT: Setup the cache bust broadcasts based on the ACTUAL device state now, not the target state
                this.log.info(`Setting up cache bust broadcasts with VERIFIED state: Mode=${verifiedMode}, Active=${verifiedActiveState}, Speed=${verifiedSpeed}%`);
                this.setupCacheBustBroadcasts(verifiedActiveState, verifiedSpeed);
                
                // Force immediate UI update to match the verified state
                this.service.updateCharacteristic(this.platform.Characteristic.Active, verifiedActiveState);
                this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, verifiedSpeed);
                
                // Update last known values with verified values
                this.lastKnownActiveState = verifiedActiveState;
                this.lastKnownSpeed = verifiedSpeed;
            }
            
            // Log the final verification result
            if (verificationSuccessful) {
                this.log.info(`Mode change to ${targetMode} was successfully verified.`);
            } else {
                this.log.warn(`Failed to verify mode change to ${targetMode} after ${MAX_VERIFICATION_ATTEMPTS} attempts. Using verified mode: ${verifiedMode || 'unknown'}`);
            }

            // Reset pending state change flag
            this.pendingStateChange = false;
            
            // Reset failed update counter after successful update (even if verification failed)
            this.failedStateUpdates = 0;
            // Reset fault state if present
            this.setFaultState(false);

        } catch (error) {
            this.log.error(`Error setting mode to ${targetMode}: ${error}`);
            this.pendingStateChange = false;
            
            this.failedStateUpdates++;
            if (this.failedStateUpdates >= MAX_FAILED_UPDATES) {
                this.log.warn(`Too many failed updates (${this.failedStateUpdates}), triggering API state reset`);
                this.aldesApi.resetApiState();
                this.failedStateUpdates = 0;
            }
            
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        } finally {
             // --- Release Mutex ---
             this.isApiCallInProgress = false;
             // --- End Release Mutex ---
        }
    }
}
