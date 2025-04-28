import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'; // Add .js extension
import { VmcAccessory } from './vmcAccessory.js'; // Add .js extension
import { AldesAPI } from './aldes_api.js'; // Add .js extension
import { AirQualitySensorAccessory } from './airQualitySensorAccessory.js'; // Import air quality sensor
import { ClimateSensorAccessory } from './climateAccessory.js'; // Import climate sensor
import { ForceModeAccessory } from './forceModeAccessory.js'; // Import force mode accessory

// Define sensor location type for easy iteration
type SensorLocation = 'main' | 'ba1' | 'ba2' | 'ba3' | 'ba4';

export class AldesVMCPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;
  public readonly accessories: PlatformAccessory[] = [];
  private outdatedAccessories: PlatformAccessory[] = []; // Track outdated accessories

  private aldesApi?: AldesAPI; // Instance variable for AldesAPI

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', PLATFORM_NAME);

    // --- Aldes API Initialization ---
    if (!this.config.username || !this.config.password) {
      this.log.error('Aldes username or password not provided in config.json. Plugin will not start.');
      return;
    }

    // Instantiate AldesAPI
    this.aldesApi = new AldesAPI(
      {
        username: this.config.username,
        password: this.config.password,
        storagePath: this.api.user.storagePath(), // Provide storage path
      },
      this.log, // Pass the logger
    );
    // --- End Aldes API Initialization ---

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();

      // Remove outdated accessories after startup
      if (this.outdatedAccessories.length > 0) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, this.outdatedAccessories);
        this.log.info('Removed outdated accessories:', this.outdatedAccessories.map(acc => acc.displayName).join(', '));
        this.outdatedAccessories = []; // Clear the list
      }
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    
    // Check if this is an old-style temperature or humidity sensor that needs to be removed
    if ((accessory.displayName.includes('Temperature') || accessory.displayName.includes('Humidity')) && 
        !accessory.displayName.includes('⌀125') && !accessory.displayName.includes('⌀80')) {
      
      this.log.warn(`Found outdated sensor: ${accessory.displayName}. This will be removed.`);
      
      // Store it temporarily to be removed after startup
      this.outdatedAccessories.push(accessory);
      return;
    }
    
    this.accessories.push(accessory);
  }

  /**
   * Discover and register accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices() {
    // Ensure AldesAPI was initialized
    if (!this.aldesApi) {
        this.log.error('Aldes API not initialized, cannot discover devices. Check credentials.');
        return;
    }

    // Example: Create a single VMC accessory based on config name
    const vmcName = this.config.vmcName || 'Aldes VMC';
    const uuid = this.api.hap.uuid.generate(PLUGIN_NAME + vmcName); // Generate UUID based on name

    // Generate UUIDs for sensors
    const airQualitySensorName = `${vmcName} Air Quality`;
    const co2SensorName = `${vmcName} CO₂ Level`;
    const forceModeIndicatorName = `${vmcName} Force Mode`;
    
    const airQualityUuid = this.api.hap.uuid.generate(PLUGIN_NAME + airQualitySensorName);
    const co2Uuid = this.api.hap.uuid.generate(PLUGIN_NAME + co2SensorName);
    const forceModeUuid = this.api.hap.uuid.generate(PLUGIN_NAME + forceModeIndicatorName);

    // VMC Fan Accessory
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      // Create the VmcAccessory instance for the restored accessory
      new VmcAccessory(this, existingAccessory, this.log, this.aldesApi);
    } else {
      this.log.info('Adding new accessory:', vmcName);
      // Create a new accessory
      const accessory = new this.api.platformAccessory(vmcName, uuid);

      // Create the VmcAccessory instance for the new accessory
      new VmcAccessory(this, accessory, this.log, this.aldesApi);

      // Link the accessory to your platform
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory); // Add to internal list
    }

    // Create Force Mode Indicator Accessory (as a Contact Sensor) 
    const existingForceModeAccessory = this.accessories.find(accessory => accessory.UUID === forceModeUuid);
    if (existingForceModeAccessory) {
      this.log.info('Restoring existing Force Mode indicator from cache:', existingForceModeAccessory.displayName);
      
      // Create the ForceModeAccessory instance for the restored accessory
      new ForceModeAccessory(this, existingForceModeAccessory, this.log, this.aldesApi!);
    } else {
      this.log.info('Adding new Force Mode indicator:', forceModeIndicatorName);
      const forceModeAccessory = new this.api.platformAccessory(forceModeIndicatorName, forceModeUuid);
      
      // Create the ForceModeAccessory instance for the new accessory
      new ForceModeAccessory(this, forceModeAccessory, this.log, this.aldesApi!);
      
      // Register the accessory
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [forceModeAccessory]);
      this.accessories.push(forceModeAccessory);
    }

    // Check if sensors should be enabled (default to true if not specified)
    const enableSensors = this.config.enableSensors !== false;
    if (!enableSensors) {
      this.log.info('Sensors disabled in config, skipping sensor accessories');
      return;
    }

    // Create Air Quality Sensor Accessory
    const existingAirQualitySensor = this.accessories.find(accessory => accessory.UUID === airQualityUuid);
    if (existingAirQualitySensor) {
      this.log.info('Restoring existing Air Quality sensor from cache:', existingAirQualitySensor.displayName);
      new AirQualitySensorAccessory(
        this, 
        existingAirQualitySensor, 
        this.log, 
        this.aldesApi, 
        'airQuality'
      );
    } else {
      this.log.info('Adding new Air Quality sensor:', airQualitySensorName);
      const airQualitySensorAccessory = new this.api.platformAccessory(airQualitySensorName, airQualityUuid);
      
      new AirQualitySensorAccessory(
        this, 
        airQualitySensorAccessory, 
        this.log, 
        this.aldesApi, 
        'airQuality'
      );
      
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [airQualitySensorAccessory]);
      this.accessories.push(airQualitySensorAccessory);
    }

    // Create CO2 Sensor Accessory
    const existingCO2Sensor = this.accessories.find(accessory => accessory.UUID === co2Uuid);
    if (existingCO2Sensor) {
      this.log.info('Restoring existing CO2 sensor from cache:', existingCO2Sensor.displayName);
      new AirQualitySensorAccessory(
        this, 
        existingCO2Sensor, 
        this.log, 
        this.aldesApi, 
        'co2'
      );
    } else {
      this.log.info('Adding new CO2 sensor:', co2SensorName);
      const co2SensorAccessory = new this.api.platformAccessory(co2SensorName, co2Uuid);
      
      new AirQualitySensorAccessory(
        this, 
        co2SensorAccessory, 
        this.log, 
        this.aldesApi, 
        'co2'
      );
      
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [co2SensorAccessory]);
      this.accessories.push(co2SensorAccessory);
    }

    // Get sensor configuration from config
    const sensorConfig = this.config.sensorConfig || {};
    const temperatureConfig = sensorConfig.temperature || {
      main: true, ba1: true, ba2: true, ba3: false, ba4: false
    };
    const humidityConfig = sensorConfig.humidity || {
      main: true, ba1: true, ba2: true, ba3: false, ba4: false
    };

    // Define all possible locations
    const allLocations: SensorLocation[] = ['main', 'ba1', 'ba2', 'ba3', 'ba4'];

    // Create Temperature Sensors
    allLocations.forEach(location => {
      // Check if this temperature sensor is enabled in config
      if (temperatureConfig[location] !== true) {
        return; // Skip if not enabled
      }

      const locationDisplayName = location === 'main' ? 'Main Temperature Sensor ⌀125' : 
                                  location === 'ba1' ? 'Room 1 Temperature Sensor ⌀80' :
                                  location === 'ba2' ? 'Room 2 Temperature Sensor ⌀80' :
                                  location === 'ba3' ? 'Room 3 Temperature Sensor ⌀80' :
                                  'Room 4 Temperature Sensor ⌀80';
      
      const tempSensorName = `${vmcName} ${locationDisplayName}`;
      const tempUuid = this.api.hap.uuid.generate(PLUGIN_NAME + tempSensorName);
      
      const existingTempSensor = this.accessories.find(accessory => accessory.UUID === tempUuid);
      if (existingTempSensor) {
        this.log.info(`Restoring existing Temperature sensor (${location}) from cache:`, existingTempSensor.displayName);
        new ClimateSensorAccessory(
          this,
          existingTempSensor,
          this.log,
          this.aldesApi!,
          'temperature',
          location as SensorLocation
        );
      } else {
        this.log.info(`Adding new Temperature sensor (${location}):`, tempSensorName);
        const tempSensorAccessory = new this.api.platformAccessory(tempSensorName, tempUuid);
        
        new ClimateSensorAccessory(
          this,
          tempSensorAccessory,
          this.log,
          this.aldesApi!,
          'temperature',
          location as SensorLocation
        );
        
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [tempSensorAccessory]);
        this.accessories.push(tempSensorAccessory);
      }
    });

    // Create Humidity Sensors
    allLocations.forEach(location => {
      // Check if this humidity sensor is enabled in config
      if (humidityConfig[location] !== true) {
        return; // Skip if not enabled
      }

      const locationDisplayName = location === 'main' ? 'Main Humidity Sensor ⌀125' : 
                                  location === 'ba1' ? 'Room 1 Humidity Sensor ⌀80' :
                                  location === 'ba2' ? 'Room 2 Humidity Sensor ⌀80' :
                                  location === 'ba3' ? 'Room 3 Humidity Sensor ⌀80' :
                                  'Room 4 Humidity Sensor ⌀80';
      
      const humSensorName = `${vmcName} ${locationDisplayName}`;
      const humUuid = this.api.hap.uuid.generate(PLUGIN_NAME + humSensorName);
      
      const existingHumSensor = this.accessories.find(accessory => accessory.UUID === humUuid);
      if (existingHumSensor) {
        this.log.info(`Restoring existing Humidity sensor (${location}) from cache:`, existingHumSensor.displayName);
        new ClimateSensorAccessory(
          this,
          existingHumSensor,
          this.log,
          this.aldesApi!,
          'humidity',
          location as SensorLocation
        );
      } else {
        this.log.info(`Adding new Humidity sensor (${location}):`, humSensorName);
        const humSensorAccessory = new this.api.platformAccessory(humSensorName, humUuid);
        
        new ClimateSensorAccessory(
          this,
          humSensorAccessory,
          this.log,
          this.aldesApi!,
          'humidity',
          location as SensorLocation
        );
        
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [humSensorAccessory]);
        this.accessories.push(humSensorAccessory);
      }
    });
  }
}