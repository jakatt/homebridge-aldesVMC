import { Service, PlatformAccessory, CharacteristicValue, Logger } from 'homebridge'; // Removed API import if not used directly
import { AldesVMCPlatform } from './platform';
import { AldesAPI, VmcMode } from './aldes_api';

// --- Constants for Aldes Modes to HomeKit Fan States ---
// Map Aldes modes to HomeKit RotationSpeed percentages
const AldesModeToSpeed: Record<VmcMode, number> = {
    // Adjust these values based on your testing:
    'V': 33,  // If 'V' is lowest speed
    'Y': 66,  // If 'Y' is medium speed
    'X': 100, // If 'X' is highest speed
};
// Map HomeKit RotationSpeed percentages back to Aldes modes
// Find the closest mode for a given speed percentage
const SpeedToAldesMode = (speed: number): VmcMode => {
    // Adjust the thresholds based on your testing and desired behavior:
    if (speed <= 33) return 'V'; // Speeds 1-33% map to 'V'
    if (speed <= 66) return 'Y'; // Speeds 34-66% map to 'Y'
    return 'X';                 // Speeds 67-100% map to 'X'
};
const OFF_SPEED = 0; // HomeKit Fan Off speed

export class VmcAccessory {
    private service: Service;
    private deviceId: string | null = null;
    private currentMode: VmcMode | null = null; // Cache the last known mode
    private isActive: boolean = false; // Cache the last known active state

    constructor(
        private readonly platform: AldesVMCPlatform,
        private readonly accessory: PlatformAccessory,
        private readonly log: Logger,
        private readonly aldesApi: AldesAPI,
    ) {
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Aldes')
            .setCharacteristic(this.platform.Characteristic.Model, 'VMC') // Replace with actual model if known
            .setCharacteristic(this.platform.Characteristic.SerialNumber, this.accessory.UUID); // Use UUID or fetched ID

        this.service = this.accessory.getService(this.platform.Service.Fanv2) || this.accessory.addService(this.platform.Service.Fanv2);
        this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

        this.service.getCharacteristic(this.platform.Characteristic.Active)
            .onGet(this.handleActiveGet.bind(this))
            .onSet(this.handleActiveSet.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
             // Set props for steps if you only want discrete speeds (33, 66, 100)
             .setProps({
                 minValue: 0,
                 maxValue: 100,
                 minStep: 33, // Allows speeds like 0, 33, 66, 99 (or 100)
             })
             .onGet(this.handleRotationSpeedGet.bind(this))
             .onSet(this.handleRotationSpeedSet.bind(this));

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
        if (!this.deviceId) return; // Don't refresh if no ID

        this.log.debug(`Refreshing status for ${this.accessory.displayName}...`);
        try {
            const mode = await this.aldesApi.getCurrentMode(this.deviceId);
            this.currentMode = mode;
            // Assuming 'V' mode means it's technically ON but at minimum.
            // If Aldes truly has an OFF state reportable via API, adjust this.
            this.isActive = mode !== null; // Active if any mode is reported

            const currentSpeed = this.isActive && this.currentMode ? AldesModeToSpeed[this.currentMode] : OFF_SPEED;
            const currentActiveState = this.isActive ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;

            this.log.debug(`Refreshed Status - Mode: ${this.currentMode}, Active: ${this.isActive}, Speed: ${currentSpeed}`);

            // Update HomeKit state non-blockingly
            this.service.updateCharacteristic(this.platform.Characteristic.Active, currentActiveState);
            this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, currentSpeed);

        } catch (error) {
            this.log.error(`Error refreshing status for ${this.accessory.displayName}: ${error}`);
            // Optionally update HomeKit to show an error state?
        }
    }


