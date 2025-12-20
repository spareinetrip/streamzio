const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '.cache.json');

// Default cache structure
const DEFAULT_CACHE = {};

// Load cache from disk
function loadCache() {
    try {
        if (fs.existsSync(CACHE_PATH)) {
            const cacheData = fs.readFileSync(CACHE_PATH, 'utf8');
            return JSON.parse(cacheData);
        }
        return DEFAULT_CACHE;
    } catch (error) {
        console.error(`[CACHE] ERROR: Failed to load cache: ${error.message}`);
        return DEFAULT_CACHE;
    }
}

// Save cache to disk
function saveCache(cache) {
    try {
        fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
        return true;
    } catch (error) {
        console.error(`[CACHE] ERROR: Failed to save cache: ${error.message}`);
        return false;
    }
}

// Generate cache key from IMDB ID, season, and episode
function getCacheKey(imdbId, season, episode) {
    return `${imdbId}:${season}:${episode}`;
}

// Get cached streams for a given IMDB ID, season, and episode
function getCachedStreams(imdbId, season, episode) {
    const cache = loadCache();
    const key = getCacheKey(imdbId, season, episode);
    
    if (cache[key]) {
        return cache[key];
    }
    
    return null;
}

// Store streams in cache for a given IMDB ID, season, and episode
function setCachedStreams(imdbId, season, episode, streams) {
    if (!streams || streams.length === 0) {
        return;
    }
    
    const cache = loadCache();
    const key = getCacheKey(imdbId, season, episode);
    
    cache[key] = streams;
    saveCache(cache);
}

// Clear cache (useful for debugging or manual cache invalidation)
function clearCache() {
    try {
        if (fs.existsSync(CACHE_PATH)) {
            fs.unlinkSync(CACHE_PATH);
            console.log('[CACHE] Cache cleared');
        }
    } catch (error) {
        console.error(`[CACHE] ERROR: Failed to clear cache: ${error.message}`);
    }
}

// Get cache statistics
function getCacheStats() {
    const cache = loadCache();
    const keys = Object.keys(cache);
    const totalStreams = keys.reduce((sum, key) => sum + (cache[key]?.length || 0), 0);
    
    return {
        entries: keys.length,
        totalStreams: totalStreams,
        keys: keys
    };
}

module.exports = {
    getCachedStreams,
    setCachedStreams,
    clearCache,
    getCacheStats,
    getCacheKey
};
