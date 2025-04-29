import { Service, PlatformAccessory, CharacteristicValue, Logger } from 'homebridge';
import { AldesVMCPlatform } from './platform.js';
import { AldesAPI, AldesDeviceStatus } from './aldes_api.js';

export class AirQualitySensorAccessory {
    private service: Service;
    private currentAirQualityValue: number | null = null;
    private currentCO2Value: number | null = null;
    private currentCO2Detected: number = this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL;

    constructor(
        private readonly platform: AldesVMCPlatform,
        public readonly accessory: PlatformAccessory,
        private readonly log: Logger,
        private readonly aldesApi: AldesAPI,
        private readonly sensorType: 'airQuality' | 'co2' // Type to distinguish sensor
    ) {
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Aldes')
            .setCharacteristic(this.platform.Characteristic.Model, 
                sensorType === 'airQuality' ? 'Air Quality Sensor' : 'CO2 Sensor')
            .setCharacteristic(this.platform.Characteristic.SerialNumber, this.accessory.UUID);

        this.service = this.accessory.getService(this.platform.Service.AirQualitySensor) || 
                       this.accessory.addService(this.platform.Service.AirQualitySensor);

        this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

        // Configure based on sensor type
        if (this.sensorType === 'airQuality') {
            this.service.getCharacteristic(this.platform.Characteristic.AirQuality)
                .onGet(this.handleAirQualityGet.bind(this));
            // Remove CO2 characteristics if they exist from a previous setup
            if (this.service.testCharacteristic(this.platform.Characteristic.CarbonDioxideLevel)) {
                this.service.removeCharacteristic(this.service.getCharacteristic(this.platform.Characteristic.CarbonDioxideLevel));
            }
            if (this.service.testCharacteristic(this.platform.Characteristic.CarbonDioxideDetected)) {
                this.service.removeCharacteristic(this.service.getCharacteristic(this.platform.Characteristic.CarbonDioxideDetected));
            }
        } else { // 'co2'
            this.service.getCharacteristic(this.platform.Characteristic.CarbonDioxideLevel)
                .onGet(this.handleCO2LevelGet.bind(this));
            this.service.getCharacteristic(this.platform.Characteristic.CarbonDioxideDetected)
                .onGet(this.handleCO2DetectedGet.bind(this));
            // Ensure AirQuality characteristic is linked if needed by HomeKit, but primarily use CO2
             if (!this.service.testCharacteristic(this.platform.Characteristic.AirQuality)) {
                 this.service.addCharacteristic(this.platform.Characteristic.AirQuality);
             }
            this.service.getCharacteristic(this.platform.Characteristic.AirQuality)
                .onGet(this.handleAirQualityGetFromCO2.bind(this)); // Map CO2 to AirQuality
        }

        // No explicit initialization needed, waits for platform update
        this.log.debug(`${this.accessory.displayName} initialized, waiting for platform status updates.`);
    }

