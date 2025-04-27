import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'; // Add .js extension
import { VmcAccessory } from './vmcAccessory.js'; // Add .js extension
import { AldesAPI } from './aldes_api.js'; // Add .js extension
import { AirQualitySensorAccessory } from './airQualitySensorAccessory.js'; // Import air quality sensor
import { ClimateSensorAccessory } from './climateAccessory.js'; // Import climate sensor

export class AldesVMCPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;
  public readonly accessories: PlatformAccessory[] = [];

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
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
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
    const temperatureSensorName = `${vmcName} Temperature`;
    const humiditySensorName = `${vmcName} Humidity`;
    
    const airQualityUuid = this.api.hap.uuid.generate(PLUGIN_NAME + airQualitySensorName);
    const co2Uuid = this.api.hap.uuid.generate(PLUGIN_NAME + co2SensorName);
    const temperatureUuid = this.api.hap.uuid.generate(PLUGIN_NAME + temperatureSensorName);
    const humidityUuid = this.api.hap.uuid.generate(PLUGIN_NAME + humiditySensorName);

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

    // Create Temperature Sensor Accessory
    const existingTemperatureSensor = this.accessories.find(accessory => accessory.UUID === temperatureUuid);
    if (existingTemperatureSensor) {
      this.log.info('Restoring existing Temperature sensor from cache:', existingTemperatureSensor.displayName);
      new ClimateSensorAccessory(
        this,
        existingTemperatureSensor,
        this.log,
        this.aldesApi,
        'temperature'
      );
    } else {
      this.log.info('Adding new Temperature sensor:', temperatureSensorName);
      const temperatureSensorAccessory = new this.api.platformAccessory(temperatureSensorName, temperatureUuid);
      
      new ClimateSensorAccessory(
        this,
        temperatureSensorAccessory,
        this.log,
        this.aldesApi,
        'temperature'
      );
      
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [temperatureSensorAccessory]);
      this.accessories.push(temperatureSensorAccessory);
    }
    
    // Create Humidity Sensor Accessory
    const existingHumiditySensor = this.accessories.find(accessory => accessory.UUID === humidityUuid);
    if (existingHumiditySensor) {
      this.log.info('Restoring existing Humidity sensor from cache:', existingHumiditySensor.displayName);
      new ClimateSensorAccessory(
        this,
        existingHumiditySensor,
        this.log,
        this.aldesApi,
        'humidity'
      );
    } else {
      this.log.info('Adding new Humidity sensor:', humiditySensorName);
      const humiditySensorAccessory = new this.api.platformAccessory(humiditySensorName, humidityUuid);
      
      new ClimateSensorAccessory(
        this,
        humiditySensorAccessory,
        this.log,
        this.aldesApi,
        'humidity'
      );
      
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [humiditySensorAccessory]);
      this.accessories.push(humiditySensorAccessory);
    }
  }
}