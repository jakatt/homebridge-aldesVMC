import { Service, PlatformAccessory, CharacteristicValue, Logger } from 'homebridge';
import { AldesVMCPlatform } from './platform.js';
import { AldesAPI } from './aldes_api.js';

export class ClimateSensorAccessory {
    private service: Service;
    private deviceId: string | null = null;
    private pollingInterval: NodeJS.Timeout | null = null;
    private currentTemperature: number = 20.0;  // Default value in Celsius
    private currentHumidity: number = 50.0;     // Default value in %

    constructor(
        private readonly platform: AldesVMCPlatform,
        private readonly accessory: PlatformAccessory,
        private readonly log: Logger,
        private readonly aldesApi: AldesAPI,
        private readonly sensorType: 'temperature' | 'humidity',
    ) {
        // Set accessory information
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Aldes')
            .setCharacteristic(this.platform.Characteristic.Model, 
                sensorType === 'temperature' ? 'VMC Temperature Sensor' : 'VMC Humidity Sensor')
            .setCharacteristic(this.platform.Characteristic.SerialNumber, this.accessory.UUID);

        // Create the sensor service based on sensor type
        if (sensorType === 'temperature') {
            this.service = this.accessory.getService(this.platform.Service.TemperatureSensor) || 
                           this.accessory.addService(this.platform.Service.TemperatureSensor);
            
            this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);
            
            // Configure Temperature characteristic
            this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
                .setProps({
                    minValue: -50,
                    maxValue: 100,
                    minStep: 0.1
                })
                .onGet(this.handleTemperatureGet.bind(this));
        } else { // Humidity sensor
            this.service = this.accessory.getService(this.platform.Service.HumiditySensor) || 
                           this.accessory.addService(this.platform.Service.HumiditySensor);
            
            this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);
            
            // Configure Humidity characteristic
            this.service.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
                .onGet(this.handleHumidityGet.bind(this));
        }

        this.initializeDevice();
    }

    async initializeDevice() {
        this.deviceId = await this.aldesApi.getDeviceId();
        if (!this.deviceId) {
            this.log.error(`Failed to initialize ${this.sensorType} Sensor: Could not get Device ID.`);
            return;
        }
        this.log.info(`${this.sensorType} Sensor initialized with Device ID: ${this.deviceId}`);

        // First fetch to populate data
        await this.refreshStatus();
        
        // Start polling for updates
        this.startPolling();
    }

    startPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
        }
        
        // Poll every 30 seconds (more frequent polling for better responsiveness)
        const pollIntervalMs = 30 * 1000;
        
        this.log.info(`Starting ${this.sensorType} polling every ${pollIntervalMs/1000} seconds`);
        
        // Perform an immediate refresh before setting up the interval
        this.refreshStatus().then(() => {
            this.log.debug(`Initial ${this.sensorType} status refresh completed`);
        }).catch(error => {
            this.log.error(`Error during initial ${this.sensorType} status refresh: ${error}`);
        });
        
        this.pollingInterval = setInterval(async () => {
            this.log.debug(`Polling for ${this.sensorType} status update...`);
            await this.refreshStatus();
        }, pollIntervalMs);
        
        // Stop polling when homebridge shuts down
        this.platform.api.on('shutdown', () => {
            if (this.pollingInterval) {
                clearInterval(this.pollingInterval);
                this.pollingInterval = null;
                this.log.debug(`${this.sensorType} polling stopped due to homebridge shutdown`);
            }
        });
    }

    async refreshStatus() {
        if (!this.deviceId) return;

        try {
            const status = await this.aldesApi.getDeviceStatus(this.deviceId);
            if (!status) {
                this.log.warn(`[Refresh] Failed to get device status for ${this.sensorType} sensor`);
                return;
            }

            // Update temperature data if available
            if (this.sensorType === 'temperature' && status.temperature !== undefined) {
                this.currentTemperature = status.temperature;
                this.log.debug(`Updated temperature: ${this.currentTemperature}°C`);
                this.service.updateCharacteristic(
                    this.platform.Characteristic.CurrentTemperature, 
                    this.currentTemperature
                );
            }

            // Update humidity data if available
            if (this.sensorType === 'humidity' && status.humidity !== undefined) {
                this.currentHumidity = status.humidity;
                this.log.debug(`Updated humidity: ${this.currentHumidity}%`);
                this.service.updateCharacteristic(
                    this.platform.Characteristic.CurrentRelativeHumidity, 
                    this.currentHumidity
                );
            }
        } catch (error) {
            this.log.error(`Error refreshing status for ${this.sensorType} sensor: ${error}`);
        }
    }

    // Characteristic Handlers
    
    async handleTemperatureGet(): Promise<CharacteristicValue> {
        return this.currentTemperature;
    }

    async handleHumidityGet(): Promise<CharacteristicValue> {
        return this.currentHumidity;
    }
}