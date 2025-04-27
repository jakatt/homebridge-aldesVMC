import { Service, PlatformAccessory, CharacteristicValue, Logger } from 'homebridge';
import { AldesVMCPlatform } from './platform.js';
import { AldesAPI } from './aldes_api.js';

// Define the sensor types and locations
type SensorType = 'temperature' | 'humidity';
type SensorLocation = 'main' | 'ba1' | 'ba2';  // main = Kitchen, ba1 = Bathroom1, ba2 = Bathroom2

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
        private readonly sensorType: SensorType,
        private readonly sensorLocation: SensorLocation = 'main',
    ) {
        // Set accessory information
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Aldes')
            .setCharacteristic(this.platform.Characteristic.Model, 
                `VMC ${sensorType === 'temperature' ? 'Temperature' : 'Humidity'} Sensor ${this.getLocationName()}`)
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

    // Helper method to get human-readable location names
    private getLocationName(): string {
        switch (this.sensorLocation) {
            case 'main': return 'Kitchen';
            case 'ba1': return 'Bathroom1';
            case 'ba2': return 'Bathroom2';
            default: return this.sensorLocation;
        }
    }

    async initializeDevice() {
        this.deviceId = await this.aldesApi.getDeviceId();
        if (!this.deviceId) {
            this.log.error(`Failed to initialize ${this.sensorType} Sensor (${this.getLocationName()}): Could not get Device ID.`);
            return;
        }
        this.log.info(`${this.sensorType} Sensor (${this.getLocationName()}) initialized with Device ID: ${this.deviceId}`);

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
        
        this.log.info(`Starting ${this.sensorType} (${this.getLocationName()}) polling every ${pollIntervalMs/1000} seconds`);
        
        // Perform an immediate refresh before setting up the interval
        this.refreshStatus().then(() => {
            this.log.debug(`Initial ${this.sensorType} (${this.getLocationName()}) status refresh completed`);
        }).catch(error => {
            this.log.error(`Error during initial ${this.sensorType} (${this.getLocationName()}) status refresh: ${error}`);
        });
        
        this.pollingInterval = setInterval(async () => {
            this.log.debug(`Polling for ${this.sensorType} (${this.getLocationName()}) status update...`);
            await this.refreshStatus();
        }, pollIntervalMs);
        
        // Stop polling when homebridge shuts down
        this.platform.api.on('shutdown', () => {
            if (this.pollingInterval) {
                clearInterval(this.pollingInterval);
                this.pollingInterval = null;
                this.log.debug(`${this.sensorType} (${this.getLocationName()}) polling stopped due to homebridge shutdown`);
            }
        });
    }

    async refreshStatus() {
        if (!this.deviceId) return;

        try {
            const status = await this.aldesApi.getDeviceStatus(this.deviceId);
            if (!status) {
                this.log.warn(`[Refresh] Failed to get device status for ${this.sensorType} sensor (${this.getLocationName()})`);
                return;
            }

            // Update temperature data based on sensor location
            if (this.sensorType === 'temperature') {
                let tempValue: number | undefined;
                
                switch (this.sensorLocation) {
                    case 'main':
                        tempValue = status.temperature;
                        break;
                    case 'ba1':
                        tempValue = status.temperatureBa1;
                        break;
                    case 'ba2':
                        tempValue = status.temperatureBa2;
                        break;
                }
                
                if (tempValue !== undefined) {
                    this.currentTemperature = tempValue;
                    this.log.debug(`Updated temperature (${this.getLocationName()}): ${this.currentTemperature}°C`);
                    this.service.updateCharacteristic(
                        this.platform.Characteristic.CurrentTemperature, 
                        this.currentTemperature
                    );
                }
            }

            // Update humidity data based on sensor location
            if (this.sensorType === 'humidity') {
                let humValue: number | undefined;
                
                switch (this.sensorLocation) {
                    case 'main':
                        humValue = status.humidity;
                        break;
                    case 'ba1':
                        humValue = status.humidityBa1;
                        break;
                    case 'ba2':
                        humValue = status.humidityBa2;
                        break;
                }
                
                if (humValue !== undefined) {
                    this.currentHumidity = humValue;
                    this.log.debug(`Updated humidity (${this.getLocationName()}): ${this.currentHumidity}%`);
                    this.service.updateCharacteristic(
                        this.platform.Characteristic.CurrentRelativeHumidity, 
                        this.currentHumidity
                    );
                }
            }
        } catch (error) {
            this.log.error(`Error refreshing status for ${this.sensorType} sensor (${this.getLocationName()}): ${error}`);
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