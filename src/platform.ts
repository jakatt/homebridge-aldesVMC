import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { VmcAccessory } from './vmcAccessory'; // Ensure this import is correct
import { AldesAPI } from './aldes_api'; // Import AldesAPI

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
  }
}