import { Service, PlatformAccessory, CharacteristicValue, Logger } from 'homebridge';
import { AldesVMCPlatform } from './platform.js';
import { AldesAPI, AldesDeviceStatus } from './aldes_api.js';

// Define the sensor types and locations
type SensorType = 'temperature' | 'humidity';
type SensorLocation = 'main' | 'ba1' | 'ba2' | 'ba3' | 'ba4';  // Support up to 4 additional sensors

export class ClimateSensorAccessory {
    private service: Service;
    private currentTemperature: number = 20.0;  // Default value in Celsius
    private currentHumidity: number = 50.0;     // Default value in %

    constructor(
        private readonly platform: AldesVMCPlatform,
        public readonly accessory: PlatformAccessory,
        private readonly log: Logger,
        private readonly aldesApi: AldesAPI, // Keep AldesAPI if needed for future direct calls, though unlikely now
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

        this.log.debug(`${this.accessory.displayName} initialized, waiting for platform status updates.`);
    }

    // Helper method to get human-readable location names
    private getLocationName(): string {
        switch (this.sensorLocation) {
            case 'main': return 'Main ⌀125';
            case 'ba1': return 'Room 1 ⌀80';
            case 'ba2': return 'Room 2 ⌀80';
            case 'ba3': return 'Room 3 ⌀80';
            case 'ba4': return 'Room 4 ⌀80';
            default: return this.sensorLocation;
        }
    }

    // Method to receive status updates from the platform
    public updateStatus(status: AldesDeviceStatus) {
        if (!status) return;

        // Update temperature data based on sensor location
        if (this.sensorType === 'temperature') {
            let tempValue: number | undefined;
            
            switch (this.sensorLocation) {
                case 'main': tempValue = status.temperature; break;
                case 'ba1': tempValue = status.temperatureBa1; break;
                case 'ba2': tempValue = status.temperatureBa2; break;
                case 'ba3': tempValue = status.temperatureBa3; break;
                case 'ba4': tempValue = status.temperatureBa4; break;
            }
            
            if (tempValue !== undefined && tempValue !== this.currentTemperature) {
                this.log.info(`Updating temperature (${this.getLocationName()}): ${this.currentTemperature}°C -> ${tempValue}°C`);
                this.currentTemperature = tempValue;
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
                case 'main': humValue = status.humidity; break;
                case 'ba1': humValue = status.humidityBa1; break;
                case 'ba2': humValue = status.humidityBa2; break;
                case 'ba3': humValue = status.humidityBa3; break;
                case 'ba4': humValue = status.humidityBa4; break;
            }
            
            if (humValue !== undefined && humValue !== this.currentHumidity) {
                this.log.info(`Updating humidity (${this.getLocationName()}): ${this.currentHumidity}% -> ${humValue}%`);
                this.currentHumidity = humValue;
                this.service.updateCharacteristic(
                    this.platform.Characteristic.CurrentRelativeHumidity, 
                    this.currentHumidity
                );
            }
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