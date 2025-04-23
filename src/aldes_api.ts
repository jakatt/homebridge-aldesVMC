import axios, { AxiosInstance, AxiosError } from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { Logger } from 'homebridge';

// --- Configuration and Constants ---
const TOKEN_URL = "https://aldesiotsuite-aldeswebapi.azurewebsites.net/oauth2/token/";
const BASE_API_URL = "https://aldesiotsuite-aldeswebapi.azurewebsites.net/aldesoc/v4";
const TOKEN_FILE_NAME = "aldes_access_token.json"; // Store in Homebridge storage path

// --- Interfaces ---
interface AldesTokenData {
    access_token: string;
    // Add other fields if needed, e.g., expires_in, refresh_token
}

interface AldesProduct {
    modem: string; // Using modem as the device ID
    // Add other product fields if needed
}

interface AldesIndicator {
    type: string;
    value: any;
    date?: string;
}

interface AldesDeviceDetails {
    indicators: AldesIndicator[];
    // Add other fields if needed
}

interface AldesApiConfig {
    username?: string;
    password?: string;
    storagePath: string; // Homebridge storage path for token file
}

export type VmcMode = 'V' | 'Y' | 'X';

// --- AldesAPI Class ---
export class AldesAPI {
    private readonly config: AldesApiConfig;
    private readonly log: Logger;
    private readonly httpClient: AxiosInstance;
    private readonly tokenFilePath: string;

    private currentToken: string | null = null;
    private tokenExpiryTime: number | null = null; // Optional: track expiry

    constructor(config: AldesApiConfig, logger: Logger) {
        this.config = config;
        this.log = logger;
        this.httpClient = axios.create({ timeout: 15000 }); // 15 second timeout
        this.tokenFilePath = path.join(this.config.storagePath, TOKEN_FILE_NAME);

        if (!this.config.username || !this.config.password) {
            this.log.error('Aldes username or password not provided in config!');
            // Consider throwing an error or handling this state appropriately
        }
    }

    // --- Token Management ---

