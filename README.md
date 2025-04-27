# Homebridge Aldes VMC Plugin

[![npm version](https://badge.fury.io/js/homebridge-aldesVMC.svg)](https://badge.fury.io/js/homebridge-aldesVMC)

This is a Homebridge plugin for controlling Aldes Ventilation Units (VMC) that are compatible with the AldesConnect™ mobile application. It uses the same underlying API as the mobile app to control the ventilation modes.

**Disclaimer:** This plugin uses an unofficial API based on reverse-engineering the AldesConnect™ app. It may break without notice if Aldes changes their API. Use at your own risk.

## Features

*   Exposes the Aldes VMC as a Fan accessory in HomeKit.
*   Allows setting ventilation modes by adjusting the fan speed in the Home app:
    *   0% (Off): Sets mode 'V' (Minimum/Daily)
    *   50%: Sets mode 'Y' (Boost)
    *   100%: Sets mode 'X' (Guests)
*   Reports the current VMC mode as the fan speed (0%, 50%, or 100%).
*   Handles Aldes API token acquisition and refresh automatically.
*   Exposes environmental sensors for models that support these metrics:
    *   Air Quality
    *   CO₂ level
    *   Temperature
    *   Humidity
*   Updates sensor readings automatically every 60 seconds.

## Installation

1.  Install Homebridge using the official instructions.
2.  Install this plugin globally using npm:
    ```bash
    sudo npm install -g homebridge-aldesVMC
    ```
3.  Update your Homebridge `config.json` file with the platform configuration (see below).

## Configuration

Add the following platform block to your `config.json` within the `platforms` array:

```json
{
  "platform": "AldesVMC",
  "name": "AldesVMC",
  "username": "YOUR_ALDES_USERNAME",
  "password": "YOUR_ALDES_PASSWORD",
  "vmcName": "Aldes VMC",
  "enableSensors": true
}
```

**Fields:**

*   `platform` (required): Must be `"AldesVMC"`.
*   `name` (required): The name to identify this platform instance (e.g., `"AldesVMC"`).
*   `username` (required): Your username (email address) for the AldesConnect™ account.
*   `password` (required): Your password for the AldesConnect™ account.
*   `vmcName` (optional): The name for the VMC accessory as it will appear in the Home app (Default: `"Aldes VMC"`).
*   `enableSensors` (optional): Set to `false` to disable all sensors if your model doesn't support them (Default: `true`).

## Sensors

This plugin adds four additional HomeKit accessories:

1. **Air Quality Sensor** - Shows the air quality level from your VMC unit:
   * Reports quality levels: Excellent, Good, Fair, Inferior, Poor
   * Includes PM2.5 density estimation

2. **CO₂ Sensor** - Shows the carbon dioxide level from your VMC unit:
   * Reports CO₂ concentration in ppm
   * Triggers abnormal status when CO₂ levels exceed 1000 ppm

3. **Temperature Sensor** - Shows the current temperature:
   * Reports temperature in Celsius
   * Useful for automation based on indoor temperature

4. **Humidity Sensor** - Shows the current relative humidity:
   * Reports humidity percentage (0-100%)
   * Helps monitor indoor air moisture levels

All sensors update their values every 60 seconds by polling the Aldes API.

## Notes

*   The VMC fan status in HomeKit will update when you control the device via HomeKit or when Homebridge restarts. External changes (from the Aldes app) will be detected every 30 seconds.
*   The mapping between HomeKit fan speeds (0%, 50%, 100%) and Aldes modes ('V', 'Y', 'X') is defined in the plugin code.
*   If your VMC model doesn't provide sensor data, you can disable all sensors in the configuration.

## License

This plugin is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.