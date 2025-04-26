import { API } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'; // Add .js extension
import { AldesVMCPlatform } from './platform.js'; // Add .js extension

/**
 * This method registers the platform with Homebridge
 */
// Change export = to export default
export default (api: API) => {
  // Use PLUGIN_NAME as the first argument (identifier)
  // Use PLATFORM_NAME as the second argument (name for config.json)
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, AldesVMCPlatform);
};