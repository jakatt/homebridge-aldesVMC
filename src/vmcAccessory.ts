import { Service, PlatformAccessory, CharacteristicValue, Logger } from 'homebridge';
import { AldesVMCPlatform } from './platform.js'; 
import { AldesAPI, VmcMode } from './aldes_api.js'; 

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

// Default polling interval in seconds if not specified
const DEFAULT_EXTERNAL_CHANGES_POLLING_INTERVAL = 60;
// Default mode when turning fan ON
const DEFAULT_ACTIVE_MODE: VmcMode = 'Y';
// State update debounce time in milliseconds
const STATE_UPDATE_DEBOUNCE_MS = 500;
// Recovery delay after failed API call
const RECOVERY_DELAY_MS = 2000;
// Maximum number of failed state updates before resetting
const MAX_FAILED_UPDATES = 5;

export class VmcAccessory {
    private service: Service;
    private deviceId: string | null = null;
    private currentMode: VmcMode = 'V'; // Default to 'V' initially
    private isSelfControlled = false; // Track if VMC is in SELF_CONTROLLED mode
    private pollingInterval: NodeJS.Timeout | null = null; // For status polling
    private lastMode: VmcMode | null = null; // Track last mode to detect changes
    private refreshInProgress = false; // Flag to prevent concurrent refresh
    private updateDebounceTimer: NodeJS.Timeout | null = null; // For debouncing updates
    private lastApiUpdate = 0; // Timestamp of last API update
    private failedStateUpdates = 0; // Counter for failed state updates
    private isUpdatingCharacteristic = false; // Flag to prevent update loops

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