    // Method to receive status updates from the platform
    public updateStatus(status: AldesDeviceStatus) {
        if (!status) return;
        if (this.sensorType === 'airQuality' && status.airQuality !== undefined && status.airQuality !== null) {
            const newAirQuality = this.mapAldesQualityToHomeKit(status.airQuality);
            if (newAirQuality !== this.currentAirQualityValue) {
                if (this.platform.shouldLog('info')) this.log.info(`Updating air quality (${this.accessory.displayName}): ${this.currentAirQualityValue} -> ${newAirQuality} (Raw: ${status.airQuality})`);
                this.currentAirQualityValue = newAirQuality;
                this.service.updateCharacteristic(this.platform.Characteristic.AirQuality, newAirQuality);
            }
        } else if (this.sensorType === 'co2' && status.co2Level !== undefined && status.co2Level !== null) {
            const newCO2Level = status.co2Level;
            const newCO2Detected = newCO2Level > 1000 ? 
                this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL : 
                this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL;
            const newAirQualityFromCO2 = this.mapCO2ToHomeKitAirQuality(newCO2Level);
            let updated = false;
            if (newCO2Level !== this.currentCO2Value) {
                if (this.platform.shouldLog('info')) this.log.info(`Updating CO2 level (${this.accessory.displayName}): ${this.currentCO2Value} -> ${newCO2Level} ppm`);
                this.currentCO2Value = newCO2Level;
                this.service.updateCharacteristic(this.platform.Characteristic.CarbonDioxideLevel, newCO2Level);
                updated = true;
            }
            if (newCO2Detected !== this.currentCO2Detected) {
                if (this.platform.shouldLog('info')) this.log.info(`Updating CO2 detected state (${this.accessory.displayName}): ${this.currentCO2Detected} -> ${newCO2Detected}`);
                this.currentCO2Detected = newCO2Detected;
                this.service.updateCharacteristic(this.platform.Characteristic.CarbonDioxideDetected, newCO2Detected);
                updated = true;
            }
            const currentAirQuality = this.service.getCharacteristic(this.platform.Characteristic.AirQuality).value;
            if (newAirQualityFromCO2 !== currentAirQuality) {
                if (this.platform.shouldLog('debug')) this.log.debug(`Updating mapped AirQuality from CO2 (${this.accessory.displayName}): ${currentAirQuality} -> ${newAirQualityFromCO2}`);
                this.service.updateCharacteristic(this.platform.Characteristic.AirQuality, newAirQualityFromCO2);
                updated = true;
            }
            if (updated && this.platform.shouldLog('debug')) {
                this.log.debug(`CO2 sensor (${this.accessory.displayName}) updated: level=${newCO2Level} ppm, detected=${newCO2Detected}`);
            }
        }
    }

    // --- GET Handlers --- 
    async handleAirQualityGet(): Promise<CharacteristicValue> {
        const airQuality = this.currentAirQualityValue ?? this.platform.Characteristic.AirQuality.UNKNOWN;
        this.log.debug(`GET AirQuality (${this.accessory.displayName}): Returning ${airQuality}`);
        return airQuality;
    }

    async handleCO2LevelGet(): Promise<CharacteristicValue> {
        const co2Level = this.currentCO2Value ?? 0; // Default to 0 if null
        this.log.debug(`GET CarbonDioxideLevel (${this.accessory.displayName}): Returning ${co2Level} ppm`);
        return co2Level;
    }

    async handleCO2DetectedGet(): Promise<CharacteristicValue> {
        const co2Detected = this.currentCO2Detected;
        this.log.debug(`GET CarbonDioxideDetected (${this.accessory.displayName}): Returning ${co2Detected}`);
        return co2Detected;
    }
    
    // GET handler for AirQuality characteristic on the CO2 sensor
    async handleAirQualityGetFromCO2(): Promise<CharacteristicValue> {
        const co2Level = this.currentCO2Value;
        const airQuality = this.mapCO2ToHomeKitAirQuality(co2Level);
        this.log.debug(`GET AirQuality (from CO2) (${this.accessory.displayName}): Returning ${airQuality} (CO2: ${co2Level})`);
        return airQuality;
    }

    // --- Utility Methods ---
    // Map Aldes QAI (0-100, lower is better) to HomeKit AirQuality (1-5, lower is better)
    mapAldesQualityToHomeKit(aldesValue: number): number {
        if (aldesValue <= 15) return this.platform.Characteristic.AirQuality.EXCELLENT; // 0-15
        if (aldesValue <= 30) return this.platform.Characteristic.AirQuality.GOOD;      // 16-30
        if (aldesValue <= 50) return this.platform.Characteristic.AirQuality.FAIR;       // 31-50
        if (aldesValue <= 75) return this.platform.Characteristic.AirQuality.INFERIOR;   // 51-75
        return this.platform.Characteristic.AirQuality.POOR; // 76+
    }
    
    // Map CO2 level (ppm) to HomeKit AirQuality (1-5, lower is better)
    mapCO2ToHomeKitAirQuality(co2Level: number | null): number {
        if (co2Level === null || co2Level === undefined) return this.platform.Characteristic.AirQuality.UNKNOWN;
        if (co2Level <= 600) return this.platform.Characteristic.AirQuality.EXCELLENT;
        if (co2Level <= 800) return this.platform.Characteristic.AirQuality.GOOD;
        if (co2Level <= 1000) return this.platform.Characteristic.AirQuality.FAIR;
        if (co2Level <= 1500) return this.platform.Characteristic.AirQuality.INFERIOR;
        return this.platform.Characteristic.AirQuality.POOR;
    }
}