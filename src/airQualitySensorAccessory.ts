import { Service, PlatformAccessory, CharacteristicValue, Logger } from 'homebridge';
import { AldesVMCPlatform } from './platform.js';
import { AldesAPI } from './aldes_api.js';

// Default polling interval in seconds if not specified in config
const DEFAULT_SENSOR_POLLING_INTERVAL = 60;

export class AirQualitySensorAccessory {
    private service: Service;
    private deviceId: string | null = null;
    private pollingInterval: NodeJS.Timeout | null = null;
    private currentAirQuality: number = 0;
    private currentCO2Level: number = 0;

    constructor(
        private readonly platform: AldesVMCPlatform,
        private readonly accessory: PlatformAccessory,
        private readonly log: Logger,
        private readonly aldesApi: AldesAPI,
        private readonly sensorType: 'airQuality' | 'co2',
    ) {
        // Set accessory information
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Aldes')
            .setCharacteristic(this.platform.Characteristic.Model, sensorType === 'airQuality' ? 'VMC Air Quality Sensor' : 'VMC CO2 Sensor')
            .setCharacteristic(this.platform.Characteristic.SerialNumber, this.accessory.UUID);

        // Create the sensor service based on sensor type
        if (sensorType === 'airQuality') {
            this.service = this.accessory.getService(this.platform.Service.AirQualitySensor) || 
                           this.accessory.addService(this.platform.Service.AirQualitySensor);
            
            this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);
            
            // Configure Air Quality characteristics
            this.service.getCharacteristic(this.platform.Characteristic.AirQuality)
                .onGet(this.handleAirQualityGet.bind(this));
            
            // Add PM2.5 density characteristic (optional but provides more data)
            this.service.getCharacteristic(this.platform.Characteristic.PM2_5Density)
                .onGet(this.handlePM25DensityGet.bind(this));
        } else { // CO2 sensor
            this.log.info('Initializing CO2 sensor accessory with NORMAL state');
            this.service = this.accessory.getService(this.platform.Service.CarbonDioxideSensor) || 
                           this.accessory.addService(this.platform.Service.CarbonDioxideSensor);
            
            this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);
            
            // Set CO2 to NORMAL by default so it doesn't show as an alert
            this.service.setCharacteristic(
                this.platform.Characteristic.CarbonDioxideDetected,
                0  // 0 = NORMAL, 1 = ABNORMAL
            );
            
            // Set initial CO2 level
            this.currentCO2Level = 500; // Default to 500 ppm
            this.service.setCharacteristic(
                this.platform.Characteristic.CarbonDioxideLevel,
                this.currentCO2Level
            );
            
            // Configure the get handlers
            this.service.getCharacteristic(this.platform.Characteristic.CarbonDioxideDetected)
                .onGet(this.handleCO2DetectedGet.bind(this));
            
            this.service.getCharacteristic(this.platform.Characteristic.CarbonDioxideLevel)
                .onGet(this.handleCO2LevelGet.bind(this));
            
