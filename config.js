const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

// Default configuration
const DEFAULT_CONFIG = {
    realdebrid: {
        apiKey: '',
        enabled: false
    },
    server: {
        port: 7004,
        publicBaseUrl: ''
    }
};

// Load configuration from file
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            return {
                ...DEFAULT_CONFIG,
                ...config,
                realdebrid: { ...DEFAULT_CONFIG.realdebrid, ...config.realdebrid },
                server: { ...DEFAULT_CONFIG.server, ...config.server }
            };
        } else {
            saveConfig(DEFAULT_CONFIG);
            return DEFAULT_CONFIG;
        }
    } catch (error) {
        console.error(`[CONFIG] ERROR: Failed to load config: ${error.message}`);
        return DEFAULT_CONFIG;
    }
}

// Save configuration to file
function saveConfig(config) {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
        return true;
    } catch (error) {
        console.error(`[CONFIG] ERROR: Failed to save config: ${error.message}`);
        return false;
    }
}

// Get config with environment variable overrides
function getConfig() {
    const config = loadConfig();
    
    // Override with environment variables if present
    if (process.env.REALDEBRID_API_KEY) {
        config.realdebrid.apiKey = process.env.REALDEBRID_API_KEY;
        config.realdebrid.enabled = true;
    }
    
    if (process.env.PORT) {
        const port = parseInt(process.env.PORT);
        if (!isNaN(port) && port > 0 && port < 65536) {
            config.server.port = port;
        }
    }
    
    if (process.env.PUBLIC_BASE_URL) {
        config.server.publicBaseUrl = process.env.PUBLIC_BASE_URL;
    }
    
    return config;
}

module.exports = {
    loadConfig,
    saveConfig,
    getConfig,
    CONFIG_PATH
};
