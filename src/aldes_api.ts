import axios, { AxiosInstance, AxiosError } from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { Logger } from 'homebridge';

// --- Configuration and Constants ---
const TOKEN_URL = "https://aldesiotsuite-aldeswebapi.azurewebsites.net/oauth2/token/";
const BASE_API_URL = "https://aldesiotsuite-aldeswebapi.azurewebsites.net/aldesoc/v4";
const TOKEN_FILE_NAME = "aldes_access_token.json"; // Store in Homebridge storage path
// Add constants for connection handling
const API_TIMEOUT_MS = 10000; // 10 second timeout (reduce from 15s)
const MAX_RETRIES = 3;        // Maximum number of retries for API calls
const RETRY_DELAY_MS = 1000;  // Delay between retries in milliseconds
const API_COOLDOWN_MS = 200;  // Minimum delay between API calls to prevent rate limiting

// --- Add tracking variables for API calls
let lastApiCallTime = 0;
let pendingApiCalls = 0;

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
    value: unknown; // Changed from any to unknown
    date?: string;
}

interface AldesDeviceDetails {
    indicators: AldesIndicator[];
    indicator?: Record<string, unknown>; // Changed from Record<string, any> to unknown
    // Add other fields if needed
}

interface AldesApiConfig {
    username?: string;
    password?: string;
    storagePath: string; // Homebridge storage path for token file
}

export type VmcMode = 'V' | 'Y' | 'X';

export interface AldesDeviceStatus {
    isSelfControlled: boolean;
    mode: VmcMode | null;
    airQuality?: number;     // Air quality level (0-100%)
    co2Level?: number;       // CO2 level in ppm
    
    // Primary temperature/humidity (TmpCu/HrCu)
    temperature?: number;    // Temperature in Celsius
    humidity?: number;       // Relative humidity (0-100%)
    
    // Additional sensors (1-5)
    temperatureBa1?: number; // Temperature in Celsius for Ba1
    humidityBa1?: number;    // Relative humidity (0-100%) for Ba1
    
    temperatureBa2?: number; // Temperature in Celsius for Ba2
    humidityBa2?: number;    // Relative humidity (0-100%) for Ba2
    
    temperatureBa3?: number; // Temperature in Celsius for Ba3
    humidityBa3?: number;    // Relative humidity (0-100%) for Ba3
    
    temperatureBa4?: number; // Temperature in Celsius for Ba4
    humidityBa4?: number;    // Relative humidity (0-100%) for Ba4
    
    temperatureBa5?: number; // Temperature in Celsius for Ba5
    humidityBa5?: number;    // Relative humidity (0-100%) for Ba5
}

// --- AldesAPI Class ---
export class AldesAPI {
    private readonly config: AldesApiConfig;
    private readonly log: Logger;
    private readonly httpClient: AxiosInstance;
    private readonly tokenFilePath: string;

    private currentToken: string | null = null;
    private tokenExpiryTime: number | null = null; 
    private lastError: Error | null = null;
    private lastSuccessfulApiCall: number = 0;
    private consecutiveFailures: number = 0;

