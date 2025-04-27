import { Service, PlatformAccessory, CharacteristicValue, Logger } from 'homebridge';
import { AldesVMCPlatform } from './platform.js'; // Add .js extension
import { AldesAPI, VmcMode } from './aldes_api.js'; // Add .js extension

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
const DEFAULT_ACTIVE_MODE: VmcMode = 'Y'; // Default mode when turning fan ON remains Boost ('Y')

export class VmcAccessory {
    private service: Service;
    private deviceId: string | null = null;
    private currentMode: VmcMode = 'V'; // Default to 'V' initially
    private isSelfControlled = false; // Track if VMC is in SELF_CONTROLLED mode
    private pollingInterval: NodeJS.Timeout | null = null; // For status polling
    private lastMode: VmcMode | null = null; // Track last mode to detect changes

    constructor(
        private readonly platform: AldesVMCPlatform,
        private readonly accessory: PlatformAccessory,
        private readonly log: Logger,
        private readonly aldesApi: AldesAPI,
    ) {
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Aldes')
            .setCharacteristic(this.platform.Characteristic.Model, 'VMC Fan Control') // Updated model
            .setCharacteristic(this.platform.Characteristic.SerialNumber, this.accessory.UUID);

        // --- Remove Old/Unwanted Services ---
        // Use the more specific type for the array
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
        // --- End Fanv2 Service Initialization ---

        this.initializeDevice();
    }

    async initializeDevice() {
        this.deviceId = await this.aldesApi.getDeviceId();
        if (!this.deviceId) {
            this.log.error(`Failed to initialize VMC Accessory: Could not get Device ID.`);
            return;
        }
        this.log.info(`VMC Accessory initialized with Device ID: ${this.deviceId}`);
        // Perform an initial status fetch to populate cache
        await this.refreshStatus();
        
        // Start polling for status updates
        this.startPolling();
    }
    
    // Set up polling mechanism to detect external changes
    startPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
        }
        
        // Poll every 5 minutes
        const pollIntervalMs = 5 * 60 * 1000; // 5 minutes
        
        this.log.info(`Starting polling for external changes every ${pollIntervalMs/60000} minutes...`);
        
        this.pollingInterval = setInterval(async () => {
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
    
    async checkForExternalChanges() {
        if (!this.deviceId) return;
        
        try {
            const status = await this.aldesApi.getDeviceStatus(this.deviceId);
            if (!status || !status.mode) {
                this.log.debug('Polling skipped: Could not get valid device status');
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
                
                // Update HomeKit fan state
                const isActiveState = this.currentMode !== 'V';
                const currentSpeed = AldesModeToSpeed[this.currentMode];
                const currentActiveState = isActiveState ? 
                    this.platform.Characteristic.Active.ACTIVE : 
                    this.platform.Characteristic.Active.INACTIVE;
                
                this.service.updateCharacteristic(this.platform.Characteristic.Active, currentActiveState);
                this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, currentSpeed);
            }
        } catch (error) {
            this.log.error(`Error checking for external changes: ${error}`);
        }
    }

    // Method to fetch current status and update cache + HomeKit state
    async refreshStatus() {
        if (!this.deviceId) return;

        this.log.debug(`Refreshing status...`);
        try {
            const status = await this.aldesApi.getDeviceStatus(this.deviceId);
            if (!status) {
                this.log.warn(`[Refresh] Failed to get device status. Keeping cached values.`);
                return;
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
            const currentActiveState = isActiveState ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;

            this.log.debug(`Refreshed Status - Mode: ${this.currentMode}, ActiveState: ${currentActiveState}, Speed: ${currentSpeed}, SelfControlled: ${this.isSelfControlled}`);

            // Update HomeKit state non-blockingly
            this.service.updateCharacteristic(this.platform.Characteristic.Active, currentActiveState);
            this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, currentSpeed);

        } catch (error) {
            this.log.error(`Error refreshing status: ${error}`);
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

        } catch (error) {
            this.log.error(`Error setting mode to ${targetMode}: ${error}`);
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

        } catch (error) {
            this.log.error(`Error setting mode to ${targetMode}: ${error}`);
            // Trigger a refresh to get the actual current state after failure
            setTimeout(() => this.refreshStatus(), 1000); // Refresh after 1s
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }
}
