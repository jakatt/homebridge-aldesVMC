import { API } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings'; // Import both
import { AldesVMCPlatform } from './platform';

/**
 * This method registers the platform with Homebridge
 */
export = (api: API) => {
  // Use PLUGIN_NAME as the first argument (identifier)
  // Use PLATFORM_NAME as the second argument (name for config.json)
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, AldesVMCPlatform);
};