    constructor(config: AldesApiConfig, logger: Logger) {
        this.config = config;
        this.log = logger;
        this.httpClient = axios.create({ 
            timeout: API_TIMEOUT_MS, 
            // Add retry interceptor
            validateStatus: (status) => {
                return status >= 200 && status < 500; // Don't reject on 4xx to handle them explicitly
            }
        }); 
        this.tokenFilePath = path.join(this.config.storagePath, TOKEN_FILE_NAME);

        if (!this.config.username || !this.config.password) {
            this.log.error('Aldes username or password not provided in config!');
        }
        
        // Add request interceptor to track API calls
        this.httpClient.interceptors.request.use(
            config => {
                pendingApiCalls++;
                const now = Date.now();
                const timeSinceLastCall = now - lastApiCallTime;
                
                if (timeSinceLastCall < API_COOLDOWN_MS) {
                    this.log.debug(`API call cooldown: Delaying request by ${API_COOLDOWN_MS - timeSinceLastCall}ms`);
                    // Add delay header for tracking
                    config.headers = config.headers || {};
                    config.headers['X-Delayed'] = 'true';
                    
                    // Return a promise that resolves after delay
                    return new Promise((resolve) => {
                        setTimeout(() => {
                            lastApiCallTime = Date.now();
                            resolve(config);
                        }, API_COOLDOWN_MS - timeSinceLastCall);
                    });
                }
                
                lastApiCallTime = now;
                return config;
            },
            error => {
                pendingApiCalls = Math.max(0, pendingApiCalls - 1);
                return Promise.reject(error);
            }
        );
        
        // Add response interceptor to track API calls
        this.httpClient.interceptors.response.use(
            response => {
                pendingApiCalls = Math.max(0, pendingApiCalls - 1);
                this.consecutiveFailures = 0;
                this.lastSuccessfulApiCall = Date.now();
                return response;
            },
            error => {
                pendingApiCalls = Math.max(0, pendingApiCalls - 1);
                this.consecutiveFailures++;
                this.lastError = error;
                
                // Log detailed connection errors
                if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
                    this.log.error(`Connection issue: ${error.code} - Timeout after ${API_TIMEOUT_MS}ms`);
                } else if (error.code === 'ENOTFOUND') {
                    this.log.error(`Network issue: ${error.code} - Host not found`);
                }
                
                return Promise.reject(error);
            }
        );
    }
    
    // Add new method to check API health
    public getApiHealth(): { 
        healthy: boolean; 
        lastSuccessful: number | null; 
        pendingCalls: number;
        consecutiveFailures: number;
        lastError: string | null 
    } {
        return {
            healthy: this.consecutiveFailures < 3 && (Date.now() - this.lastSuccessfulApiCall) < 60000,
            lastSuccessful: this.lastSuccessfulApiCall || null,
            pendingCalls: pendingApiCalls,
            consecutiveFailures: this.consecutiveFailures,
            lastError: this.lastError ? this.formatError(this.lastError) : null
        };
    }
    
    // Add a public method to reset API health state
    public resetApiState(): void {
        this.consecutiveFailures = 0;
        this.lastError = null;
        pendingApiCalls = 0;
        this.log.info('API state has been reset');
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
        } catch (error: unknown) { // Changed from any to unknown
            // Type guard for error code
            if (error instanceof Error && 'code' in error && (error as { code: string }).code === 'ENOENT') {
                this.log.debug('Token file not found.');
            } else if (error instanceof Error) {
                this.log.error(`Failed to load token from file: ${error.message}`);
            } else {
                 this.log.error(`Failed to load token from file: ${String(error)}`);
            }
            this.currentToken = null;
            return null;
        }
    }

    private async saveTokenToFile(tokenData: AldesTokenData): Promise<void> {
        try {
            await fs.writeFile(this.tokenFilePath, JSON.stringify(tokenData), 'utf-8');
            this.log.debug('Token saved successfully to file.');
        } catch (error: unknown) { // Changed from any to unknown
             if (error instanceof Error) {
                this.log.error(`Failed to save token to file: ${error.message}`);
            } else {
                 this.log.error(`Failed to save token to file: ${String(error)}`);
            }
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

    public async getDeviceStatus(deviceId: string): Promise<AldesDeviceStatus | null> {
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const token = await this.getToken();
                if (!token) {
                    this.log.error('Cannot get device status: No valid token.');
                    return null;
                }
                if (!deviceId) {
                     this.log.error('Cannot get device status: Device ID is missing.');
                     return null;
                }

                this.log.debug(`Getting device status for ${deviceId}... (Attempt ${attempt}/${MAX_RETRIES})`);
                const url = `${BASE_API_URL}/users/me/products/${deviceId}`;
                try {
                    const response = await this.httpClient.get<AldesDeviceDetails>(url, {
                        headers: { 'Authorization': `Bearer ${token}` },
                    });

                    // Log the complete raw response to understand the full structure
                    this.log.info('Complete API response:');
                    this.log.info(JSON.stringify(response.data, null, 2));

                    // Debug log indicators section
                    this.log.debug('Raw API response indicators:');
                    if (response.data?.indicators) {
                        response.data.indicators.forEach(ind => {
                            this.log.debug(`Indicator: ${ind.type}, Value: ${JSON.stringify(ind.value)}`);
                        });
                    }

                    // Create the status object with default values from the indicators array
                    const status: AldesDeviceStatus = {
                        isSelfControlled: false,
                        mode: null
                    };

                    // First get basic indicators from the indicators array
                    if (response.data?.indicators) {
                        for (const indicator of response.data.indicators) {
                            if (indicator.type === 'MODE' && typeof indicator.value === 'string' && 
                                ['V', 'Y', 'X'].includes(indicator.value)) {
                                status.mode = indicator.value as VmcMode;
                                this.log.debug(`Found mode from indicators array: ${status.mode}`);
                            } else if (indicator.type === 'SELF_CONTROLLED') {
                                status.isSelfControlled = indicator.value === true;
                                this.log.debug(`Found self controlled: ${status.isSelfControlled}`);
                            } else if (indicator.type === 'QAI_INDEX' && typeof indicator.value === 'number') {
                                status.airQuality = indicator.value;
                                this.log.debug(`Found air quality from indicators array: ${status.airQuality}`);
                            }
                        }
                    }

                    // Now check for the indicator object which contains the detailed sensor data
                    if (response.data?.indicator && typeof response.data.indicator === 'object') {
                        const indObj = response.data.indicator;
                        this.log.info('Found indicators object with nested structure');

                        // Get mode from the indicator object if not already set
                        if (!status.mode && indObj.ConVe && typeof indObj.ConVe === 'string' && 
                            ['V', 'Y', 'X'].includes(indObj.ConVe)) {
                            status.mode = indObj.ConVe as VmcMode;
                            this.log.debug(`Found mode from indicator object: ${status.mode}`);
                        }
                        
                        // Also check EASYHOME_CURRENT_MODE for mode
                        if (!status.mode && indObj.EASYHOME_CURRENT_MODE && 
                            typeof indObj.EASYHOME_CURRENT_MODE === 'string' &&
                            ['V', 'Y', 'X'].includes(indObj.EASYHOME_CURRENT_MODE)) {
                            status.mode = indObj.EASYHOME_CURRENT_MODE as VmcMode;
                            this.log.debug(`Found mode from EASYHOME_CURRENT_MODE: ${status.mode}`);
                        }

                        // Get CO2 level
                        if (indObj.CO2 && typeof indObj.CO2 === 'number') {
                            status.co2Level = indObj.CO2;
                            this.log.info(`CO2 level found from nested object: ${status.co2Level} ppm`);
                        }
                        
                        // Get main temperature (TmpCu)
                        if (indObj.TmpCu && typeof indObj.TmpCu === 'number') {
                            status.temperature = indObj.TmpCu / 10;
                            this.log.info(`Temperature found from nested object: ${status.temperature}°C`);
                        }
                        
                        // Get main humidity (HrCu)
                        if (indObj.HrCu && typeof indObj.HrCu === 'number') {
                            status.humidity = indObj.HrCu;
                            this.log.info(`Humidity found from nested object: ${status.humidity}%`);
                        }
                        
                        // Get additional temperature 1 (TmpBa1)
                        if (indObj.TmpBa1 && typeof indObj.TmpBa1 === 'number') {
                            status.temperatureBa1 = indObj.TmpBa1 / 10;
                            this.log.info(`Temperature Ba1 found from nested object: ${status.temperatureBa1}°C`);
                        }
                        
                        // Get additional humidity 1 (HrBa1)
                        if (indObj.HrBa1 && typeof indObj.HrBa1 === 'number') {
                            status.humidityBa1 = indObj.HrBa1;
                            this.log.info(`Humidity Ba1 found from nested object: ${status.humidityBa1}%`);
                        }
                        
                        // Get additional temperature 2 (TmpBa2)
                        if (indObj.TmpBa2 && typeof indObj.TmpBa2 === 'number') {
                            status.temperatureBa2 = indObj.TmpBa2 / 10;
                            this.log.info(`Temperature Ba2 found from nested object: ${status.temperatureBa2}°C`);
                        }
                        
                        // Get additional humidity 2 (HrBa2)
                        if (indObj.HrBa2 && typeof indObj.HrBa2 === 'number') {
                            status.humidityBa2 = indObj.HrBa2;
                            this.log.info(`Humidity Ba2 found from nested object: ${status.humidityBa2}%`);
                        }
                        
                        // Get additional temperature 3 (TmpBa3)
                        if (indObj.TmpBa3 && typeof indObj.TmpBa3 === 'number') {
                            status.temperatureBa3 = indObj.TmpBa3 / 10;
                            this.log.info(`Temperature Ba3 found from nested object: ${status.temperatureBa3}°C`);
                        }
                        
                        // Get additional humidity 3 (HrBa3)
                        if (indObj.HrBa3 && typeof indObj.HrBa3 === 'number') {
                            status.humidityBa3 = indObj.HrBa3;
                            this.log.info(`Humidity Ba3 found from nested object: ${status.humidityBa3}%`);
                        }
                        
                        // Get additional temperature 4 (TmpBa4)
                        if (indObj.TmpBa4 && typeof indObj.TmpBa4 === 'number') {
                            status.temperatureBa4 = indObj.TmpBa4 / 10;
                            this.log.info(`Temperature Ba4 found from nested object: ${status.temperatureBa4}°C`);
                        }
                        
                        // Get additional humidity 4 (HrBa4)
                        if (indObj.HrBa4 && typeof indObj.HrBa4 === 'number') {
                            status.humidityBa4 = indObj.HrBa4;
                            this.log.info(`Humidity Ba4 found from nested object: ${status.humidityBa4}%`);
                        }
                        
                        // Get additional temperature 5 (TmpBa5)
                        if (indObj.TmpBa5 && typeof indObj.TmpBa5 === 'number') {
                            status.temperatureBa5 = indObj.TmpBa5 / 10;
                            this.log.info(`Temperature Ba5 found from nested object: ${status.temperatureBa5}°C`);
                        }
                        
                        // Get additional humidity 5 (HrBa5)
                        if (indObj.HrBa5 && typeof indObj.HrBa5 === 'number') {
                            status.humidityBa5 = indObj.HrBa5;
                            this.log.info(`Humidity Ba5 found from nested object: ${status.humidityBa5}%`);
                        }
                        
                        // Get air quality if not already set
                        if (!status.airQuality && indObj.Qai && typeof indObj.Qai === 'object' && indObj.Qai !== null) {
                            const qai = indObj.Qai as { actualValue?: number };
                            if (qai.actualValue && typeof qai.actualValue === 'number') {
                                status.airQuality = qai.actualValue;
                                this.log.info(`Air quality found from nested Qai object: ${status.airQuality}`);
                            }
                        }
                    }

                    // Set a default mode if we didn't find one
                    if (!status.mode) {
                        status.mode = 'V'; // Default to minimum ventilation
                        this.log.warn(`Mode not found in API response, defaulting to: ${status.mode}`);
                    }

                    this.log.info(`Final device status: Mode=${status.mode}, SelfControlled=${status.isSelfControlled}, ` +
                                 `AirQuality=${status.airQuality}, CO2=${status.co2Level}, ` +
                                 `Temperature=${status.temperature}, Humidity=${status.humidity}`);
                    // Log API health after successful call
                    const health = this.getApiHealth();
                    this.log.debug(`API Health: Healthy=${health.healthy}, Pending=${health.pendingCalls}`);

                    return status;
                } catch (error: unknown) {
                    this.log.error(`Failed to get device status for ${deviceId}: ${this.formatError(error)}`);
                     if (axios.isAxiosError(error) && error.response?.status === 401) {
                        this.log.warn('Token might be invalid (401 Unauthorized). Clearing cached token.');
                        this.currentToken = null;
                        await fs.unlink(this.tokenFilePath).catch(() => {}); // Delete token file
                    }
                    return null;
                }
            } catch (error: unknown) {
                this.log.error(`Failed to get device status for ${deviceId} (Attempt ${attempt}/${MAX_RETRIES}): ${this.formatError(error)}`);
                
                if (axios.isAxiosError(error) && error.response?.status === 401) {
                    this.log.warn('Token might be invalid (401 Unauthorized). Clearing cached token.');
                    this.currentToken = null;
                    await fs.unlink(this.tokenFilePath).catch(() => {});
                }
                
                // If this is not the last attempt, wait before retrying
                if (attempt < MAX_RETRIES) {
                    this.log.debug(`Retrying in ${RETRY_DELAY_MS}ms...`);
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                } else {
                    // All attempts failed
                    this.log.error(`All ${MAX_RETRIES} attempts to get device status failed`);
                    return null;
                }
            }
        }
        return null; // Fallback in case all retries fail
    }

    public async getCurrentMode(deviceId: string): Promise<VmcMode | null> {
        // We can leverage the getDeviceStatus method now
        const status = await this.getDeviceStatus(deviceId);
        return status?.mode || null;
    }

    public async isSelfControlled(deviceId: string): Promise<boolean> {
        const status = await this.getDeviceStatus(deviceId);
        return status?.isSelfControlled || false;
    }

    public async setVmcMode(deviceId: string, mode: VmcMode): Promise<boolean> {
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                // First check if device is in self-controlled mode
                const isSelfControlledMode = await this.isSelfControlled(deviceId);
                if (isSelfControlledMode) {
                    this.log.warn(`Cannot set mode to ${mode}: Device is in SELF_CONTROLLED (force) mode.`);
                    return false;
                }

                const token = await this.getToken();
                 if (!token) {
                    this.log.error(`Cannot set mode to ${mode}: No valid token.`);
                    return false;
                }
                 if (!deviceId) {
                     this.log.error(`Cannot set mode to ${mode}: Device ID is missing.`);
                     return false;
                }

                this.log.info(`Attempting to set mode to ${mode} for device ${deviceId}... (Attempt ${attempt}/${MAX_RETRIES})`);
                const url = `${BASE_API_URL}/users/me/products/${deviceId}/commands`;
                const payload = {
                    method: 'changeMode',
                    params: [mode],
                    // Use a smaller random integer for the ID (e.g., 0 to 1,000,000)
                    id: Math.floor(Math.random() * 1000000),
                    jsonrpc: '2.0',
                };

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
                    
                    if (attempt < MAX_RETRIES) {
                        this.log.debug(`Retrying in ${RETRY_DELAY_MS}ms...`);
                        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                    } else {
                        return false;
                    }
                }
            } catch (error: unknown) { // Catch as unknown
                this.log.error(`Failed to set mode to ${mode} for ${deviceId} (Attempt ${attempt}/${MAX_RETRIES}): ${this.formatError(error)}`);
                 // Use type guard before accessing properties
                 if (axios.isAxiosError(error) && error.response?.status === 401) {
                    this.log.warn('Token might be invalid (401 Unauthorized). Clearing cached token.');
                    this.currentToken = null;
                    await fs.unlink(this.tokenFilePath).catch(() => {});
                }
                
                if (attempt < MAX_RETRIES) {
                    this.log.debug(`Retrying in ${RETRY_DELAY_MS}ms...`);
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                } else {
                    return false;
                }
            }
        }
        return false; // Fallback if all retries fail
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