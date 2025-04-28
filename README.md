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
    *   Multiple temperature sensors (up to 5)
    *   Multiple humidity sensors (up to 5)
*   Configurable polling intervals for sensors and external changes detection.

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
  "enableSensors": true,
  "sensorPollingInterval": 60,
  "externalChangesPollingInterval": 60,
  "sensorConfig": {
    "temperature": {
      "main": true,
      "ba1": true,
      "ba2": true,
      "ba3": false,
      "ba4": false
    },
    "humidity": {
      "main": true,
      "ba1": true,
      "ba2": true,
      "ba3": false,
      "ba4": false
    }
  }
}
```

**Fields:**

*   `platform` (required): Must be `"AldesVMC"`.
*   `name` (required): The name to identify this platform instance (e.g., `"AldesVMC"`).
*   `username` (required): Your username (email address) for the AldesConnect™ account.
*   `password` (required): Your password for the AldesConnect™ account.
*   `vmcName` (optional): The name for the VMC accessory as it will appear in the Home app (Default: `"Aldes VMC"`).
*   `enableSensors` (optional): Set to `false` to disable all sensors if your model doesn't support them (Default: `true`).
*   `sensorPollingInterval` (optional): Interval in seconds between sensor data updates (Default: `60`).
*   `externalChangesPollingInterval` (optional): Interval in seconds to check for VMC mode changes made from the Aldes app (Default: `60`).
*   `sensorConfig` (optional): Configure which temperature and humidity sensors to enable (see below).

### Sensor Configuration

The plugin supports up to 5 temperature and 5 humidity sensors, which can be individually enabled or disabled:

* `main`: Main sensor (diameter 125mm)
* `ba1`: Room 1 sensor (diameter 80mm)
* `ba2`: Room 2 sensor (diameter 80mm)
* `ba3`: Room 3 sensor (diameter 80mm)
* `ba4`: Room 4 sensor (diameter 80mm)

By default, the main sensor and the first two room sensors are enabled for both temperature and humidity.

## Sensors

This plugin adds several HomeKit accessories:

1. **Air Quality Sensor** - Shows the air quality level from your VMC unit:
   * Reports quality levels: Excellent, Good, Fair, Inferior, Poor
   * Includes PM2.5 density estimation

2. **CO₂ Sensor** - Shows the carbon dioxide level from your VMC unit:
   * Reports CO₂ concentration in ppm
   * Triggers abnormal status when CO₂ levels exceed 1000 ppm

3. **Multiple Temperature Sensors** - Show temperature readings from different locations:
   * Main Temperature Sensor ⌀125 - Main unit temperature reading
   * Room 1-4 Temperature Sensors ⌀80 - Additional room temperature readings
   * All report temperature in Celsius

4. **Multiple Humidity Sensors** - Show humidity readings from different locations:
   * Main Humidity Sensor ⌀125 - Main unit humidity reading
   * Room 1-4 Humidity Sensors ⌀80 - Additional room humidity readings
   * All report humidity percentage (0-100%)

5. **Force Mode Indicator** - Indicates when the VMC is in forced mode (self-controlled):
   * Shows as a switch in HomeKit
   * Switch OFF when in normal operation
   * Switch ON when in forced mode (when control is not possible)

All sensors update their values by polling the Aldes API at the interval specified in the configuration (default: 60 seconds).

## Notes

*   The VMC fan status in HomeKit will update immediately when you control the device via HomeKit. External changes (from the Aldes app) will be detected at the interval specified in the configuration (default: 60 seconds).
*   The mapping between HomeKit fan speeds (0%, 50%, 100%) and Aldes modes ('V', 'Y', 'X') is defined in the plugin code.
*   If your VMC model doesn't provide sensor data, you can disable all sensors in the configuration.
*   Not all VMC models support multiple temperature and humidity sensors. Enable only the sensors that your model supports.
*   You can adjust polling intervals to reduce API calls if needed. Too frequent polling might lead to rate limiting by the Aldes API.

## License

This plugin is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.