# Homebridge Aldes VMC Plugin

[![npm version](https://badge.fury.io/js/homebridge-aldesVMC.svg)](https://badge.fury.io/js/homebridge-aldesVMC)

This is a Homebridge plugin for controlling Aldes Ventilation Units (VMC) that are compatible with the AldesConnect™ mobile application. It uses the same underlying API as the mobile app to control the ventilation modes.

**Disclaimer:** This plugin uses an unofficial API based on reverse-engineering the AldesConnect™ app. It may break without notice if Aldes changes their API. Use at your own risk.

## Features

*   Exposes the Aldes VMC as a Fan accessory in HomeKit.
*   Allows setting ventilation modes (Vacation/Minimum, Daily/Auto, Boost/Maximum) by adjusting the fan speed in the Home app:
    *   Off: Sets mode 'V' (Vacation/Minimum)
    *   1-33%: Sets mode 'V' (Vacation/Minimum)
    *   34-66%: Sets mode 'Y' (Daily/Auto)
    *   67-100%: Sets mode 'X' (Boost/Maximum)
*   Reports the current VMC mode as the fan speed.
*   Handles Aldes API token acquisition and refresh automatically.

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
  "vmcName": "Aldes VMC"
}
```

**Fields:**

*   `platform` (required): Must be `"AldesVMC"`.
*   `name` (required): The name to identify this platform instance (e.g., `"AldesVMC"`).
*   `username` (required): Your username (email address) for the AldesConnect™ account.
*   `password` (required): Your password for the AldesConnect™ account.
*   `vmcName` (optional): The name for the VMC accessory as it will appear in the Home app (Default: `"Aldes VMC"`).

## Notes

*   This plugin does not currently support polling. The status in HomeKit will update when you control the device via HomeKit or when Homebridge restarts. If you control the VMC via the Aldes app or other means, HomeKit may show an outdated status.
*   The mapping between HomeKit fan speeds and Aldes modes ('V', 'Y', 'X') is based on common interpretations.

## License

This plugin is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.