    private async loadTokenFromFile(): Promise<string | null> {
        try {
            const data = await fs.readFile(this.tokenFilePath, 'utf-8');
            const tokenData: AldesTokenData = JSON.parse(data);
            // TODO: Add token expiration check here if API provides expiry info
            this.log.debug('Token loaded successfully from file.');
            this.currentToken = tokenData.access_token;
            return this.currentToken;
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                this.log.debug('Token file not found.');
            } else {
                this.log.error(`Failed to load token from file: ${error.message}`);
            }
            this.currentToken = null;
            return null;
        }
    }

    private async saveTokenToFile(tokenData: AldesTokenData): Promise<void> {
        try {
            await fs.writeFile(this.tokenFilePath, JSON.stringify(tokenData), 'utf-8');
            this.log.debug('Token saved successfully to file.');
        } catch (error: any) {
            this.log.error(`Failed to save token to file: ${error.message}`);
        }
    }

    private async generateNewToken(): Promise<string | null> {
        if (!this.config.username || !this.config.password) {
            this.log.error('Cannot generate token: Username or password missing.');
            return null;
        }

        this.log.info('Generating new Aldes access token...');
        const payload = new URLSearchParams();
        payload.append('grant_type', 'password');
        payload.append('username', this.config.username);
        payload.append('password', this.config.password);

        try {
            const response = await this.httpClient.post<AldesTokenData>(TOKEN_URL, payload, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            });

            if (response.data && response.data.access_token) {
                this.log.info('New token generated successfully.');
                this.currentToken = response.data.access_token;
                await this.saveTokenToFile(response.data);
                // TODO: Set tokenExpiryTime if API provides expiry info
                return this.currentToken;
            } else {
                this.log.error('Failed to retrieve access_token from Aldes response.');
                this.currentToken = null;
                return null;
            }
        } catch (error) {
            this.log.error(`Failed to generate token: ${this.formatError(error)}`);
            this.currentToken = null;
            return null;
        }
    }

    public async getToken(): Promise<string | null> {
        // 1. Try using current token if available (and optionally check expiry)
        if (this.currentToken /* && this.tokenExpiryTime && Date.now() < this.tokenExpiryTime */) {
            this.log.debug('Using cached token.');
            return this.currentToken;
        }

        // 2. Try loading from file
        const tokenFromFile = await this.loadTokenFromFile();
        if (tokenFromFile /* && check expiry */) {
            return tokenFromFile;
        }

        // 3. Generate a new token
        return await this.generateNewToken();
    }

    // --- Device Interaction ---

    public async getDeviceId(): Promise<string | null> {
        const token = await this.getToken();
        if (!token) {
            this.log.error('Cannot get device ID: No valid token.');
            return null;
        }

        this.log.debug('Fetching device info...');
        try {
            const response = await this.httpClient.get<AldesProduct[]>(`${BASE_API_URL}/users/me/products`, {
                headers: { 'Authorization': `Bearer ${token}` },
            });

            if (response.data && response.data.length > 0 && response.data[0].modem) {
                const deviceId = response.data[0].modem;
                this.log.info(`Found Device ID (Modem): ${deviceId}`);
                return deviceId;
            } else {
                this.log.error('Could not extract modem (device ID) from product data.');
                this.log.debug(`Received product data: ${JSON.stringify(response.data)}`);
                return null;
            }
        } catch (error: unknown) {
            this.log.error(`Failed to get device info: ${this.formatError(error)}`);
            if (axios.isAxiosError(error) && error.response?.status === 401) {
                // Token might be invalid, clear it and retry getting token next time
                this.log.warn('Token might be invalid (401 Unauthorized). Clearing cached token.');
                this.currentToken = null;
                await fs.unlink(this.tokenFilePath).catch(() => {}); // Delete token file
            }
            return null;
        }
    }

    public async getCurrentMode(deviceId: string): Promise<VmcMode | null> {
        const token = await this.getToken();
        if (!token) {
            this.log.error('Cannot get current mode: No valid token.');
            return null;
        }
        if (!deviceId) {
             this.log.error('Cannot get current mode: Device ID is missing.');
             return null;
        }

        this.log.debug(`Getting current mode for device ${deviceId}...`);
        const url = `${BASE_API_URL}/users/me/products/${deviceId}`;
        try {
            const response = await this.httpClient.get<AldesDeviceDetails>(url, {
                headers: { 'Authorization': `Bearer ${token}` },
            });

            const modeIndicator = response.data?.indicators?.find((ind: AldesIndicator) => ind.type === 'MODE');
            if (modeIndicator && ['V', 'Y', 'X'].includes(modeIndicator.value)) {
                this.log.debug(`Current device mode reported: ${modeIndicator.value}`);
                return modeIndicator.value as VmcMode;
            } else {
                this.log.warn(`Could not find valid MODE indicator in device data for ${deviceId}.`);
                this.log.debug(`Received device data: ${JSON.stringify(response.data)}`);
                return null;
            }
        } catch (error: unknown) {
            this.log.error(`Failed to get current mode for ${deviceId}: ${this.formatError(error)}`);
             if (axios.isAxiosError(error) && error.response?.status === 401) {
                this.log.warn('Token might be invalid (401 Unauthorized). Clearing cached token.');
                this.currentToken = null;
                await fs.unlink(this.tokenFilePath).catch(() => {}); // Delete token file
            }
            return null;
        }
    }

    public async setVmcMode(deviceId: string, mode: VmcMode): Promise<boolean> {
        const token = await this.getToken();
         if (!token) {
            this.log.error(`Cannot set mode to ${mode}: No valid token.`);
            return false;
        }
         if (!deviceId) {
             this.log.error(`Cannot set mode to ${mode}: Device ID is missing.`);
             return false;
        }

        this.log.info(`Attempting to set mode to ${mode} for device ${deviceId}...`);
        const url = `${BASE_API_URL}/users/me/products/${deviceId}/commands`;
        const payload = {
            method: 'changeMode',
            params: [mode],
            // Use a smaller random integer for the ID (e.g., 0 to 1,000,000)
            id: Math.floor(Math.random() * 1000000),
            jsonrpc: '2.0',
        };

        try {
            const response = await this.httpClient.post(url, payload, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
            });

            // Aldes API might return 200 or 202 Accepted for commands
            if (response.status >= 200 && response.status < 300) {
                 this.log.info(`Set mode command for ${mode} sent successfully (Status: ${response.status}).`);
                 return true;
            } else {
                // This case might not be hit if axios throws for non-2xx status codes
                this.log.warn(`Set mode command for ${mode} returned unexpected status: ${response.status}`);
                return false;
            }
        } catch (error: unknown) { // Catch as unknown
            this.log.error(`Failed to set mode to ${mode} for ${deviceId}: ${this.formatError(error)}`);
             // Use type guard before accessing properties
             if (axios.isAxiosError(error) && error.response?.status === 401) {
                this.log.warn('Token might be invalid (401 Unauthorized). Clearing cached token.');
                this.currentToken = null;
                await fs.unlink(this.tokenFilePath).catch(() => {});
            }
            return false;
        }
    }

    // --- Utility ---
    private formatError(error: unknown): string {
        if (axios.isAxiosError(error)) {
            let message = error.message;
            if (error.response) {
                message += ` (Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)})`;
            }
            return message;
        } else if (error instanceof Error) {
            return error.message;
        } else {
            return String(error);
        }
    }
}