    async handleActiveGet(): Promise<CharacteristicValue> {
        // Return cached state, potentially trigger a refresh first if needed frequently
        // await this.refreshStatus(); // Uncomment if fresh data is always needed on GET
        if (!this.deviceId) { // Check if deviceId failed initialization
             this.log.warn(`Cannot get active state for ${this.accessory.displayName}: Device ID not available.`);
             throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        const state = this.isActive ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;
        this.log.debug(`GET Active for ${this.accessory.displayName}: Returning ${state} (Cached: ${this.isActive})`);
        return state;
    }

    async handleActiveSet(value: CharacteristicValue) {
        if (!this.deviceId) {
            this.log.warn(`Cannot set active state for ${this.accessory.displayName}: Device ID not available.`);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        const targetActive = value === this.platform.Characteristic.Active.ACTIVE;
        this.log.debug(`SET Active for ${this.accessory.displayName} to: ${targetActive}`);

        if (targetActive === this.isActive) {
            this.log.debug(`Active state is already ${targetActive}. No change needed.`);
            return;
        }

        // If turning ON, set to 'Y' (Daily/Auto) or last known mode if available?
        // If turning OFF, set to 'V' (Vacation/Min) as Aldes might not have true OFF.
        const targetMode: VmcMode = targetActive ? (this.currentMode || 'Y') : 'V';
        // If turning off, we actually set mode 'V'. If turning on, set mode 'Y' or restore previous.
        // The 'isActive' state will be derived from the mode ('V', 'Y', 'X' are all considered active).

        this.log.info(`Setting ${this.accessory.displayName} Active=${targetActive} by setting mode to ${targetMode}`);

        try {
            const success = await this.aldesApi.setVmcMode(this.deviceId, targetMode);
            if (!success) {
                this.log.error(`API call failed to set mode to ${targetMode}`);
                throw new Error('API call failed'); // Trigger catch block
            }

            // Update cache after successful API call
            this.currentMode = targetMode;
            this.isActive = true; // Since V, Y, X are all active states

            // Update HomeKit characteristics
            const targetSpeed = AldesModeToSpeed[targetMode];
            this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, targetSpeed);
            // Active state should update automatically based on speed > 0, but update explicitly if needed
            this.service.updateCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.ACTIVE);

            this.log.info(`Successfully set mode to ${targetMode} for ${this.accessory.displayName}`);

        } catch (error) {
            this.log.error(`Error setting mode to ${targetMode} for ${this.accessory.displayName}: ${error}`);
            // Revert optimistic update or refresh status? For now, just throw.
            // Trigger a refresh to get the actual current state after failure
            setTimeout(() => this.refreshStatus(), 1000); // Refresh after 1s
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    async handleRotationSpeedGet(): Promise<CharacteristicValue> {
        // Return cached state, potentially trigger a refresh first
        // await this.refreshStatus(); // Uncomment if fresh data is always needed on GET
         if (!this.deviceId) {
             this.log.warn(`Cannot get speed for ${this.accessory.displayName}: Device ID not available.`);
             throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        const speed = this.isActive && this.currentMode ? AldesModeToSpeed[this.currentMode] : OFF_SPEED;
        this.log.debug(`GET RotationSpeed for ${this.accessory.displayName}: Returning ${speed} (Cached Mode: ${this.currentMode}, Active: ${this.isActive})`);
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

        // Check if the mode is already correct
        if (this.isActive && this.currentMode === targetMode) {
            this.log.debug(`Mode is already ${targetMode}. Ensuring speed is ${targetSpeed}.`);
            // Update HomeKit speed in case the requested 'value' wasn't exactly the step value
            this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, targetSpeed);
            this.service.updateCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.ACTIVE);
            return;
        }

        // If speed is 0, handle like setting Active to INACTIVE (which sets mode 'V')
        if (speed === OFF_SPEED) {
            this.log.info(`RotationSpeed set to ${OFF_SPEED}. Setting Active to INACTIVE (Mode V).`);
            // Delegate to handleActiveSet to turn "off" (set mode V)
            await this.handleActiveSet(this.platform.Characteristic.Active.INACTIVE);
            return; // Exit after handling off state
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
            this.isActive = true;

            // Update HomeKit (ensure Active is ON and Speed is the canonical value)
            this.service.updateCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.ACTIVE);
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
