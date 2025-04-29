import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'; // Add .js extension
import { VmcAccessory } from './vmcAccessory.js'; // Add .js extension
import { AldesAPI, AldesDeviceStatus } from './aldes_api.js'; // Add .js extension
import { AirQualitySensorAccessory } from './airQualitySensorAccessory.js'; // Import air quality sensor
import { ClimateSensorAccessory } from './climateAccessory.js'; // Import climate sensor
import { ForceModeAccessory } from './forceModeAccessory.js'; // Import force mode accessory

// Define sensor location type for easy iteration
type SensorLocation = 'main' | 'ba1' | 'ba2' | 'ba3' | 'ba4';

// Define accessory instance types
interface ManagedAccessory {
  updateStatus(status: AldesDeviceStatus): void;
  getDeviceId?(): Promise<string | null>; // Optional, VMC accessory might need it
  accessory: PlatformAccessory; // Keep reference to the PlatformAccessory
}

export class AldesVMCPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;
  public readonly accessories: PlatformAccessory[] = [];
  private outdatedAccessories: PlatformAccessory[] = []; // Track outdated accessories
  private pollingInterval: NodeJS.Timeout | null = null;
  private managedAccessories: Map<string, ManagedAccessory> = new Map(); // Store accessory instances by UUID
  private deviceId: string | null = null; // Store the main device ID centrally

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

    this.api.on('didFinishLaunching', async () => {
      this.log.debug('Executed didFinishLaunching callback');
      await this.initializeApiAndDeviceId(); // Ensure API is ready and get Device ID
      this.discoverDevices(); // Discover/restore accessories
      this.startPlatformPolling(); // Start central polling

      // Remove outdated accessories after startup
      if (this.outdatedAccessories.length > 0) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, this.outdatedAccessories);
        this.log.info('Removed outdated accessories:', this.outdatedAccessories.map(acc => acc.displayName).join(', '));
        this.outdatedAccessories = []; // Clear the list
      }
    });
  }

  // New method to initialize API and get the main device ID
  async initializeApiAndDeviceId() {
    if (!this.aldesApi) {
      this.log.error('Aldes API failed to initialize. Check config and restart.');
      return;
    }
    try {
      this.deviceId = await this.aldesApi.getDeviceId();
      if (!this.deviceId) {
        this.log.error('Failed to retrieve main Device ID. Polling will not start. Check Aldes connection.');
      } else {
        this.log.info(`Successfully retrieved main Device ID: ${this.deviceId}`);
      }
    } catch (error) {
      this.log.error(`Error retrieving main Device ID: ${error}`);
    }
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
    if (!this.deviceId) {
      this.log.warn('Main Device ID not available, skipping device discovery for now.');
      // Optionally schedule a retry
      // setTimeout(() => this.discoverDevices(), 30000);
      return;
    }

    // Example: Create a single VMC accessory based on config name
    const vmcName = this.config.vmcName || 'Aldes VMC';
    const uuid = this.api.hap.uuid.generate(PLUGIN_NAME + vmcName); // Generate UUID based on name

    // VMC Fan Accessory
    this.findOrCreateAccessory(vmcName, uuid, VmcAccessory);

    // Force Mode Indicator
    const forceModeIndicatorName = `${vmcName} Force Mode`;
    const forceModeUuid = this.api.hap.uuid.generate(PLUGIN_NAME + forceModeIndicatorName);
    this.findOrCreateAccessory(forceModeIndicatorName, forceModeUuid, ForceModeAccessory);

    // Check if sensors should be enabled (default to true if not specified)
    const enableSensors = this.config.enableSensors !== false;
    
    // Find existing sensor accessories that might need to be removed
    const sensorAccessoriesToRemove: PlatformAccessory[] = [];
    
    if (!enableSensors) {
      // If sensors are disabled, identify all sensor accessories to remove
      this.log.info('Sensors disabled in config. Removing any existing sensor accessories...');
      
      // Identify sensor accessories to be removed (all except VMC and Force Mode)
      this.accessories.forEach(accessory => {
        // Skip the main VMC accessory and Force Mode accessory
        if (accessory.displayName === vmcName || accessory.displayName === forceModeIndicatorName) {
          return;
        }
        
        // Add all other accessories (which are sensors) to removal list
        this.log.debug(`Marking sensor for removal: ${accessory.displayName}`);
        sensorAccessoriesToRemove.push(accessory);
      });
      
      // Remove identified sensor accessories
      if (sensorAccessoriesToRemove.length > 0) {
        this.log.info(`Removing ${sensorAccessoriesToRemove.length} sensor accessories because sensors are disabled in config`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, sensorAccessoriesToRemove);
        
        // Also remove them from our tracked accessories array
        sensorAccessoriesToRemove.forEach(accessoryToRemove => {
          const index = this.accessories.indexOf(accessoryToRemove);
          if (index !== -1) {
            this.accessories.splice(index, 1);
          }
          
          // Remove from managed accessories map as well
          this.managedAccessories.delete(accessoryToRemove.UUID);
        });
      }
      
      return; // Exit early, don't create any sensors
    }
    
    // If sensors are enabled, continue with sensor creation
    this.log.info('Sensors enabled in config. Setting up sensor accessories...');
    
    // Air Quality Sensor Accessory
    const airQualitySensorName = `${vmcName} Air Quality`;
    const airQualityUuid = this.api.hap.uuid.generate(PLUGIN_NAME + airQualitySensorName);
    this.findOrCreateAccessory(airQualitySensorName, airQualityUuid, AirQualitySensorAccessory, 'airQuality');

    // CO2 Sensor Accessory
    const co2SensorName = `${vmcName} CO₂ Level`;
    const co2Uuid = this.api.hap.uuid.generate(PLUGIN_NAME + co2SensorName);
    this.findOrCreateAccessory(co2SensorName, co2Uuid, AirQualitySensorAccessory, 'co2');

    // Climate Sensors (Temp/Humidity)
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
      
      this.findOrCreateAccessory(tempSensorName, tempUuid, ClimateSensorAccessory, 'temperature', location);
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
      
      this.findOrCreateAccessory(humSensorName, humUuid, ClimateSensorAccessory, 'humidity', location);
    });
  }

  // Helper to find/create accessories and store instances
  findOrCreateAccessory(
    name: string,
    uuid: string,
    AccessoryClass: any, // Use 'any' for simplicity, could be more specific
    sensorType?: 'airQuality' | 'co2' | 'temperature' | 'humidity',
    location?: SensorLocation
  ) {
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
    let accessoryInstance: ManagedAccessory;

    if (existingAccessory) {
      this.log.info(`Restoring existing ${AccessoryClass.name} from cache:`, existingAccessory.displayName);
      existingAccessory.context.sensorType = sensorType; // Ensure context is updated if needed
      existingAccessory.context.location = location;
      // Create instance for existing accessory
      accessoryInstance = new AccessoryClass(this, existingAccessory, this.log, this.aldesApi!, sensorType, location);
      this.api.updatePlatformAccessories([existingAccessory]); // Update potentially changed context
    } else {
      this.log.info(`Adding new ${AccessoryClass.name}:`, name);
      const newPlatformAccessory = new this.api.platformAccessory(name, uuid);
      newPlatformAccessory.context.sensorType = sensorType;
      newPlatformAccessory.context.location = location;
      // Create instance for new accessory
      accessoryInstance = new AccessoryClass(this, newPlatformAccessory, this.log, this.aldesApi!, sensorType, location);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [newPlatformAccessory]);
      this.accessories.push(newPlatformAccessory); // Add to platform accessory list
    }
    // Store the instance for polling updates
    this.managedAccessories.set(uuid, accessoryInstance);
  }

  // Central polling mechanism
  startPlatformPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    if (!this.deviceId) {
      this.log.warn('Cannot start polling: Main Device ID not available.');
      return;
    }
    if (!this.aldesApi) {
      this.log.error('Cannot start polling: Aldes API not initialized.');
      return;
    }

    // Updated to use the renamed polling interval config
    const pollingIntervalSeconds = this.config.externalChangesPollingInterval || DEFAULT_EXTERNAL_CHANGES_POLLING_INTERVAL;
    const pollIntervalMs = pollingIntervalSeconds * 1000;

    this.log.info(`Starting central polling every ${pollingIntervalSeconds} seconds...`);

    const pollFn = async () => {
      // ADD: Log start of poll function
      this.log.debug('[PollFn] Starting poll cycle...'); 
      
      // Check if deviceId is still valid
      if (!this.deviceId) {
          this.log.warn('[PollFn] Aborting poll cycle: Device ID became unavailable.');
          if (this.pollingInterval) clearInterval(this.pollingInterval); // Stop polling
          return;
      }
      
      this.log.debug('[PollFn] Polling for device status...');
      try {
        const status = await this.aldesApi!.getDeviceStatus(this.deviceId!);
        if (status) {
          this.log.debug('[PollFn] Distributing status update to accessories...');
          // Distribute status to all managed accessories
          for (const [uuid, accessoryInstance] of this.managedAccessories.entries()) {
            try {
              accessoryInstance.updateStatus(status);
            } catch (err) {
              this.log.error(`[PollFn] Error updating accessory ${accessoryInstance.accessory.displayName} (UUID: ${uuid}): ${err}`);
            }
          }
          this.log.debug('[PollFn] Status distribution complete.');
        } else {
          this.log.warn('[PollFn] Polling received null status from API.');
          // Optionally notify accessories about the failure
        }
      } catch (error) {
        this.log.error(`[PollFn] Error during polling: ${error}`);
        // Optionally notify accessories about the failure
      } finally {
          // ADD: Log end of poll function
          this.log.debug('[PollFn] Poll cycle finished.');
      }
    };

    // Run immediately and then set interval
    this.log.debug('[PollFn] Running initial poll...');
    pollFn().then(() => {
        this.log.debug('[PollFn] Initial poll finished. Setting interval.');
        if (this.pollingInterval) clearInterval(this.pollingInterval); // Clear just in case
        this.pollingInterval = setInterval(pollFn, pollIntervalMs);
    }).catch(error => {
        this.log.error(`[PollFn] Error during initial poll: ${error}. Interval not set.`);
    });
  }

  // Method for accessories to request an immediate refresh
  public requestRefreshAllAccessories(reason = 'Unknown') { // ADD reason parameter
    // ADD: Log who/what requested the refresh
    this.log.info(`[RequestRefresh] Immediate refresh requested. Reason: ${reason}`);
    
    if (this.pollingInterval) {
      this.log.debug('[RequestRefresh] Clearing existing polling interval.');
      clearInterval(this.pollingInterval);
      this.pollingInterval = null; // Ensure it's nullified
    }
    // Debounce mechanism: If multiple requests come quickly, only run once
    if ((this as any).refreshTimeout) {
        this.log.debug('[RequestRefresh] Debouncing refresh request.');
        clearTimeout((this as any).refreshTimeout);
    }
    this.log.debug('[RequestRefresh] Setting timeout to restart polling...');
    (this as any).refreshTimeout = setTimeout(() => {
        this.log.info('[RequestRefresh] Debounce timeout finished. Restarting polling now.');
        (this as any).refreshTimeout = null; // Clear the timeout ID
        this.startPlatformPolling(); // Restart polling (will run immediately first)
    }, 500); // Wait 500ms before restarting polling
  }

  // Make sure to clear the interval on shutdown
  public onShutdown() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    this.log.info('Shutting down AldesVMC platform.');
  }
}

// Add DEFAULT_EXTERNAL_CHANGES_POLLING_INTERVAL if it's not already defined globally
const DEFAULT_EXTERNAL_CHANGES_POLLING_INTERVAL = 60;