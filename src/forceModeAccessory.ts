import { Service, PlatformAccessory, Logger } from 'homebridge';
import { AldesVMCPlatform } from './platform.js';
import { AldesAPI } from './aldes_api.js';

// Default polling interval in seconds if not specified in config
const DEFAULT_SENSOR_POLLING_INTERVAL = 60;

/**
 * Force Mode Indicator Accessory
 * This accessory appears as a switch in HomeKit to indicate when the VMC is in Force mode.
 * - Switch ON = Force Mode is active
 * - Switch OFF = Force Mode is inactive (normal operation)
 */
export class ForceModeAccessory {
    private service: Service;
    private isSelfControlled = false;
    private pollingInterval: NodeJS.Timeout | null = null;
    private deviceId: string | null = null;

    constructor(
        private readonly platform: AldesVMCPlatform,
        private readonly accessory: PlatformAccessory,
        private readonly log: Logger,
        private readonly aldesApi: AldesAPI,
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
            // Make the switch read-only by setting a custom error when HomeKit tries to change it
            .onSet((value) => {
                this.log.debug(`HomeKit tried to set Force Mode switch to ${value}`);
                throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
            });
        
        // Initialize the device
        this.initializeDevice();
    }

    async initializeDevice() {
        this.deviceId = await this.aldesApi.getDeviceId();
        if (!this.deviceId) {
            this.log.error(`Failed to initialize Force Mode Accessory: Could not get Device ID.`);
            return;
        }
        
        this.log.info(`Force Mode Accessory initialized with Device ID: ${this.deviceId}`);
        
        // Initial status update
        await this.refreshStatus();
        
        // Start polling for status updates
        this.startPolling();
    }
    
    startPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
        }
        
        // Get polling interval from config, or use default
        const pollingIntervalSeconds = this.platform.config.sensorPollingInterval || DEFAULT_SENSOR_POLLING_INTERVAL;
        const pollIntervalMs = pollingIntervalSeconds * 1000;
        
        this.log.info(`Starting Force Mode polling every ${pollingIntervalSeconds} seconds...`);
        
        this.pollingInterval = setInterval(async () => {
            await this.refreshStatus();
        }, pollIntervalMs);
        
        // Make sure polling stops when homebridge shuts down
        this.platform.api.on('shutdown', () => {
            if (this.pollingInterval) {
                clearInterval(this.pollingInterval);
                this.pollingInterval = null;
                this.log.debug('Force Mode polling stopped due to homebridge shutdown');
            }
        });
    }
    
    async refreshStatus() {
        if (!this.deviceId) return;
        
        try {
            const status = await this.aldesApi.getDeviceStatus(this.deviceId);
            if (!status) {
                this.log.warn(`[Force Mode] Failed to get device status. Keeping cached values.`);
                return;
            }
            
            // Check if self-controlled state has changed
            if (this.isSelfControlled !== status.isSelfControlled) {
                this.isSelfControlled = status.isSelfControlled;
                
                // Update the switch state
                const switchState = this.isSelfControlled;
                
                this.service.updateCharacteristic(
                    this.platform.Characteristic.On,
                    switchState
                );
                
                this.log.info(`Force Mode indicator updated: ${this.isSelfControlled ? 'ACTIVE (ON)' : 'INACTIVE (OFF)'}`);
            }
            
        } catch (error) {
            this.log.error(`Error refreshing Force Mode status: ${error}`);
        }
    }
    
    async handleSwitchStateGet() {
        return this.isSelfControlled;
    }
}