import { Service, PlatformAccessory, CharacteristicValue, Logger, Characteristic } from 'homebridge'; // Ensure Characteristic is imported
import { AldesVMCPlatform } from './platform';
import { AldesAPI, VmcMode } from './aldes_api';

// --- Constants for Aldes Modes to HomeKit Fan States ---
// Map Aldes modes to HomeKit RotationSpeed percentages
const AldesModeToSpeed: Record<VmcMode, number> = {
    'V': 33,  // Standard/Vacation (represents INACTIVE state speed)
    'Y': 66,  // Boost/Daily
    'X': 100, // Guests/Max
};
// Map HomeKit RotationSpeed percentages back to Aldes modes
const SpeedToAldesMode = (speed: number): VmcMode => {
    // If speed is low, map to 'V'. Otherwise, find closest higher mode.
    if (speed <= AldesModeToSpeed['V']) return 'V'; // Speeds up to 33% map to 'V'
    if (speed <= AldesModeToSpeed['Y']) return 'Y'; // Speeds 34-66% map to 'Y'
    return 'X';                                     // Speeds 67-100% map to 'X'
};
const DEFAULT_ACTIVE_MODE: VmcMode = 'Y'; // Default mode when turning fan ON

export class VmcAccessory {
    private service: Service;
    private deviceId: string | null = null;
    private currentMode: VmcMode = 'V'; // Default to 'V' initially
    // isActive is now derived directly from currentMode !== 'V'

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
        const servicesToRemove: (typeof Service)[] = [
            this.platform.Service.Switch,
            this.platform.Service.Outlet,
            this.platform.Service.Thermostat,
        ];
        servicesToRemove.forEach(serviceType => {
            // Cast serviceType to 'any' to bypass strict type checking for static UUID access
            const serviceUUID = (serviceType as any).UUID;
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
                 minValue: 0,   // Keep 0 for UI purposes, map it to 'V'
                 maxValue: 100,
                 minStep: 1,    // Allow smooth slider
             })
             .onGet(this.handleRotationSpeedGet.bind(this))
             .onSet(this.handleRotationSpeedSet.bind(this));
        // --- End Fanv2 Service Initialization ---

        this.initializeDevice();
    }

    async initializeDevice() {
        this.deviceId = await this.aldesApi.getDeviceId();
        if (!this.deviceId) {
            this.log.error(`Failed to initialize VMC Accessory ${this.accessory.displayName}: Could not get Device ID.`);
            // Consider disabling the accessory or preventing handlers from running
            return;
        }
        this.log.info(`VMC Accessory ${this.accessory.displayName} initialized with Device ID: ${this.deviceId}`);
        // Perform an initial status fetch to populate cache
        await this.refreshStatus();
    }

    // Method to fetch current status and update cache + HomeKit state
    async refreshStatus() {
        if (!this.deviceId) return;

        this.log.debug(`Refreshing status for ${this.accessory.displayName}...`);
        try {
            const mode = await this.aldesApi.getCurrentMode(this.deviceId);
            if (mode) { // Only update if API returns a valid mode
                this.currentMode = mode;
            } else {
                this.log.warn(`[Refresh] Received null/undefined mode from API. Keeping cached mode: ${this.currentMode}`);
                // Optionally handle error state here, e.g., set to 'V' or throw error
            }

            const isActiveState = this.currentMode !== 'V'; // Active if mode is Y or X
            const currentSpeed = AldesModeToSpeed[this.currentMode];
            const currentActiveState = isActiveState ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;

            this.log.debug(`Refreshed Status - Mode: ${this.currentMode}, ActiveState: ${currentActiveState}, Speed: ${currentSpeed}`);

            // Update HomeKit state non-blockingly
            this.service.updateCharacteristic(this.platform.Characteristic.Active, currentActiveState);
            this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, currentSpeed);

        } catch (error) {
            this.log.error(`Error refreshing status for ${this.accessory.displayName}: ${error}`);
            // Optionally update HomeKit to show an error state?
        }
    }


    async handleActiveGet(): Promise<CharacteristicValue> {
        if (!this.deviceId) {
             this.log.warn(`Cannot get active state for ${this.accessory.displayName}: Device ID not available.`);
             throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        // Determine active state based on cached mode
        const isActiveState = this.currentMode !== 'V';
        const state = isActiveState ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;
        this.log.debug(`GET Active for ${this.accessory.displayName}: Returning ${state} (Mode: ${this.currentMode})`);
        return state;
    }

    async handleActiveSet(value: CharacteristicValue) {
        if (!this.deviceId) {
            this.log.warn(`Cannot set active state for ${this.accessory.displayName}: Device ID not available.`);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        const targetActiveState = value as number; // ACTIVE or INACTIVE
        const targetIsActive = targetActiveState === this.platform.Characteristic.Active.ACTIVE;
        this.log.debug(`SET Active for ${this.accessory.displayName} to: ${targetActiveState} (${targetIsActive})`);

        const currentIsActive = this.currentMode !== 'V';

        if (targetIsActive === currentIsActive) {
            this.log.debug(`Active state is already ${targetIsActive}. No change needed.`);
            // Ensure HomeKit UI matches internal state if needed
            this.service.updateCharacteristic(this.platform.Characteristic.Active, targetActiveState);
            return;
        }

        // Determine target mode: 'V' if turning OFF, DEFAULT_ACTIVE_MODE ('Y') if turning ON
        const targetMode: VmcMode = targetIsActive ? DEFAULT_ACTIVE_MODE : 'V';

        this.log.info(`Setting ${this.accessory.displayName} Active=${targetIsActive} by setting mode to ${targetMode}`);

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

            this.log.info(`Successfully set mode to ${targetMode} for ${this.accessory.displayName}`);

        } catch (error) {
            this.log.error(`Error setting mode to ${targetMode} for ${this.accessory.displayName}: ${error}`);
            setTimeout(() => this.refreshStatus(), 1000); // Refresh after 1s
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    async handleRotationSpeedGet(): Promise<CharacteristicValue> {
         if (!this.deviceId) {
             this.log.warn(`Cannot get speed for ${this.accessory.displayName}: Device ID not available.`);
             throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        const speed = AldesModeToSpeed[this.currentMode];
        this.log.debug(`GET RotationSpeed for ${this.accessory.displayName}: Returning ${speed} (Mode: ${this.currentMode})`);
        return speed;
    }

    async handleRotationSpeedSet(value: CharacteristicValue) {
         if (!this.deviceId) {
            this.log.warn(`Cannot set speed for ${this.accessory.displayName}: Device ID not available.`);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        const speed = value as number;
        this.log.debug(`SET RotationSpeed for ${this.accessory.displayName} to: ${speed}`);

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
        this.log.info(`Setting ${this.accessory.displayName} speed to ${speed} by setting mode to ${targetMode}`);
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

            this.log.info(`Successfully set mode to ${targetMode} for ${this.accessory.displayName}`);

        } catch (error) {
            this.log.error(`Error setting mode to ${targetMode} for ${this.accessory.displayName}: ${error}`);
            // Trigger a refresh to get the actual current state after failure
            setTimeout(() => this.refreshStatus(), 1000); // Refresh after 1s
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }
}
