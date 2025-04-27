import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'; // Add .js extension
import { VmcAccessory } from './vmcAccessory.js'; // Add .js extension
import { AldesAPI } from './aldes_api.js'; // Add .js extension
import { AirQualitySensorAccessory } from './airQualitySensorAccessory.js'; // Import air quality sensor
import { ClimateSensorAccessory } from './climateAccessory.js'; // Import climate sensor
import { ForceModeAccessory } from './forceModeAccessory.js'; // Import force mode accessory

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
    const forceModeIndicatorName = `${vmcName} Force Mode`;
    
    const airQualityUuid = this.api.hap.uuid.generate(PLUGIN_NAME + airQualitySensorName);
    const co2Uuid = this.api.hap.uuid.generate(PLUGIN_NAME + co2SensorName);
    const temperatureUuid = this.api.hap.uuid.generate(PLUGIN_NAME + temperatureSensorName);
    const humidityUuid = this.api.hap.uuid.generate(PLUGIN_NAME + humiditySensorName);
    const forceModeUuid = this.api.hap.uuid.generate(PLUGIN_NAME + forceModeIndicatorName);

    // Create a shared VMC controller instance
    let vmcController: VmcAccessory | undefined;

    // VMC Fan Accessory
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      // Create the VmcAccessory instance for the restored accessory
      vmcController = new VmcAccessory(this, existingAccessory, this.log, this.aldesApi);
    } else {
      this.log.info('Adding new accessory:', vmcName);
      // Create a new accessory
      const accessory = new this.api.platformAccessory(vmcName, uuid);

      // Create the VmcAccessory instance for the new accessory
      vmcController = new VmcAccessory(this, accessory, this.log, this.aldesApi);

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

    // Create Temperature Sensor Accessory
    const existingTemperatureSensor = this.accessories.find(accessory => accessory.UUID === temperatureUuid);
    if (existingTemperatureSensor) {
      this.log.info('Restoring existing Temperature sensor from cache:', existingTemperatureSensor.displayName);
      new ClimateSensorAccessory(
        this,
        existingTemperatureSensor,
        this.log,
        this.aldesApi,
        'temperature',
        'main'
      );
    } else {
      this.log.info('Adding new Temperature sensor:', temperatureSensorName);
      const temperatureSensorAccessory = new this.api.platformAccessory(temperatureSensorName, temperatureUuid);
      
      new ClimateSensorAccessory(
        this,
        temperatureSensorAccessory,
        this.log,
        this.aldesApi,
        'temperature',
        'main'
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
        'humidity',
        'main'
      );
    } else {
      this.log.info('Adding new Humidity sensor:', humiditySensorName);
      const humiditySensorAccessory = new this.api.platformAccessory(humiditySensorName, humidityUuid);
      
      new ClimateSensorAccessory(
        this,
        humiditySensorAccessory,
        this.log,
        this.aldesApi,
        'humidity',
        'main'
      );
      
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [humiditySensorAccessory]);
      this.accessories.push(humiditySensorAccessory);
    }
    
    // Create Temperature Ba1 Sensor Accessory
    const tempBa1SensorName = `${vmcName} Temperature Ba1`;
    const tempBa1Uuid = this.api.hap.uuid.generate(PLUGIN_NAME + tempBa1SensorName);
    const existingTempBa1Sensor = this.accessories.find(accessory => accessory.UUID === tempBa1Uuid);
    if (existingTempBa1Sensor) {
      this.log.info('Restoring existing Temperature Ba1 sensor from cache:', existingTempBa1Sensor.displayName);
      new ClimateSensorAccessory(
        this,
        existingTempBa1Sensor,
        this.log,
        this.aldesApi,
        'temperature',
        'ba1'
      );
    } else {
      this.log.info('Adding new Temperature Ba1 sensor:', tempBa1SensorName);
      const tempBa1SensorAccessory = new this.api.platformAccessory(tempBa1SensorName, tempBa1Uuid);
      
      new ClimateSensorAccessory(
        this,
        tempBa1SensorAccessory,
        this.log,
        this.aldesApi,
        'temperature',
        'ba1'
      );
      
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [tempBa1SensorAccessory]);
      this.accessories.push(tempBa1SensorAccessory);
    }
    
    // Create Humidity Ba1 Sensor Accessory
    const humBa1SensorName = `${vmcName} Humidity Ba1`;
    const humBa1Uuid = this.api.hap.uuid.generate(PLUGIN_NAME + humBa1SensorName);
    const existingHumBa1Sensor = this.accessories.find(accessory => accessory.UUID === humBa1Uuid);
    if (existingHumBa1Sensor) {
      this.log.info('Restoring existing Humidity Ba1 sensor from cache:', existingHumBa1Sensor.displayName);
      new ClimateSensorAccessory(
        this,
        existingHumBa1Sensor,
        this.log,
        this.aldesApi,
        'humidity',
        'ba1'
      );
    } else {
      this.log.info('Adding new Humidity Ba1 sensor:', humBa1SensorName);
      const humBa1SensorAccessory = new this.api.platformAccessory(humBa1SensorName, humBa1Uuid);
      
      new ClimateSensorAccessory(
        this,
        humBa1SensorAccessory,
        this.log,
        this.aldesApi,
        'humidity',
        'ba1'
      );
      
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [humBa1SensorAccessory]);
      this.accessories.push(humBa1SensorAccessory);
    }
    
    // Create Temperature Ba2 Sensor Accessory
    const tempBa2SensorName = `${vmcName} Temperature Ba2`;
    const tempBa2Uuid = this.api.hap.uuid.generate(PLUGIN_NAME + tempBa2SensorName);
    const existingTempBa2Sensor = this.accessories.find(accessory => accessory.UUID === tempBa2Uuid);
    if (existingTempBa2Sensor) {
      this.log.info('Restoring existing Temperature Ba2 sensor from cache:', existingTempBa2Sensor.displayName);
      new ClimateSensorAccessory(
        this,
        existingTempBa2Sensor,
        this.log,
        this.aldesApi,
        'temperature',
        'ba2'
      );
    } else {
      this.log.info('Adding new Temperature Ba2 sensor:', tempBa2SensorName);
      const tempBa2SensorAccessory = new this.api.platformAccessory(tempBa2SensorName, tempBa2Uuid);
      
      new ClimateSensorAccessory(
        this,
        tempBa2SensorAccessory,
        this.log,
        this.aldesApi,
        'temperature',
        'ba2'
      );
      
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [tempBa2SensorAccessory]);
      this.accessories.push(tempBa2SensorAccessory);
    }
    
    // Create Humidity Ba2 Sensor Accessory
    const humBa2SensorName = `${vmcName} Humidity Ba2`;
    const humBa2Uuid = this.api.hap.uuid.generate(PLUGIN_NAME + humBa2SensorName);
    const existingHumBa2Sensor = this.accessories.find(accessory => accessory.UUID === humBa2Uuid);
    if (existingHumBa2Sensor) {
      this.log.info('Restoring existing Humidity Ba2 sensor from cache:', existingHumBa2Sensor.displayName);
      new ClimateSensorAccessory(
        this,
        existingHumBa2Sensor,
        this.log,
        this.aldesApi,
        'humidity',
        'ba2'
      );
    } else {
      this.log.info('Adding new Humidity Ba2 sensor:', humBa2SensorName);
      const humBa2SensorAccessory = new this.api.platformAccessory(humBa2SensorName, humBa2Uuid);
      
      new ClimateSensorAccessory(
        this,
        humBa2SensorAccessory,
        this.log,
        this.aldesApi,
        'humidity',
        'ba2'
      );
      
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [humBa2SensorAccessory]);
      this.accessories.push(humBa2SensorAccessory);
    }
  }
}