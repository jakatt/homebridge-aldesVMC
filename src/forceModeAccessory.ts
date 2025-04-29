import { Service, PlatformAccessory, Logger } from 'homebridge';
import { AldesVMCPlatform } from './platform.js';
import { AldesAPI, AldesDeviceStatus } from './aldes_api.js';

/**
 * Force Mode Indicator Accessory
 * This accessory appears as a switch in HomeKit to indicate when the VMC is in Force mode.
 * - Switch ON = Force Mode is active
 * - Switch OFF = Force Mode is inactive (normal operation)
 */
export class ForceModeAccessory {
    private service: Service;
    private isSelfControlled = false;

    constructor(
        private readonly platform: AldesVMCPlatform,
        public readonly accessory: PlatformAccessory,
        private readonly log: Logger,
        private readonly aldesApi: AldesAPI, // Keep AldesAPI if needed for future direct calls
    ) {
        // Set up accessory information
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Aldes')
            .setCharacteristic(this.platform.Characteristic.Model, 'VMC Force Mode Indicator')
            .setCharacteristic(this.platform.Characteristic.SerialNumber, this.accessory.UUID);

        // Remove old contact sensor service if it exists
        const contactSensorService = this.accessory.getService(this.platform.Service.ContactSensor);
        if (contactSensorService) {
            this.accessory.removeService(contactSensorService);
            this.log.debug('Removed old contact sensor service');
        }

        // Get or create the switch service
        this.service = this.accessory.getService(this.platform.Service.Switch) || 
                      this.accessory.addService(this.platform.Service.Switch);
        
        // Set the service name explicitly
        this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);
        
        // Initialize the switch (default to OFF/normal state)
        this.service.setCharacteristic(
            this.platform.Characteristic.On,
            false
        );

        // Add a handler for the switch state
        this.service.getCharacteristic(this.platform.Characteristic.On)
            .onGet(this.handleSwitchStateGet.bind(this))
            // Make the switch read-only
            .onSet((value) => {
                this.log.debug(`HomeKit tried to set Force Mode switch to ${value}`);
                throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
            });
        
        this.log.debug(`${this.accessory.displayName} initialized, waiting for platform status updates.`);
    }

    // Method to receive status updates from the platform
    public updateStatus(status: AldesDeviceStatus) {
        if (!status) return;
        const newSelfControlled = status.isSelfControlled;
        if (this.isSelfControlled !== newSelfControlled) {
            if (this.platform.shouldLog('info')) this.log.info(`Updating Force Mode indicator: ${this.isSelfControlled} -> ${newSelfControlled}`);
            this.isSelfControlled = newSelfControlled;
            this.service.updateCharacteristic(
                this.platform.Characteristic.On,
                this.isSelfControlled
            );
        }
    }
    
    async handleSwitchStateGet() {
        this.log.debug(`GET Force Mode Switch State: Returning ${this.isSelfControlled}`);
        return this.isSelfControlled;
    }
}