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
// New constants for better state transitions
// Delay before sending UI updates to HomeKit
const UI_UPDATE_DELAY_MS = 200;
// Delay between Active and Speed characteristic updates
const CHARACTERISTIC_UPDATE_SPACING_MS = 300;
// Time to suppress rapid UI updates during and after mode changes
const UPDATE_SUPPRESSION_WINDOW_MS = 2500;

// Additional repeated notifications to HomeKit to bust cache
const HOMEKIT_CACHE_BUST_INTERVALS = [300, 800, 2000, 5000]; // Reduced frequency with more strategic timing

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
    private apiCallMutexTimeout: NodeJS.Timeout | null = null; // Timeout to auto-release mutex
    private readonly MUTEX_TIMEOUT_MS = 30000; // 30 seconds timeout for API calls
    private lastVerifiedMode: VmcMode | null = null; // Track the last verified mode from device
    private stateUpdateStartTime = 0; // Track when a state update started

    // Method to safely set and release the API mutex
    private setApiMutex(value: boolean) {
        // Clear any existing timeout
        if (this.apiCallMutexTimeout) {
            clearTimeout(this.apiCallMutexTimeout);
            this.apiCallMutexTimeout = null;
        }
        
        // Set the mutex state
        this.isApiCallInProgress = value;
        
        // If we're locking the mutex, set a timeout to automatically release it
        if (value === true) {
            this.apiCallMutexTimeout = setTimeout(() => {
                if (this.isApiCallInProgress) {
                    this.log.warn(`API call mutex timeout after ${this.MUTEX_TIMEOUT_MS}ms - force releasing mutex`);
                    this.isApiCallInProgress = false;
                    this.apiCallMutexTimeout = null;
                    this.pendingStateChange = false; // Also clear pending state flag
                }
            }, this.MUTEX_TIMEOUT_MS);
        }
    }

    // Helper method to check API health and reset if needed
    private async ensureApiHealth(): Promise<boolean> {
        const health = this.aldesApi.getApiHealth();
        if (!health.healthy) {
            this.log.warn("API appears to be unhealthy - attempting to reset state");
            this.setFaultState(true);
            this.aldesApi.resetApiState();
            
            // Release the API mutex if it's set to avoid deadlocks
            if (this.isApiCallInProgress) {
                this.log.warn("Force releasing API mutex due to unhealthy API");
                this.setApiMutex(false);
            }
            
            // Wait a bit and check again
            await new Promise(resolve => setTimeout(resolve, 2000));
            const healthAfterReset = this.aldesApi.getApiHealth();
            if (healthAfterReset.healthy) {
                this.log.info("API health restored after reset");
                this.setFaultState(false);
                return true;
            } else {
                this.log.error("API health could not be restored after reset");
                return false;
            }
        }
        return true;
    }

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
                // IMPORTANT: Make sure V mode (0% speed) is always reported as INACTIVE (OFF)
                const isActiveState = this.currentMode !== 'V';
                const currentSpeed = AldesModeToSpeed[this.currentMode];
                const currentActiveState = isActiveState ? 
                    this.platform.Characteristic.Active.ACTIVE : 
                    this.platform.Characteristic.Active.INACTIVE;
                
                // Track if values actually changed or force notification is needed
                const activeChanged = this.lastKnownActiveState !== currentActiveState || this.forceNextNotification;
                const speedChanged = this.lastKnownSpeed !== currentSpeed || this.forceNextNotification;
                
                if (activeChanged || speedChanged) {
                    this.log.info(`Updating HomeKit state: Active=${currentActiveState === 1 ? 'ON' : 'OFF'}, Speed=${currentSpeed}% (Mode: ${this.currentMode})`);
                    
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
                                }, CHARACTERISTIC_UPDATE_SPACING_MS);
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
                        // When going to V mode (0% speed), ALWAYS enforce INACTIVE state to ensure it shows as OFF,
                        // not just 0% speed with the switch still on
                        
                        // Update Speed to 0 first if needed
                        if (speedChanged) {
                            this.lastKnownSpeed = currentSpeed; // Should be 0
                            this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, currentSpeed);
                            
                            // Always update Active state when in mode V, even if it doesn't seem to have changed
                            // This forces HomeKit to show it as OFF, not just 0%
                            setTimeout(() => {
                                this.lastKnownActiveState = this.platform.Characteristic.Active.INACTIVE;
                                this.service.updateCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.INACTIVE);
                                this.log.debug(`Staged update complete: Forced OFF at ${currentSpeed}%`);
                                
                                // Set up repeated broadcasts of the final state with forced OFF
                                if (isStateTransition) {
                                    this.setupCacheBustBroadcasts(this.platform.Characteristic.Active.INACTIVE, currentSpeed);
                                }
                            }, CHARACTERISTIC_UPDATE_SPACING_MS);
                        } else {
                            // Just update active state if speed is already correct
                            this.lastKnownActiveState = this.platform.Characteristic.Active.INACTIVE;
                            this.service.updateCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.INACTIVE);
                            
                            // Set up repeated broadcasts of the final state
                            if (isStateTransition) {
                                this.setupCacheBustBroadcasts(this.platform.Characteristic.Active.INACTIVE, currentSpeed);
                            }
                        }
                    }
                    
                    // Reset force notification flag
                    this.forceNextNotification = false;
                    
                    // Update logging
                    this.log.info(`HomeKit UI updated: ${isActiveState ? 'ON' : 'OFF'} at ${currentSpeed}%`);
                } else {
                    // Even if there are no changes, when in V mode (0%), force INACTIVE state periodically
                    // This helps ensure HomeKit always shows it as OFF, not just 0%
                    if (this.currentMode === 'V') {
                        this.log.debug(`No apparent changes, but ensuring V mode shows as OFF in HomeKit`);
                        this.lastKnownActiveState = this.platform.Characteristic.Active.INACTIVE;
                        this.service.updateCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.INACTIVE);
                    } else {
                        this.log.debug(`No change in HomeKit state values: Active=${currentActiveState}, Speed=${currentSpeed}%`);
                    }
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
        if (!this.deviceId) {
            this.log.warn(`Cannot set active state: Device ID not available.`);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }

        // Check API health before attempting to change state
        await this.ensureApiHealth();
        
        // Log incoming value and current state for debugging
        this.log.debug(`handleActiveSet called with value: ${value}, current mode: ${this.currentMode}`);

        // Check if VMC is in SELF_CONTROLLED mode
        if (this.isSelfControlled) {
            this.log.warn(`Cannot change mode: Device is in SELF_CONTROLLED (force) mode.`);
            
            // Instead of throwing an error, revert to the current state after a short delay
            const currentActiveState = this.currentMode !== 'V' ?
                this.platform.Characteristic.Active.ACTIVE :
                this.platform.Characteristic.Active.INACTIVE;
            const currentSpeed = AldesModeToSpeed[this.currentMode];
            
            // Log the state we're maintaining in force mode
            this.log.info(`Force mode active: Forcing state back to: Mode=${this.currentMode}, Speed=${currentSpeed}%, Active=${currentActiveState === 1 ? 'ON' : 'OFF'}`);
            
            // Force the characteristic update to ensure UI stays consistent
            this.forceNextNotification = true;
            
            // Set a slight delay before resetting - this is important so HomeKit registers the change attempt first
            setTimeout(() => {
                // Important: We're in force mode, so we always need to revert to the ACTUAL device state
                // This ensures both HomeKit and Homebridge UIs show the same correct state
                this.service.updateCharacteristic(this.platform.Characteristic.Active, currentActiveState);
                this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, currentSpeed);
                
                // Make sure our internal values match what we're displaying
                this.lastKnownActiveState = currentActiveState;
                this.lastKnownSpeed = currentSpeed;
                
                // Set up cache-bust broadcasts to ensure the UI stays consistent across both platforms
                this.setupCacheBustBroadcasts(currentActiveState, currentSpeed);
                
                // Request an immediate API refresh to ensure we have the truly current device state
                this.platform.requestRefreshAllAccessories('Force mode state reset');
            }, 500); // Use a longer delay to ensure HomeKit sees the attempted change first
            
            // Early return without throwing error
            return;
        }

        // --- Add stricter Mutex Check ---
        if (this.isApiCallInProgress) {
            this.log.warn(`API call already in progress. Ignoring Active state change.`);
            
            // Reset characteristic to current values
            const currentActiveState = this.currentMode !== 'V' ?
                this.platform.Characteristic.Active.ACTIVE :
                this.platform.Characteristic.Active.INACTIVE;
            const currentSpeed = AldesModeToSpeed[this.currentMode];
            
            // Delay the reset slightly to allow UI to register the click attempt
            setTimeout(() => {
                this.service.updateCharacteristic(this.platform.Characteristic.Active, currentActiveState);
                const currentSpeed = AldesModeToSpeed[this.currentMode];
                setTimeout(() => {
                    this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, currentSpeed);
                }, 50);
            }, 200);

            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.RESOURCE_BUSY
            );
        }

        this.log.info(`Active value received: ${value} (${value === 1 ? 'ON' : 'OFF'}), current mode: ${this.currentMode}`);
        
        try {
            // Set mutex to prevent concurrent calls
            this.setApiMutex(true);
            
            // Convert value to number for safety
            const activeValueNum = Number(value);
            let targetMode: VmcMode;
            
            // SPECIALIZED HOMEKIT BEHAVIOR:
            // When HomeKit sends Active=1 (ON), we need explicit handling based on current state
            if (activeValueNum === this.platform.Characteristic.Active.ACTIVE) {
                // HomeKit is turning the device ON
                
                // In HomeKit, when clicking on a Fan accessory that's OFF,
                // HomeKit just sends Active=1 (ON) and doesn't specify the speed
                // This is why it's important to handle this transition explicitly
                
                if (this.currentMode === 'V') { // Currently OFF
                    // Always go to 50% (mode Y) first when turning on from OFF
                    targetMode = 'Y';
                    this.log.info('HomeKit turning ON from OFF state - setting to 50% (mode Y)');
                }
                else if (this.currentMode === 'Y') { // Currently at 50%
                    // If at 50%, go to 100% on next click
                    targetMode = 'X';
                    this.log.info('HomeKit cycling from 50% to 100% (mode X)');
                }
                else {
                    // If at 100% or any other state, go back to OFF
                    targetMode = 'V';
                    this.log.info('HomeKit cycling from 100% to OFF (mode V)');
                }
            }
            else if (activeValueNum === this.platform.Characteristic.Active.INACTIVE) {
                // HomeKit is turning the device OFF - always set to mode V
                targetMode = 'V';
                this.log.info('HomeKit turning OFF - setting to mode V');
            }
            else {
                // Fallback for unexpected values
                targetMode = this.currentMode === 'V' ? 'Y' : this.currentMode === 'Y' ? 'X' : 'V';
                this.log.warn(`Received unexpected Active value: ${value}, falling back to cycle logic.`);
            }
            
            const targetIsActive = targetMode !== 'V';
            const targetActiveState = targetIsActive ?
                this.platform.Characteristic.Active.ACTIVE :
                this.platform.Characteristic.Active.INACTIVE;
            const targetSpeed = AldesModeToSpeed[targetMode];

            this.log.info(`Setting mode to ${targetMode} (Active=${targetIsActive ? 'ON' : 'OFF'}, Speed=${targetSpeed}%)`);

            // Update the UI state immediately without waiting for API confirmation
            // The sequence is important for HomeKit to register the state correctly
            if (targetIsActive) {
                // For ON state, first set Active=1, then set the Speed
                this.service.updateCharacteristic(this.platform.Characteristic.Active, targetActiveState);
                setTimeout(() => {
                    this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, targetSpeed);
                }, CHARACTERISTIC_UPDATE_SPACING_MS);
            } else {
                // For OFF state, first set Speed=0, then set Active=0
                this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, targetSpeed);
                setTimeout(() => {
                    this.service.updateCharacteristic(this.platform.Characteristic.Active, targetActiveState);
                }, CHARACTERISTIC_UPDATE_SPACING_MS);
            }
            
            // Update internal state tracking to keep HomeKit and Homebridge in sync
            this.lastKnownActiveState = targetActiveState;
            this.lastKnownSpeed = targetSpeed;
            const previousMode = this.currentMode;
            this.currentMode = targetMode;
            
            // Send the API request in the background - don't wait for result
            this.aldesApi.setVmcMode(this.deviceId!, targetMode)
                .then(success => {
                    if (!success) {
                        this.log.warn(`API request to set mode to ${targetMode} failed, but UI was already updated. Polling will correct if needed.`);
                    } else {
                        this.log.info(`Successfully sent command to set mode from ${previousMode} to ${targetMode}`);
                    }
                })
                .catch(error => {
                    this.log.warn(`Error calling API to set mode to ${targetMode}: ${error}. UI was already updated, polling will correct if needed.`);
                });
            
            // Setup cache-bust broadcasts to ensure consistent UI
            this.setupCacheBustBroadcasts(targetActiveState, targetSpeed);
            
            return;
        } catch (error) {
            this.log.error(`Error in handleActiveSet: ${error}`);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        } finally {
            // Release the mutex after a short delay
            setTimeout(() => {
                this.setApiMutex(false);
            }, 500);
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
        
        this.log.debug(`handleRotationSpeedSet called with value: ${value}, current mode: ${this.currentMode}`);
        
        // Check if VMC is in SELF_CONTROLLED mode
        if (this.isSelfControlled) {
            this.log.warn(`Cannot change speed: Device is in SELF_CONTROLLED (force) mode.`);
            
            // Instead of throwing an error, revert to the current state
            const currentActiveState = this.currentMode !== 'V' ?
                this.platform.Characteristic.Active.ACTIVE :
                this.platform.Characteristic.Active.INACTIVE;
            const currentSpeed = AldesModeToSpeed[this.currentMode];
            
            // Log the state we're enforcing
            this.log.info(`Force mode active: Forcing state back to: Mode=${this.currentMode}, Speed=${currentSpeed}%, Active=${currentActiveState === 1 ? 'ON' : 'OFF'}`);
            
            // Force next updates to be sent regardless of state change
            this.forceNextNotification = true;
            
            // Important: Use slightly longer delay to ensure HomeKit registers the attempt first
            setTimeout(() => {
                // Update HomeKit UI to reflect actual state - do this in the correct sequence
                // First set the speed back to the current speed
                this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, currentSpeed);
                
                // Then set the active state to match the device
                setTimeout(() => {
                    this.service.updateCharacteristic(this.platform.Characteristic.Active, currentActiveState);
                    
                    // Ensure internal state is consistent
                    this.lastKnownActiveState = currentActiveState;
                    this.lastKnownSpeed = currentSpeed;
                    
                    // Set up cache-bust broadcasts to ensure the UI stays consistent
                    this.setupCacheBustBroadcasts(currentActiveState, currentSpeed);
                    
                    // Request a refresh from the platform to ensure all accessories remain in sync
                    this.platform.requestRefreshAllAccessories('Force mode state enforcement');
                }, 50);
            }, 500); // Longer delay to ensure HomeKit registers the attempt first
            
            // Early return without throwing error
            return;
        }
        
        // --- Stricter Mutex Check ---
        if (this.isApiCallInProgress) {
            this.log.warn(`API call already in progress. Ignoring RotationSpeed change to ${value}%.`);
            
            // Reset characteristic to current value to ensure UI consistency
            const currentSpeed = AldesModeToSpeed[this.currentMode];
            
            // Delay the reset slightly to allow UI to register the click attempt
            setTimeout(() => {
                this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, currentSpeed);
            }, 200);
            
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.RESOURCE_BUSY
            );
        }
        
        // Check for rapid changes (anti-thrashing protection)
        const now = Date.now();
        const timeSinceLastUpdate = now - this.lastApiUpdate;
        if (timeSinceLastUpdate < 1000) {
            this.log.warn(`Rate limiting: Ignoring speed change to ${value}%, last change was ${timeSinceLastUpdate}ms ago`);
            
            // Reset characteristic to current value
            const currentSpeed = AldesModeToSpeed[this.currentMode];
            
            setTimeout(() => {
                this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, currentSpeed);
            }, 200);
            
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.RESOURCE_BUSY
            );
        }
        
        // Get the requested speed
        const speed = value as number;
        this.log.info(`SET RotationSpeed to: ${speed}%, current mode: ${this.currentMode}`);
        
        try {
            // Set mutex to prevent concurrent calls
            this.setApiMutex(true);
            this.lastApiUpdate = now;
            
            // Determine target Aldes mode based on speed
            const targetMode = SpeedToAldesMode(speed);
            const targetSpeed = AldesModeToSpeed[targetMode];
            const targetIsActive = targetMode !== 'V';
            const targetActiveState = targetIsActive ? 
                this.platform.Characteristic.Active.ACTIVE : 
                this.platform.Characteristic.Active.INACTIVE;
            
            // Check if the mode is already correct
            if (this.currentMode === targetMode) {
                this.log.debug(`Mode is already ${targetMode}. No change needed.`);
                
                // Still update the UI to ensure consistency
                setTimeout(() => {
                    this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, targetSpeed);
                    setTimeout(() => {
                        this.service.updateCharacteristic(this.platform.Characteristic.Active, targetActiveState);
                    }, CHARACTERISTIC_UPDATE_SPACING_MS);
                }, 50);
                return;
            }
            
            this.log.info(`Setting speed to ${speed}% by setting mode to ${targetMode}`);
            
            // Update UI immediately without waiting for API confirmation
            if (targetIsActive) {
                this.service.updateCharacteristic(this.platform.Characteristic.Active, targetActiveState);
                setTimeout(() => {
                    this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, targetSpeed);
                }, CHARACTERISTIC_UPDATE_SPACING_MS);
            } else {
                this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, targetSpeed);
                setTimeout(() => {
                    this.service.updateCharacteristic(this.platform.Characteristic.Active, targetActiveState);
                }, CHARACTERISTIC_UPDATE_SPACING_MS);
            }
            
            // Update internal state tracking to keep HomeKit and Homebridge in sync
            this.lastKnownActiveState = targetActiveState;
            this.lastKnownSpeed = targetSpeed;
            const previousMode = this.currentMode;
            this.currentMode = targetMode;
            
            // Send API request in background without waiting for result
            this.aldesApi.setVmcMode(this.deviceId!, targetMode)
                .then(success => {
                    if (!success) {
                        this.log.warn(`API request to set mode to ${targetMode} failed, but UI was already updated. Polling will correct if needed.`);
                    } else {
                        this.log.info(`Successfully sent command to set mode from ${previousMode} to ${targetMode}`);
                    }
                })
                .catch(error => {
                    this.log.warn(`Error calling API to set mode to ${targetMode}: ${error}. UI was already updated, polling will correct if needed.`);
                });
            
            // Setup cache-bust broadcasts to ensure UI consistency
            this.setupCacheBustBroadcasts(targetActiveState, targetSpeed);
            
        } catch (error) {
            this.log.error(`Error in handleRotationSpeedSet: ${error}`);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        } finally {
            // Release the mutex after a short delay
            setTimeout(() => {
                this.setApiMutex(false);
            }, 500);
        }
    }
}