            this.log.info('CO2 sensor initialized with NORMAL state');
        }

        this.initializeDevice();
    }

    async initializeDevice() {
        this.deviceId = await this.aldesApi.getDeviceId();
        if (!this.deviceId) {
            this.log.error(`Failed to initialize ${this.sensorType} Accessory: Could not get Device ID.`);
            return;
        }
        this.log.info(`${this.sensorType} Accessory initialized with Device ID: ${this.deviceId}`);

        // First fetch to populate data
        await this.refreshStatus();
        
        // Start polling for updates
        this.startPolling();
    }

    startPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
        }
        
        // Get polling interval from config, or use default
        const pollingIntervalSeconds = this.platform.config.sensorPollingInterval || DEFAULT_SENSOR_POLLING_INTERVAL;
        const pollIntervalMs = pollingIntervalSeconds * 1000;
        
        this.log.info(`Starting ${this.sensorType} polling every ${pollingIntervalSeconds} seconds`);
        
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
        if (!this.deviceId) {
            this.log.warn(`No deviceId available for ${this.sensorType} sensor, skipping refresh`);
            return;
        }

        try {
            const status = await this.aldesApi.getDeviceStatus(this.deviceId);
            if (!status) {
                this.log.warn(`[Refresh] Failed to get device status for ${this.sensorType} sensor`);
                return;
            }

            // Update air quality data if available
            if (status.airQuality !== undefined) {
                this.currentAirQuality = status.airQuality;
                this.log.info(`Updated air quality: ${this.currentAirQuality}%`);
                
                if (this.sensorType === 'airQuality') {
                    // Map percentage to HomeKit air quality levels and update
                    const airQualityLevel = this.mapAirQualityToHomeKit(this.currentAirQuality);
                    this.service.updateCharacteristic(this.platform.Characteristic.AirQuality, airQualityLevel);
                    
                    // Update the PM2.5 density (rough estimate based on air quality percentage)
                    const pm25Estimate = this.estimatePM25FromQuality(this.currentAirQuality);
                    this.service.updateCharacteristic(this.platform.Characteristic.PM2_5Density, pm25Estimate);
                }
            }

            // Update CO2 data if available
            if (status.co2Level !== undefined && this.sensorType === 'co2') {
                this.currentCO2Level = status.co2Level;
                this.log.info(`Updating CO2 sensor with: ${this.currentCO2Level} ppm`);
                
                // Always update CO2 level
                this.service.updateCharacteristic(
                    this.platform.Characteristic.CarbonDioxideLevel, 
                    this.currentCO2Level
                );
                
                // Only show abnormal if CO2 levels are actually high
                const isHighCO2 = this.currentCO2Level > 1000;
                const detectedState = isHighCO2 ? 
                    this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL : 
                    this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL;
                
                this.service.updateCharacteristic(
                    this.platform.Characteristic.CarbonDioxideDetected, 
                    detectedState
                );
                
                this.log.info(`CO2 sensor updated: level=${this.currentCO2Level} ppm, detected=${isHighCO2 ? 'ABNORMAL' : 'NORMAL'}`);
            }
        } catch (error) {
            this.log.error(`Error refreshing status for ${this.sensorType} sensor: ${error}`);
        }
    }

    // Air Quality conversion method
    mapAirQualityToHomeKit(airQualityValue: number): number {
        // Handle Aldes VMC air quality scale (seems to be 0-100 where lower is better)
        // HomeKit AirQuality levels:
        // 1 = EXCELLENT, 2 = GOOD, 3 = FAIR, 4 = INFERIOR, 5 = POOR
        
        // Check if the value is likely using the Aldes scale (typically reporting values under 40)
        if (airQualityValue <= 100) {
            this.log.debug(`Converting Aldes air quality value ${airQualityValue} to HomeKit scale`);
            
            // Aldes scale: lower numbers are better air quality
            if (airQualityValue <= 10) return 1; // EXCELLENT
            if (airQualityValue <= 20) return 2; // GOOD
            if (airQualityValue <= 35) return 3; // FAIR
            if (airQualityValue <= 50) return 4; // INFERIOR
            return 5; // POOR
        } else {
            // Fallback to original percentage-based logic
            this.log.debug(`Using percentage-based air quality conversion for value ${airQualityValue}`);
            if (airQualityValue >= 90) return 1; // EXCELLENT
            if (airQualityValue >= 70) return 2; // GOOD
            if (airQualityValue >= 50) return 3; // FAIR
            if (airQualityValue >= 30) return 4; // INFERIOR
            return 5; // POOR
        }
    }

    // Rough estimate of PM2.5 based on air quality percentage
    estimatePM25FromQuality(airQualityPercent: number): number {
        // Create a rough estimate of PM2.5 density based on air quality percentage
        // Assume 0% = 300μg/m³ (very bad) and 100% = 0μg/m³ (perfect)
        return 300 - (airQualityPercent * 3);
    }

    // Characteristic Handlers
    
    async handleAirQualityGet(): Promise<CharacteristicValue> {
        return this.mapAirQualityToHomeKit(this.currentAirQuality);
    }

    async handlePM25DensityGet(): Promise<CharacteristicValue> {
        return this.estimatePM25FromQuality(this.currentAirQuality);
    }

    async handleCO2DetectedGet(): Promise<CharacteristicValue> {
        const isHighCO2 = this.currentCO2Level > 1000;
        return isHighCO2 ? 
            this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL : 
            this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL;
    }

    async handleCO2LevelGet(): Promise<CharacteristicValue> {
        return this.currentCO2Level;
    }
}