        this.initializeDevice();
    }

    async initializeDevice() {
        try {
            this.deviceId = await this.aldesApi.getDeviceId();
            if (!this.deviceId) {
                this.log.error(`Failed to initialize VMC Accessory: Could not get Device ID.`);
                this.setFaultState(true);
                
                // Retry initialization after delay
                setTimeout(() => {
                    this.log.info("Retrying device initialization...");
                    this.initializeDevice();
                }, RECOVERY_DELAY_MS);
                return;
            }
            
            this.log.info(`VMC Accessory initialized with Device ID: ${this.deviceId}`);
            
            // Perform an initial status fetch to populate cache
            const success = await this.refreshStatus();
            
            if (!success) {
                this.log.warn("Initial status fetch failed, will retry and continue with polling");
                this.setFaultState(true);
            } else {
                this.setFaultState(false);
            }
            
            // Start polling for status updates regardless of initial fetch success
            this.startPolling();
        } catch (error) {
            this.log.error(`Error during device initialization: ${error}`);
            this.setFaultState(true);
            
            // Retry initialization after delay
            setTimeout(() => {
                this.log.info("Retrying device initialization after error...");
                this.initializeDevice();
            }, RECOVERY_DELAY_MS);
        }
    }
    
    // Set up polling mechanism to detect external changes
    startPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
        }
        
        // Get polling interval from config, or use default (60 seconds)
        const pollingIntervalSeconds = this.platform.config.externalChangesPollingInterval || DEFAULT_EXTERNAL_CHANGES_POLLING_INTERVAL;
        const pollIntervalMs = pollingIntervalSeconds * 1000;
        
        this.log.info(`Starting polling for external changes every ${pollingIntervalSeconds} seconds...`);
        
        this.pollingInterval = setInterval(async () => {
            await this.checkApiHealth();
            await this.checkForExternalChanges();
        }, pollIntervalMs);
        
        // Make sure polling stops when homebridge shuts down
        this.platform.api.on('shutdown', () => {
            if (this.pollingInterval) {
                clearInterval(this.pollingInterval);
                this.pollingInterval = null;
                this.log.debug('Polling stopped due to homebridge shutdown');
            }
        });
    }
    
    // New method to check API health and update fault state
    async checkApiHealth() {
        const health = this.aldesApi.getApiHealth();
        
        // Update fault state based on API health
        if (!health.healthy) {
            this.log.warn(`API health check failed: ${health.consecutiveFailures} consecutive failures, last error: ${health.lastError}`);
            this.setFaultState(true);
            
            // If API has been unhealthy for a while, try to reset
            if (health.consecutiveFailures > 5) {
                this.log.info("API has been unhealthy for too long, attempting to reset API state");
                this.aldesApi.resetApiState();
            }
        } else {
            this.setFaultState(false);
        }
    }
    
    // Helper method to set fault state with debounce to prevent flapping
    private setFaultState(hasFault: boolean) {
        // Skip redundant updates
        const currentFault = this.service.getCharacteristic(this.platform.Characteristic.StatusFault).value as number;
        const newFault = hasFault ? 
            this.platform.Characteristic.StatusFault.GENERAL_FAULT : 
            this.platform.Characteristic.StatusFault.NO_FAULT;
            
        if (currentFault !== newFault) {
            this.service.updateCharacteristic(
                this.platform.Characteristic.StatusFault,
                newFault
            );
        }
    }
    
    async checkForExternalChanges() {
        if (!this.deviceId || this.refreshInProgress) return;
        
        try {
            this.refreshInProgress = true;
            
            const status = await this.aldesApi.getDeviceStatus(this.deviceId);
            if (!status || !status.mode) {
                this.log.debug('Polling skipped: Could not get valid device status');
                this.refreshInProgress = false;
                return;
            }
            
            const newMode = status.mode;
            const newSelfControlled = status.isSelfControlled;
            
            // Check if anything changed
            const modeChanged = this.currentMode !== newMode;
            const selfControlledChanged = this.isSelfControlled !== newSelfControlled;
            
            if (modeChanged || selfControlledChanged) {
                this.log.info(`External change detected: Mode ${this.currentMode} → ${newMode}, SelfControlled ${this.isSelfControlled} → ${newSelfControlled}`);
                
                // Update our internal state
                this.currentMode = newMode;
                this.isSelfControlled = newSelfControlled;
                
                // Safely update HomeKit state
                this.updateHomeKitState(true);
            }
            
            // Reset failed updates counter on successful API call
            this.failedStateUpdates = 0;
            
        } catch (error) {
            this.log.error(`Error checking for external changes: ${error}`);
            this.failedStateUpdates++;
            
            if (this.failedStateUpdates >= MAX_FAILED_UPDATES) {
                this.log.warn(`Too many failed updates (${this.failedStateUpdates}), triggering API state reset`);
                this.aldesApi.resetApiState();
                this.failedStateUpdates = 0;
            }
        } finally {
            this.refreshInProgress = false;
        }
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
        
        this.updateDebounceTimer = setTimeout(() => {
            try {
                this.isUpdatingCharacteristic = true;
                
                const isActiveState = this.currentMode !== 'V';
                const currentSpeed = AldesModeToSpeed[this.currentMode];
                const currentActiveState = isActiveState ? 
                    this.platform.Characteristic.Active.ACTIVE : 
                    this.platform.Characteristic.Active.INACTIVE;
                
                this.log.debug(`Updating HomeKit state: Active=${currentActiveState}, Speed=${currentSpeed}% (Mode: ${this.currentMode})`);
                
                this.service.updateCharacteristic(this.platform.Characteristic.Active, currentActiveState);
                this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, currentSpeed);
                
                // Update extra logging context if it was an external change
                if (fromExternal) {
                    this.log.info(`HomeKit UI updated to reflect external change: ${isActiveState ? 'ON' : 'OFF'} at ${currentSpeed}%`);
                }
            } catch (error) {
                this.log.error(`Error updating HomeKit state: ${error}`);
            } finally {
                this.isUpdatingCharacteristic = false;
                this.updateDebounceTimer = null;
            }
        }, STATE_UPDATE_DEBOUNCE_MS);
    }

    // Method to fetch current status and update cache + HomeKit state
    async refreshStatus(): Promise<boolean> {
        if (!this.deviceId) return false;
        if (this.refreshInProgress) {
            this.log.debug("Skipping refresh: Another refresh already in progress");
            return false;
        }

        this.log.debug(`Refreshing status...`);
        this.refreshInProgress = true;
        
        try {
            const status = await this.aldesApi.getDeviceStatus(this.deviceId);
            if (!status) {
                this.log.warn(`[Refresh] Failed to get device status. Keeping cached values.`);
                this.refreshInProgress = false;
                return false;
            }

            // Update self-controlled state
            this.isSelfControlled = status.isSelfControlled;
            
            if (status.mode) {
                this.currentMode = status.mode;
            } else {
                this.log.warn(`[Refresh] Received null/undefined mode from API. Keeping cached mode: ${this.currentMode}`);
            }

            const isActiveState = this.currentMode !== 'V'; // Active if mode is Y or X
            const currentSpeed = AldesModeToSpeed[this.currentMode];
            const currentActiveState = isActiveState ? 
                this.platform.Characteristic.Active.ACTIVE : 
                this.platform.Characteristic.Active.INACTIVE;

            this.log.debug(`Refreshed Status - Mode: ${this.currentMode}, ActiveState: ${currentActiveState}, Speed: ${currentSpeed}, SelfControlled: ${this.isSelfControlled}`);

            // Update HomeKit state non-blockingly
            this.updateHomeKitState();
            
            // Reset failed updates counter on successful refresh
            this.failedStateUpdates = 0;
            
            this.refreshInProgress = false;
            return true;
        } catch (error) {
            this.log.error(`Error refreshing status: ${error}`);
            this.failedStateUpdates++;
            
            if (this.failedStateUpdates >= MAX_FAILED_UPDATES) {
                this.log.warn(`Too many failed updates (${this.failedStateUpdates}), triggering API state reset`);
                this.aldesApi.resetApiState();
                this.failedStateUpdates = 0;
            }
            
            this.refreshInProgress = false;
            return false;
        }
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
        const health = this.aldesApi.getApiHealth();
        if (!health.healthy) {
            this.log.warn("Cannot change mode: API appears to be unhealthy");
            this.setFaultState(true);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        
        // Check if VMC is in SELF_CONTROLLED mode
        if (this.isSelfControlled) {
            this.log.warn(`Cannot change mode: Device is in SELF_CONTROLLED (force) mode.`);
            
            // Reset characteristic to current value and inform user about restriction
            const currentActiveState = this.currentMode !== 'V' ? 
                this.platform.Characteristic.Active.ACTIVE : 
                this.platform.Characteristic.Active.INACTIVE;
            
            setTimeout(() => {
                this.service.updateCharacteristic(this.platform.Characteristic.Active, currentActiveState);
            }, 100);
            
            // Only pass the status code to match the expected signature
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE
            );
        }
        
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
            }, 100);
            
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.RESOURCE_BUSY
            );
        }
        
        const targetActiveState = value as number; // ACTIVE or INACTIVE
        const targetIsActive = targetActiveState === this.platform.Characteristic.Active.ACTIVE;
        this.log.debug(`SET Active to: ${targetActiveState} (${targetIsActive ? 'ON' : 'OFF'})`);

        const currentIsActive = this.currentMode !== 'V';

        if (targetIsActive === currentIsActive) {
            this.log.debug(`Active state is already ${targetIsActive ? 'ON' : 'OFF'}. No change needed.`);
            // Ensure HomeKit UI matches internal state if needed
            this.service.updateCharacteristic(this.platform.Characteristic.Active, targetActiveState);
            return;
        }

        // Determine target mode: 'V' if turning OFF, DEFAULT_ACTIVE_MODE ('Y') if turning ON
        const targetMode: VmcMode = targetIsActive ? DEFAULT_ACTIVE_MODE : 'V';

        this.log.info(`Setting Active=${targetIsActive ? 'ON' : 'OFF'} by setting mode to ${targetMode}`);

        try {
            this.lastApiUpdate = now; // Record update time
            const success = await this.aldesApi.setVmcMode(this.deviceId, targetMode);
            if (!success) {
                this.log.error(`API call failed to set mode to ${targetMode}`);
                throw new Error('API call failed');
            }

            // Update cache after successful API call
            this.currentMode = targetMode;

            // Update HomeKit characteristics
            const targetSpeed = AldesModeToSpeed[targetMode];
            this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, targetSpeed);
            // Active state should match the requested state
            this.service.updateCharacteristic(this.platform.Characteristic.Active, targetActiveState);

            this.log.info(`Successfully set mode to ${targetMode}`);
            
            // Reset failed update counter after successful update
            this.failedStateUpdates = 0;
            
            // Reset fault state if present
            this.setFaultState(false);

        } catch (error) {
            this.log.error(`Error setting mode to ${targetMode}: ${error}`);
            
            this.failedStateUpdates++;
            if (this.failedStateUpdates >= MAX_FAILED_UPDATES) {
                this.log.warn(`Too many failed updates (${this.failedStateUpdates}), triggering API state reset`);
                this.aldesApi.resetApiState();
                this.failedStateUpdates = 0;
            }
            
            // Trigger a refresh to get the actual current state after failure
            setTimeout(() => this.refreshStatus(), 1000); // Refresh after 1s
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
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
            
            // Reset characteristic to current value and inform user about restriction
            const currentSpeed = AldesModeToSpeed[this.currentMode];
            
            setTimeout(() => {
                this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, currentSpeed);
            }, 100);
            
            // Only pass the status code to match the expected signature
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE
            );
        }
        
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
        this.log.debug(`SET RotationSpeed to: ${speed}%`);

        // Determine target Aldes mode based on speed
        const targetMode = SpeedToAldesMode(speed);
        const targetSpeed = AldesModeToSpeed[targetMode]; // Get the canonical speed for the target mode
        const targetIsActive = targetMode !== 'V';
        const targetActiveState = targetIsActive ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;

        // Check if the mode is already correct
        if (this.currentMode === targetMode) {
            this.log.debug(`Mode is already ${targetMode}. Ensuring speed (${targetSpeed}) and active state (${targetActiveState}) are correct.`);
            // Update HomeKit speed/active state in case the requested 'value' wasn't exactly the step value or active state was wrong
            this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, targetSpeed);
            this.service.updateCharacteristic(this.platform.Characteristic.Active, targetActiveState);
            return;
        }

        // Set the target mode V, Y, or X
        this.log.info(`Setting speed to ${speed}% by setting mode to ${targetMode}`);
        try {
            this.lastApiUpdate = now; // Record update time
            const success = await this.aldesApi.setVmcMode(this.deviceId, targetMode);
            if (!success) {
                 this.log.error(`API call failed to set mode to ${targetMode}`);
                 throw new Error('API call failed');
            }

            // Update cache
            this.currentMode = targetMode;

            // Update HomeKit (ensure Active and Speed are the canonical values for the mode)
            this.service.updateCharacteristic(this.platform.Characteristic.Active, targetActiveState);
            this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, targetSpeed);

            this.log.info(`Successfully set mode to ${targetMode}`);
            
            // Reset failed update counter after successful update
            this.failedStateUpdates = 0;
            
            // Reset fault state if present
            this.setFaultState(false);

        } catch (error) {
            this.log.error(`Error setting mode to ${targetMode}: ${error}`);
            
            this.failedStateUpdates++;
            if (this.failedStateUpdates >= MAX_FAILED_UPDATES) {
                this.log.warn(`Too many failed updates (${this.failedStateUpdates}), triggering API state reset`);
                this.aldesApi.resetApiState();
                this.failedStateUpdates = 0;
            }
            
            // Trigger a refresh to get the actual current state after failure
            setTimeout(() => this.refreshStatus(), 1000); // Refresh after 1s
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }
}
