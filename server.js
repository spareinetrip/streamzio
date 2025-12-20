const { addonBuilder, getRouter, serveHTTP } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { getConfig } = require('./config');
const { execSync } = require('child_process');
const { getCachedStreams, setCachedStreams } = require('./cache');
const path = require('path');
const fs = require('fs');

// Use stealth plugin to bypass Cloudflare detection
puppeteer.use(StealthPlugin());

const REALDEBRID_API_URL = 'https://api.real-debrid.com/rest/1.0';
const CINEMETA_API_URL = 'https://v3-cinemeta.strem.io';
const MAX_PAGES_PER_BROWSER = 10;
const MAX_CONCURRENT_REQUESTS = 2;
const REQUEST_TIMEOUT_MS = 120000;
const BROWSER_TIMEOUT_MS = 60000;
const CLOUDFLARE_WAIT_TIMEOUT_MS = 45000;

// Dynamic base URL - updated from requests
let dynamicBaseUrl = null;

// Browser management state
let globalBrowser = null;
let browserInitializing = false;
let browserInitPromise = null;
let cloudflareChallengeDetected = false;
let isBrowserHeadless = false;
let activePages = new Set();
let isShuttingDown = false;
let activeRequestCount = 0;
let periodicCleanupInterval = null;

// Logging helper functions
const logger = {
    info: (msg) => console.log(`[INFO] ${msg}`),
    warn: (msg) => console.log(`[WARN] ${msg}`),
    error: (msg) => console.error(`[ERROR] ${msg}`),
    debug: (msg) => console.log(`[DEBUG] ${msg}`),
    timing: (operation, duration) => console.log(`[TIMING] ${operation}: ${duration}ms`)
};

// Helper to check if host is localhost
function isLocalhost(host) {
    if (!host) return true;
    const hostname = host.split(':')[0];
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function getPublicBaseUrl() {
    const config = getConfig();
    if (config.server.publicBaseUrl) {
        return config.server.publicBaseUrl;
    }
    if (dynamicBaseUrl) {
        return dynamicBaseUrl;
    }
    const httpPort = config.server.port || 7004;
    return `http://localhost:${httpPort}`;
}

// Addon Manifest
const manifest = {
    id: 'org.streamzio.flemish',
    version: '1.0.0',
    name: 'Streamzio',
    description: 'Flemish content from scnlog.me with Real-Debrid integration',
    logo: 'http://localhost:7004/logo.jpg',
    background: '',
    types: ['series', 'movie'],
    catalogs: [],
    resources: ['stream'],
    idPrefixes: ['tt']
};

const builder = new addonBuilder(manifest);

// Find Chrome/Chromium executable
function findBrowserExecutable() {
    const possiblePaths = [
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/snap/bin/chromium',
        process.env.CHROME_PATH,
        process.env.CHROMIUM_PATH,
        'chromium',
        'chromium-browser',
        'google-chrome'
    ].filter(Boolean);
    
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    
    return null;
}

// Check if X11 display is available
function detectDisplay() {
    if (process.env.DISPLAY && process.env.DISPLAY !== '') {
        return process.env.DISPLAY;
    }
    
    const waylandDisplay = process.env.WAYLAND_DISPLAY;
    const xdgSessionType = process.env.XDG_SESSION_TYPE;
    
    if (waylandDisplay || xdgSessionType === 'wayland') {
        logger.debug('Detected Wayland session - checking for XWayland');
        for (let i = 0; i <= 2; i++) {
            const xwaylandSocket = `/tmp/.X11-unix/X${i}`;
            if (fs.existsSync(xwaylandSocket)) {
                logger.debug(`Found XWayland socket - using DISPLAY=:${i}`);
                return `:${i}`;
            }
        }
        for (let i = 0; i <= 2; i++) {
            try {
                execSync(`xdpyinfo -display :${i} > /dev/null 2>&1`, { timeout: 1000 });
                logger.debug(`XWayland display :${i} is accessible`);
                return `:${i}`;
            } catch (e) {
                // xdpyinfo not available or display not accessible
            }
        }
        logger.debug('Wayland detected - will try DISPLAY=:0 (XWayland default)');
        return ':0';
    }
    
    try {
        const x11Socket = '/tmp/.X11-unix/X0';
        const x11Lock = '/tmp/.X0-lock';
        
        if (fs.existsSync(x11Socket) || fs.existsSync(x11Lock)) {
            logger.debug('Detected X11 display socket - using DISPLAY=:0');
            return ':0';
        }
        
        try {
            execSync('xdpyinfo -display :0 > /dev/null 2>&1', { timeout: 1000 });
            logger.debug('X11 display :0 is accessible');
            return ':0';
        } catch (e) {
            // xdpyinfo not available or X11 not accessible
        }
        
        for (let i = 1; i <= 10; i++) {
            try {
                execSync(`xdpyinfo -display :${i} > /dev/null 2>&1`, { timeout: 500 });
                logger.debug(`Detected X11 display :${i} (likely VNC)`);
                return `:${i}`;
            } catch (e) {
                // Not this display
            }
        }
    } catch (error) {
        // If we can't detect, return null (will use headless)
    }
    
    return null;
}

// Initialize browser instance
async function getBrowser() {
    if (globalBrowser && globalBrowser.isConnected()) {
        try {
            const pages = await globalBrowser.pages();
            if (pages.length > MAX_PAGES_PER_BROWSER) {
                logger.warn(`Too many pages (${pages.length}), resetting browser`);
                try {
                    await globalBrowser.close();
                } catch (e) {}
                globalBrowser = null;
                activePages.clear();
            } else {
                return globalBrowser;
            }
        } catch (error) {
            logger.warn(`Browser connection check failed: ${error.message}, reinitializing`);
            globalBrowser = null;
            activePages.clear();
        }
    }
    
    if (browserInitializing && browserInitPromise) {
        return await browserInitPromise;
    }
    
    browserInitializing = true;
    browserInitPromise = (async () => {
        try {
            logger.info('Initializing browser instance');
            
            const executablePath = findBrowserExecutable();
            if (executablePath) {
                logger.debug(`Found browser at: ${executablePath}`);
            } else {
                logger.warn('Browser not found in common paths, trying default');
            }
            
            const userDataDir = path.join(__dirname, '.browser-data');
            if (!fs.existsSync(userDataDir)) {
                fs.mkdirSync(userDataDir, { recursive: true });
            }
            
            const cookieDbPath = path.join(userDataDir, 'Default', 'Cookies');
            const hasCookies = fs.existsSync(cookieDbPath);
            
            const detectedDisplay = detectDisplay();
            const hasDisplay = detectedDisplay !== null;
            
            if (detectedDisplay && !process.env.DISPLAY) {
                process.env.DISPLAY = detectedDisplay;
                logger.debug(`Set DISPLAY=${detectedDisplay} for browser`);
            }
            
            const useHeadless = !hasDisplay || (hasCookies && !cloudflareChallengeDetected);
            
            if (!hasDisplay) {
                logger.info('No DISPLAY detected - using headless mode');
            } else {
                logger.info(`Browser mode: ${useHeadless ? 'headless' : 'visible'} (cookies: ${hasCookies}, challenge: ${cloudflareChallengeDetected})`);
                logger.debug(`Display: ${process.env.DISPLAY || detectedDisplay}`);
            }
            
            const browserArgs = [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                '--disable-backgrounding-occluded-windows',
                '--disable-ipc-flooding-protection',
                '--memory-pressure-off',
                '--max_old_space_size=4096'
            ];
            
            if (!hasDisplay) {
                browserArgs.push('--headless=new');
                browserArgs.push('--virtual-time-budget=5000');
            }
            
            const finalHeadless = !hasDisplay ? true : useHeadless;
            
            globalBrowser = await puppeteer.launch({
                headless: finalHeadless,
                executablePath: executablePath || undefined,
                userDataDir: userDataDir,
                args: browserArgs
            });
            
            logger.info(`Browser initialized (${finalHeadless ? 'headless' : 'visible'} mode)`);
            
            isBrowserHeadless = finalHeadless;
            
            globalBrowser.removeAllListeners('disconnected');
            globalBrowser.on('disconnected', () => {
                logger.warn('Browser disconnected, will reinitialize on next request');
                activePages.forEach(page => {
                    try {
                        page.close().catch(() => {});
                    } catch (e) {}
                });
                activePages.clear();
                globalBrowser = null;
                browserInitializing = false;
                browserInitPromise = null;
                isBrowserHeadless = false;
            });
            
            browserInitializing = false;
            return globalBrowser;
        } catch (error) {
            browserInitializing = false;
            browserInitPromise = null;
            logger.error(`Failed to initialize browser: ${error.message}`);
            throw error;
        }
    })();
    
    return await browserInitPromise;
}

// Periodic cleanup of orphaned pages
function startPeriodicCleanup() {
    if (periodicCleanupInterval) {
        clearInterval(periodicCleanupInterval);
    }
    periodicCleanupInterval = setInterval(async () => {
        if (!globalBrowser || !globalBrowser.isConnected()) {
            activePages.clear();
            return;
        }
        
        try {
            const browserPages = await globalBrowser.pages();
            const browserPageSet = new Set(browserPages);
            
            const pagesToClose = [];
            
            for (const page of Array.from(activePages)) {
                try {
                    if (page.isClosed()) {
                        activePages.delete(page);
                    } else if (!browserPageSet.has(page)) {
                        activePages.delete(page);
                    } else {
                        const pageIndex = browserPages.indexOf(page);
                        if (pageIndex > 0) {
                            pagesToClose.push(page);
                        }
                    }
                } catch (e) {
                    activePages.delete(page);
                }
            }
            
            for (const page of pagesToClose) {
                try {
                    activePages.delete(page);
                    if (!page.isClosed()) {
                        await page.close().catch(() => {});
                    }
                } catch (e) {
                    // Ignore errors
                }
            }
            
            for (const page of browserPages) {
                if (!activePages.has(page) && browserPages.indexOf(page) > 0) {
                    try {
                        if (!page.isClosed()) {
                            await page.close().catch(() => {});
                        }
                    } catch (e) {
                        // Ignore errors
                    }
                }
            }
            
            const finalBrowserPages = await globalBrowser.pages();
            if (finalBrowserPages.length > 1 || activePages.size > 0) {
                logger.debug(`Cleanup: ${finalBrowserPages.length} browser pages, ${activePages.size} tracked pages`);
            }
        } catch (error) {
            logger.warn(`Error during periodic cleanup: ${error.message}`);
        }
    }, 2 * 60 * 1000);
}

// Pre-start browser on server startup
async function preStartBrowser() {
    try {
        logger.info('Pre-starting browser for faster first request');
        await getBrowser();
        logger.info('Browser pre-started successfully');
        startPeriodicCleanup();
    } catch (error) {
        logger.warn(`Browser pre-start failed: ${error.message}`);
    }
}

// Helper function to wait for available slot in request queue
async function waitForBrowserSlot() {
    while (activeRequestCount >= MAX_CONCURRENT_REQUESTS) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    activeRequestCount++;
}

// Helper function to release browser slot
function releaseBrowserSlot() {
    activeRequestCount = Math.max(0, activeRequestCount - 1);
}

// Helper function to cleanup browser pages
async function cleanupBrowserPages() {
    try {
        if (globalBrowser && globalBrowser.isConnected()) {
            const browserPages = await globalBrowser.pages();
            for (let i = browserPages.length - 1; i > 0; i--) {
                const page = browserPages[i];
                if (!page.isClosed() && !activePages.has(page)) {
                    try {
                        await page.close().catch(() => {});
                    } catch (e) {
                        // Ignore errors
                    }
                }
            }
        }
    } catch (cleanupError) {
        logger.warn(`Cleanup warning: ${cleanupError.message}`);
    }
}

// Fetch MultiUp page using Puppeteer
async function fetchMultiUpPage(url) {
    let browser = null;
    let page = null;
    let needsVisibleBrowser = false;
    
    await waitForBrowserSlot();
    
    try {
        browser = await getBrowser();
        
        if (!browser.isConnected()) {
            throw new Error('Browser disconnected');
        }
        
        const currentPages = await browser.pages();
        if (currentPages.length >= MAX_PAGES_PER_BROWSER) {
            logger.warn(`Too many pages (${currentPages.length}), cleaning up`);
            for (let i = currentPages.length - 1; i > 0; i--) {
                const p = currentPages[i];
                try {
                    activePages.delete(p);
                    if (!p.isClosed()) {
                        await p.close().catch(() => {});
                    }
                } catch (e) {
                    // Ignore errors
                }
            }
            const pagesAfterCleanup = await browser.pages();
            if (pagesAfterCleanup.length >= MAX_PAGES_PER_BROWSER) {
                throw new Error(`Too many pages (${pagesAfterCleanup.length}) after cleanup`);
            }
        }
        
        page = await browser.newPage();
        activePages.add(page);
        
        page.setDefaultTimeout(BROWSER_TIMEOUT_MS);
        
        page.on('error', (error) => {
            logger.warn(`Page error: ${error.message}`);
        });
        
        page.on('pageerror', (error) => {
            logger.warn(`Page JS error: ${error.message}`);
        });
        
        logger.debug(`Fetching page with Puppeteer: ${url}`);
        
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1920, height: 1080 });
        
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
            });
        });
        
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: BROWSER_TIMEOUT_MS
        });
        
        const pageTitle = await page.title();
        const pageContent = await page.content();
        
        if (pageTitle.includes('Just a moment') || pageContent.includes('challenges.cloudflare.com')) {
            logger.warn('Cloudflare challenge detected');
            
            const detectedDisplay = detectDisplay();
            const hasDisplay = detectedDisplay !== null;
            
            if (detectedDisplay && !process.env.DISPLAY) {
                process.env.DISPLAY = detectedDisplay;
            }
            
            if (isBrowserHeadless && hasDisplay) {
                logger.info('Cookies expired - restarting browser in visible mode for Cloudflare challenge');
                cloudflareChallengeDetected = true;
                needsVisibleBrowser = true;
                
                if (page) {
                    activePages.delete(page);
                    try {
                        if (!page.isClosed()) {
                            await page.close().catch(() => {});
                        }
                    } catch (e) {
                        activePages.delete(page);
                    }
                }
                
                if (browser && browser.isConnected()) {
                    try {
                        const pages = await browser.pages();
                        for (const p of pages) {
                            activePages.delete(p);
                            try {
                                if (!p.isClosed()) {
                                    await p.close().catch(() => {});
                                }
                            } catch (e) {
                                activePages.delete(p);
                            }
                        }
                    } catch (e) {
                        activePages.clear();
                    }
                    try {
                        await browser.close();
                    } catch (e) {
                        // Browser might already be closed
                    }
                }
                
                globalBrowser = null;
                browserInitializing = false;
                browserInitPromise = null;
                isBrowserHeadless = false;
                
                browser = await getBrowser();
                
                if (!browser.isConnected()) {
                    throw new Error('Browser disconnected after restart');
                }
                
                page = await browser.newPage();
                activePages.add(page);
                
                page.setDefaultTimeout(BROWSER_TIMEOUT_MS);
                page.on('error', (error) => {
                    logger.warn(`Page error: ${error.message}`);
                });
                page.on('pageerror', (error) => {
                    logger.warn(`Page JS error: ${error.message}`);
                });
                
                await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                await page.setViewport({ width: 1920, height: 1080 });
                await page.evaluateOnNewDocument(() => {
                    Object.defineProperty(navigator, 'webdriver', {
                        get: () => undefined
                    });
                });
                
                logger.debug('Navigating again with visible browser');
                await page.goto(url, {
                    waitUntil: 'networkidle2',
                    timeout: BROWSER_TIMEOUT_MS
                });
                
                const newPageTitle = await page.title();
                const newPageContent = await page.content();
                if (newPageTitle.includes('Just a moment') || newPageContent.includes('challenges.cloudflare.com')) {
                    logger.info('Browser window is now visible - complete the Cloudflare challenge manually');
                }
            } else if (isBrowserHeadless && !hasDisplay) {
                logger.warn('Cloudflare challenge detected but no display available - waiting in headless mode');
            } else {
                logger.info('Browser is already in visible mode - complete the Cloudflare challenge manually');
            }
        }
        
        logger.debug('Waiting for Cloudflare challenge');
        try {
            await Promise.race([
                page.waitForSelector('h2', { timeout: CLOUDFLARE_WAIT_TIMEOUT_MS }),
                page.waitForFunction(
                    () => !document.title.includes('Just a moment'),
                    { timeout: CLOUDFLARE_WAIT_TIMEOUT_MS }
                )
            ]);
            logger.debug('Cloudflare challenge passed');
            
            if (needsVisibleBrowser) {
                cloudflareChallengeDetected = false;
                logger.info('Cookies saved - next requests will use headless mode');
            }
        } catch (e) {
            logger.debug('Still waiting for Cloudflare');
            await page.waitForTimeout(3000);
        }
        
        try {
            await page.waitForSelector('h2', { timeout: 30000 });
            logger.debug('Page content loaded');
        } catch (e) {
            logger.debug('h2 element not found, continuing anyway');
        }
        
        const pageHtml = await page.content();
        logger.debug(`Got HTML (length: ${pageHtml.length})`);
        
        if (pageHtml.includes('Just a moment') || pageHtml.includes('challenges.cloudflare.com')) {
            logger.warn('Still on Cloudflare challenge page - complete manually in browser window');
        }
        
        return pageHtml;
    } catch (error) {
        logger.error(`Error fetching MultiUp page: ${error.message}`);
        throw error;
    } finally {
        if (page) {
            try {
                activePages.delete(page);
                if (!page.isClosed()) {
                    await page.close().catch(() => {});
                }
            } catch (e) {
                activePages.delete(page);
            }
        }
        releaseBrowserSlot();
    }
}

// Fetch title from IMDB ID using Cinemeta
async function getTitleFromImdbId(imdbId, type) {
    try {
        logger.debug(`Fetching title from Cinemeta for ${imdbId}`);
        const response = await axios.get(`${CINEMETA_API_URL}/meta/${type}/${imdbId}.json`, {
            timeout: 10000
        });
        
        if (response.data && response.data.meta && response.data.meta.name) {
            const title = response.data.meta.name;
            logger.debug(`Found title: ${title}`);
            return title;
        }
        return null;
    } catch (error) {
        logger.error(`Error fetching title from Cinemeta: ${error.message}`);
        return null;
    }
}

// Helper function to format title for search
function formatTitleForSearch(title, season, episode) {
    let searchTitle = title
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    
    const seasonStr = season.toString().padStart(2, '0');
    const episodeStr = episode.toString().padStart(2, '0');
    
    return `${searchTitle} S${seasonStr}E${episodeStr}`;
}

// Helper function to create error stream objects
function createErrorStream(title, season, episode, errorReason, errorDescription) {
    const titleLine1 = `📁  ${title} S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}`;
    const titleLine2 = `❌ No stream links were found`;
    const streamTitle = `${titleLine1}\n${titleLine2}`;
    
    const streamName = `❌  Streamzio`;
    
    // Combine "No stream links were found" with the error reason in the description
    const fullDescription = `No stream links were found. ${errorDescription}`;
    
    // Create a proper HTTP URL for the error page with encoded parameters
    const baseUrl = getPublicBaseUrl();
    const errorParams = new URLSearchParams({
        title: title,
        season: season.toString(),
        episode: episode.toString(),
        reason: errorReason,
        description: errorDescription
    });
    const errorUrl = `${baseUrl}/error?${errorParams.toString()}`;
    
    return {
        title: streamTitle,
        name: streamName,
        description: fullDescription,
        externalUrl: errorUrl
    };
}

// Search scnlog.me for content
async function searchScnlog(title, season, episode) {
    try {
        const searchQuery = formatTitleForSearch(title, season, episode);
        logger.debug(`Searching scnlog.me for: ${searchQuery}`);
        
        const searchUrl = `https://scnlog.me/?s=${encodeURIComponent(searchQuery)}`;
        const response = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 15000
        });
        
        const $ = cheerio.load(response.data);
        
        let postUrl = null;
        const titleLower = title.toLowerCase();
        const titleWords = titleLower
            .split(/\s+/)
            .filter(word => word.length > 2)
            .filter(word => !['the', 'and', 'or', 'but', 'for', 'with'].includes(word));
        
        const seasonStr = season.toString().padStart(2, '0');
        const episodeStr = episode.toString().padStart(2, '0');
        const searchPattern = new RegExp(`S0?${season}[Ee]0?${episode}`, 'i');
        
        $('a').each((i, elem) => {
            const href = $(elem).attr('href');
            const text = $(elem).text();
            
            if (href && href.includes('/foreign/')) {
                const textLower = text.toLowerCase();
                
                if (!searchPattern.test(text)) {
                    return;
                }
                
                const matchingWords = titleWords.filter(word => textLower.includes(word));
                
                if (matchingWords.length >= Math.min(2, titleWords.length) || 
                    (titleWords.length <= 2 && matchingWords.length >= 1)) {
                    postUrl = href.startsWith('http') ? href : `https://scnlog.me${href}`;
                    return false;
                }
            }
        });
        
        if (!postUrl) {
            logger.debug(`No matching post found for ${searchQuery}`);
            return null;
        }
        
        logger.debug(`Found post: ${postUrl}`);
        return postUrl;
    } catch (error) {
        logger.error(`Error searching scnlog.me: ${error.message}`);
        return null;
    }
}

// Extract MultiUp link from scnlog page
async function extractMultiUpLink(postUrl) {
    try {
        logger.debug(`Fetching page: ${postUrl}`);
        const response = await axios.get(postUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 30000
        });
        
        const $ = cheerio.load(response.data);
        
        let multiUpLink = null;
        
        $('a[href*="multiup.io"], a[href*="multiup.org"]').each((i, elem) => {
            const href = $(elem).attr('href');
            if (href && href.includes('/download/')) {
                multiUpLink = href;
                return false;
            }
        });
        
        if (!multiUpLink) {
            $('a[href*="multiup.io"], a[href*="multiup.org"]').each((i, elem) => {
                const href = $(elem).attr('href');
                if (href && href.includes('/mirror/')) {
                    multiUpLink = href;
                    return false;
                }
            });
        }
        
        if (!multiUpLink) {
            const textContent = $.text();
            const multiUpMatch = textContent.match(/https?:\/\/(?:www\.)?multiup\.(?:io|org)\/[^\s<>"']+/i);
            if (multiUpMatch) {
                multiUpLink = multiUpMatch[0];
            }
        }
        
        if (!multiUpLink) {
            logger.debug('No MultiUp link found on page');
            return null;
        }
        
        logger.debug(`Found MultiUp link: ${multiUpLink}`);
        return multiUpLink;
    } catch (error) {
        logger.error(`Error extracting MultiUp link: ${error.message}`);
        return null;
    }
}

// Extract quality and scenegroup from scnlog post title
function extractMetadataFromPostTitle(postTitle) {
    let quality = null;
    if (postTitle.match(/4k/i)) {
        quality = '4K';
    } else {
        const qualityMatch = postTitle.match(/(\d{3,4}p)/i);
        if (qualityMatch) {
            const res = qualityMatch[1].toLowerCase();
            if (res === '2160p') {
                quality = '4K';
            } else {
                quality = res;
            }
        }
    }
    
    const scenegroupMatch = postTitle.match(/-([A-Z]+)(?:\.mkv|\.mp4|\.avi|$)/i);
    const scenegroup = scenegroupMatch ? scenegroupMatch[1].toUpperCase() : null;
    
    return { quality, scenegroup };
}

// Parse MultiUp h2 heading to extract filename and size
function parseMultiUpHeading(heading) {
    if (!heading) return { filename: null, size: null, sizeUnit: null };
    
    const sizeMatch = heading.match(/\(\s*([\d.]+)\s+([KMGT]?B)\s*\)/i);
    if (sizeMatch) {
        const size = parseFloat(sizeMatch[1]);
        const unit = sizeMatch[2].toUpperCase();
        return { filename: null, size, sizeUnit: unit };
    }
    
    return { filename: null, size: null, sizeUnit: null };
}

// Format file size for display
function formatFileSize(size, unit) {
    if (!size || !unit) return '';
    
    let displaySize = size;
    let displayUnit = unit;
    
    if (unit === 'KB') {
        displaySize = size / (1024 * 1024);
        displayUnit = 'GB';
    } else if (unit === 'MB') {
        displaySize = size / 1024;
        displayUnit = 'GB';
    }
    
    displaySize = Math.round(displaySize * 100) / 100;
    
    return `${displaySize} ${displayUnit}`;
}

// Extract hoster links from MultiUp
async function extractHosterLinks(multiUpLink, postTitle = '') {
    try {
        logger.debug(`Extracting hoster links from: ${multiUpLink}`);
        
        let extractUrl = multiUpLink;
        
        if (multiUpLink.includes('/download/')) {
            const match = multiUpLink.match(/\/download\/([a-f0-9]{32})/);
            if (match) {
                extractUrl = `https://multiup.io/en/mirror/${match[1]}`;
                logger.debug(`Converted to mirror page: ${extractUrl}`);
            } else {
                logger.warn('Could not extract ID from download link');
                return { links: [], metadata: { quality: null, scenegroup: null, size: null, sizeUnit: null } };
            }
        } else if (multiUpLink.includes('/mirror/')) {
            if (!multiUpLink.includes('/en/mirror/')) {
                const match = multiUpLink.match(/\/mirror\/([a-f0-9]{32})/);
                if (match) {
                    extractUrl = `https://multiup.io/en/mirror/${match[1]}`;
                }
            }
        }
        
        logger.debug(`Fetching page: ${extractUrl}`);
        const pageHtml = await fetchMultiUpPage(extractUrl);
        
        const $ = cheerio.load(pageHtml);
        
        const h2Selector = 'body > section > div > section > header > h2';
        const h2Element = $(h2Selector).first();
        const h2Text = h2Element.text().trim();
        const { size, sizeUnit } = parseMultiUpHeading(h2Text);
        logger.debug(`File size: ${size} ${sizeUnit || 'unknown'}`);
        
        const hosterLinks = [];
        
        const buttons = $('button[type="submit"], a.host');
        
        buttons.each((i, elem) => {
            try {
                let host = $(elem).attr('namehost');
                if (!host) {
                    host = $(elem).attr('nameHost');
                }
                
                const link = $(elem).attr('link');
                let validity = $(elem).attr('validity');
                
                if (!host || !link || !validity) {
                    return;
                }
                
                if (link.startsWith('/')) {
                    return;
                }
                
                hosterLinks.push({
                    host: host,
                    url: link,
                    validity: validity
                });
            } catch (error) {
                return;
            }
        });
        
        logger.debug(`Extracted ${hosterLinks.length} hoster links`);
        
        const hasPassword = $('input[name="password"][type="password"]').length > 0;
        if (hasPassword) {
            logger.warn('Page is password protected - skipping');
            return { links: [], metadata: { quality: null, scenegroup: null, size: null, sizeUnit: null } };
        }
        
        const errorElement = $('.alert.alert-danger > strong').first();
        if (errorElement.length > 0) {
            const errorText = errorElement.text().trim();
            if (errorText && errorText.includes('could not be found')) {
                logger.error(`File not found: ${errorText}`);
                return { links: [], metadata: { quality: null, scenegroup: null, size: null, sizeUnit: null } };
            }
        }
        
        if (hosterLinks.length === 0) {
            logger.warn('No hoster links found');
            return { links: [], metadata: { quality: null, scenegroup: null, size: null, sizeUnit: null } };
        }
        
        const validLinks = hosterLinks.filter(link => link.validity === 'valid');
        
        if (validLinks.length === 0) {
            logger.warn(`Found ${hosterLinks.length} hoster links, but none are valid`);
            const { quality, scenegroup } = extractMetadataFromPostTitle(postTitle);
            return {
                links: [],
                metadata: {
                    quality: quality || 'Unknown',
                    scenegroup: scenegroup || 'Unknown',
                    size: size,
                    sizeUnit: sizeUnit
                }
            };
        }
        
        const { quality, scenegroup } = extractMetadataFromPostTitle(postTitle);
        
        logger.info(`Found ${validLinks.length} valid hoster links (skipped ${hosterLinks.length - validLinks.length} invalid/unknown)`);
        return {
            links: validLinks,
            metadata: {
                quality: quality || 'Unknown',
                scenegroup: scenegroup || 'Unknown',
                size: size,
                sizeUnit: sizeUnit
            }
        };
    } catch (error) {
        logger.error(`Error extracting hoster links: ${error.message}`);
        return { links: [], metadata: { quality: null, scenegroup: null, size: null, sizeUnit: null } };
    }
}

// Add link to Real-Debrid and get streaming URL
async function getRealDebridStream(link, apiKey) {
    try {
        logger.debug(`Adding to Real-Debrid: ${link}`);
        
        const response = await axios.post(
            `${REALDEBRID_API_URL}/unrestrict/link`,
            `link=${encodeURIComponent(link)}`,
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                timeout: 30000
            }
        );
        
        const data = response.data;
        
        if (data.download) {
            logger.debug(`Real-Debrid stream ready: ${data.download}`);
            return {
                url: data.download,
                filename: data.filename || null,
                size: data.filesize || null
            };
        }
        
        return null;
    } catch (error) {
        const errorData = error.response?.data || {};
        const errorCode = errorData.error_code;
        const errorMsg = errorData.error || error.message;
        
        let hosterName = 'unknown';
        try {
            const urlObj = new URL(link);
            hosterName = urlObj.hostname.replace('www.', '').split('.')[0];
        } catch (e) {
            const hosterMatch = link.match(/https?:\/\/(?:www\.)?([^\/]+)/);
            if (hosterMatch) {
                hosterName = hosterMatch[1].split('.')[0];
            }
        }
        
        if (errorCode === 16 || errorMsg === 'hoster_unsupported' || errorMsg?.includes('unsupported')) {
            logger.warn(`Hoster not supported by Real-Debrid: ${hosterName} (error_code: ${errorCode || 'N/A'})`);
        } else if (errorCode === 24 || errorMsg === 'unavailable_file' || errorMsg?.includes('unavailable')) {
            logger.warn(`File unavailable on Real-Debrid: ${hosterName} (error_code: ${errorCode || 'N/A'})`);
        } else {
            logger.error(`Real-Debrid error for ${hosterName}: ${errorMsg || 'Unknown error'} (error_code: ${errorCode || 'N/A'})`);
        }
        
        return null;
    }
}

// Helper function to wrap async operations with timeout
function withTimeout(promise, timeoutMs, operationName) {
    let timeoutId = null;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    });
    
    return Promise.race([
        promise.finally(() => {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        }),
        timeoutPromise
    ]);
}

// Stream Handler
builder.defineStreamHandler(async ({ type, id }) => {
    const requestStartTime = Date.now();
    logger.info(`Stream request received: type=${type}, id=${id}`);
    
    if (isShuttingDown) {
        logger.warn('Server is shutting down, rejecting request');
        return { streams: [] };
    }
    
    const config = getConfig();
    
    if (!config.realdebrid.apiKey || !config.realdebrid.enabled) {
        logger.warn('Real-Debrid not configured');
        return { streams: [] };
    }
    
    try {
        return await withTimeout(
            handleStreamRequest(type, id, requestStartTime, config),
            REQUEST_TIMEOUT_MS,
            'Stream request'
        );
    } catch (error) {
        if (error.message.includes('timed out')) {
            logger.error(`Request timed out: ${error.message}`);
        } else {
            logger.error(`Error in stream handler: ${error.message}`);
        }
        return { streams: [] };
    }
});

// Stream request handler
async function handleStreamRequest(type, id, requestStartTime, config) {
    try {
        const parts = id.split(':');
        
        if (type === 'series' && parts.length >= 3) {
            const imdbId = parts[0];
            const season = parseInt(parts[parts.length - 2]);
            const episode = parseInt(parts[parts.length - 1]);
            
            if (isNaN(season) || isNaN(episode) || season < 1 || episode < 1) {
                logger.warn(`Invalid season/episode: S${season}E${episode}`);
                return { streams: [] };
            }
            
            if (imdbId.startsWith('tt')) {
                const cachedStreams = getCachedStreams(imdbId, season, episode);
                if (cachedStreams) {
                    const cacheTime = Date.now() - requestStartTime;
                    logger.info(`Returning ${cachedStreams.length} cached streams for ${imdbId} S${season}E${episode} (${cacheTime}ms)`);
                    return { streams: cachedStreams };
                }
            }
            
            let title = null;
            if (imdbId.startsWith('tt')) {
                title = await getTitleFromImdbId(imdbId, type);
                if (!title) {
                    logger.warn(`Could not fetch title for IMDB ID: ${imdbId}`);
                    return { streams: [] };
                }
            } else {
                title = parts.slice(0, -2).join(':');
            }
            
            if (!title) {
                logger.warn(`No title found in ID: ${id}`);
                return { streams: [] };
            }
            
            logger.info(`Processing: ${title} S${season}E${episode}`);
            
            const searchStartTime = Date.now();
            const postUrl = await searchScnlog(title, season, episode);
            const searchTime = Date.now() - searchStartTime;
            logger.timing('Search', searchTime);
            
            if (!postUrl) {
                logger.info('No post found - returning error stream');
                await cleanupBrowserPages();
                const errorStream = createErrorStream(
                    title,
                    season,
                    episode,
                    'No scnlog post found',
                    'No matching post found on scnlog.me for this episode'
                );
                return { streams: [errorStream] };
            }
            
            const extractStartTime = Date.now();
            const multiUpLink = await extractMultiUpLink(postUrl);
            const extractTime = Date.now() - extractStartTime;
            logger.timing('MultiUp extraction', extractTime);
            
            if (!multiUpLink) {
                logger.info('No MultiUp link found - returning error stream');
                await cleanupBrowserPages();
                const errorStream = createErrorStream(
                    title,
                    season,
                    episode,
                    'No MultiUp link found',
                    'No MultiUp download link found on the scnlog.me post'
                );
                return { streams: [errorStream] };
            }
            
            const postTitleResponse = await axios.get(postUrl, { timeout: 15000 }).catch(() => null);
            let postTitle = '';
            if (postTitleResponse) {
                const $post = cheerio.load(postTitleResponse.data);
                postTitle = $post('h1.post-title, h1.entry-title, .post-title, .entry-title').first().text().trim() ||
                           $post('h1').first().text().trim() ||
                           $post('title').text();
            }
            
            const hosterStartTime = Date.now();
            const { links: hosterLinks, metadata } = await extractHosterLinks(multiUpLink, postTitle);
            const hosterTime = Date.now() - hosterStartTime;
            logger.timing('Hoster extraction', hosterTime);
            
            if (hosterLinks.length === 0) {
                logger.info('No valid hoster links found - returning error stream');
                await cleanupBrowserPages();
                // Check if metadata exists (means hosters were found but invalid)
                const hasMetadata = metadata && (metadata.quality || metadata.scenegroup);
                const errorReason = hasMetadata ? 'No valid hosters' : 'No hoster links found';
                const errorDescription = hasMetadata 
                    ? 'Hoster links found on MultiUp, but none are valid or supported by Real-Debrid'
                    : 'No hoster download links found on the MultiUp mirror page';
                const errorStream = createErrorStream(
                    title,
                    season,
                    episode,
                    errorReason,
                    errorDescription
                );
                return { streams: [errorStream] };
            }
            
            let qualityDisplay = metadata.quality || 'Unknown';
            if (qualityDisplay !== '4K' && qualityDisplay.match(/\d+p/i)) {
                qualityDisplay = qualityDisplay.toLowerCase();
            }
            
            const sizeDisplay = formatFileSize(metadata.size, metadata.sizeUnit);
            const scenegroupDisplay = metadata.scenegroup || 'Unknown';
            
            const rdStartTime = Date.now();
            const streams = [];
            for (const hosterLink of hosterLinks) {
                try {
                    const stream = await getRealDebridStream(hosterLink.url, config.realdebrid.apiKey);
                    if (stream) {
                        const titleLine1 = `📁  ${title} S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}`;
                        const titleLine2Parts = [];
                        
                        if (sizeDisplay) {
                            titleLine2Parts.push(`💾  ${sizeDisplay}`);
                        }
                        
                        titleLine2Parts.push(`🏷️  ${scenegroupDisplay}`);
                        
                        const titleLine2 = titleLine2Parts.join('   ');
                        const titleLine3 = `🔎  ${hosterLink.host}`;
                        const streamTitle = `${titleLine1}\n${titleLine2}\n${titleLine3}`;
                        
                        const streamSubtitle = `Streamzio ${qualityDisplay}`;
                        
                        streams.push({
                            title: streamTitle,
                            name: streamSubtitle,
                            url: stream.url,
                            behaviorHints: {
                                bingeGroup: `${title}-S${season}E${episode}`,
                                notWebReady: false
                            }
                        });
                        logger.info(`Added stream from ${hosterLink.host}`);
                        break;
                    }
                } catch (error) {
                    // Error already logged in getRealDebridStream
                }
            }
            
            await cleanupBrowserPages();
            
            if (streams.length === 0) {
                logger.info('Real-Debrid failed for all hosters - returning error stream');
                const errorStream = createErrorStream(
                    title,
                    season,
                    episode,
                    'No valid hosters',
                    `Found ${hosterLinks.length} valid hoster link(s), but Real-Debrid failed to process them (hosters may be unsupported or files unavailable)`
                );
                return { streams: [errorStream] };
            }
            
            if (imdbId.startsWith('tt') && streams.length > 0) {
                setCachedStreams(imdbId, season, episode, streams);
            }
            
            const rdTime = Date.now() - rdStartTime;
            const totalTime = Date.now() - requestStartTime;
            logger.timing('Real-Debrid processing', rdTime);
            logger.timing('Total request', totalTime);
            logger.info(`Returning ${streams.length} stream(s)`);
            
            return { streams };
        } else if (type === 'movie' && parts.length >= 2) {
            const title = parts.slice(1).join(':');
            logger.info(`Request for movie: ${title} (not supported yet)`);
            return { streams: [] };
        }
        
        return { streams: [] };
    } catch (error) {
        logger.error(`Error in stream handler: ${error.message}`);
        try {
            await cleanupBrowserPages();
        } catch (cleanupError) {
            logger.warn(`Cleanup error: ${cleanupError.message}`);
        }
        return { streams: [] };
    }
}

// Graceful shutdown handler
async function gracefulShutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    
    logger.info('Starting graceful shutdown');
    
    const pageClosePromises = Array.from(activePages).map(page => {
        try {
            if (!page.isClosed()) {
                return page.close().catch(() => {});
            }
        } catch (e) {
            return Promise.resolve();
        }
    });
    await Promise.all(pageClosePromises);
    activePages.clear();
    
    if (globalBrowser && globalBrowser.isConnected()) {
        try {
            logger.info('Closing browser');
            await globalBrowser.close();
            logger.info('Browser closed');
        } catch (error) {
            logger.warn(`Error closing browser: ${error.message}`);
        }
    }
    
    globalBrowser = null;
    browserInitializing = false;
    browserInitPromise = null;
    
    if (periodicCleanupInterval) {
        clearInterval(periodicCleanupInterval);
        periodicCleanupInterval = null;
    }
    
    logger.info('Graceful shutdown complete');
}

// Setup signal handlers
process.on('SIGTERM', async () => {
    await gracefulShutdown();
    process.exit(0);
});

process.on('SIGINT', async () => {
    await gracefulShutdown();
    process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled Rejection: ${reason}`);
    if (reason && reason.stack) {
        logger.error(`Stack: ${reason.stack}`);
    }
    cleanupBrowserPages().catch(err => {
        logger.warn(`Cleanup failed in unhandled rejection: ${err.message}`);
    });
});

process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error.message}`);
    gracefulShutdown().then(() => {
        process.exit(1);
    });
});

// Start server
async function startServer() {
    const config = getConfig();
    
    if (!config.realdebrid.apiKey || !config.realdebrid.enabled) {
        logger.warn('Real-Debrid not configured. Please set REALDEBRID_API_KEY or edit config.json');
    }
    
    preStartBrowser().catch(err => {
        logger.warn(`Browser pre-start error: ${err.message}`);
    });
    
    const httpPort = config.server.port || 7004;
    const app = express();
    
    app.use((req, _res, next) => {
        try {
            const host = req.headers.host;
            if (host) {
                const proto = req.headers['x-forwarded-proto'] || 
                             (req.secure ? 'https' : 'http');
                dynamicBaseUrl = `${proto}://${host}`;
            }
        } catch (_e) {}
        next();
    });
    
    app.use(express.static(__dirname));
    
    app.get('/manifest.json', (req, res) => {
        const baseUrl = getPublicBaseUrl();
        const dynamicManifest = {
            id: manifest.id,
            version: manifest.version,
            name: manifest.name,
            description: manifest.description,
            logo: `${baseUrl}/logo.jpg`,
            background: manifest.background,
            types: manifest.types,
            catalogs: manifest.catalogs,
            resources: manifest.resources,
            idPrefixes: manifest.idPrefixes
        };
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.json(dynamicManifest);
    });
    
    const addonInterface = builder.getInterface();
    const router = getRouter(addonInterface);
    app.use(router);
    
    app.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            realdebrid: config.realdebrid.enabled ? 'configured' : 'not configured'
        });
    });
    
    // Helper function to escape HTML
    function escapeHtml(text) {
        if (!text) return '';
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return String(text).replace(/[&<>"']/g, m => map[m]);
    }
    
    // Error page endpoint for displaying error messages in Stremio
    app.get('/error', (req, res) => {
        const title = req.query.title || 'Unknown';
        const season = req.query.season || '0';
        const episode = req.query.episode || '0';
        const reason = req.query.reason || 'Unknown error';
        const description = req.query.description || 'No additional details available';
        
        const seasonStr = String(season).padStart(2, '0');
        const episodeStr = String(episode).padStart(2, '0');
        
        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Streamzio - Error</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            margin: 0;
            padding: 20px;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .container {
            background: white;
            border-radius: 12px;
            padding: 40px;
            max-width: 600px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        h1 {
            color: #e74c3c;
            margin-top: 0;
            font-size: 28px;
        }
        .error-icon {
            font-size: 64px;
            text-align: center;
            margin-bottom: 20px;
        }
        .info {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 8px;
            margin: 20px 0;
        }
        .info-item {
            margin: 10px 0;
            font-size: 16px;
        }
        .info-label {
            font-weight: bold;
            color: #495057;
        }
        .description {
            background: #fff3cd;
            border-left: 4px solid #ffc107;
            padding: 15px;
            margin: 20px 0;
            border-radius: 4px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="error-icon">❌</div>
        <h1>No Stream Available</h1>
        <div class="info">
            <div class="info-item">
                <span class="info-label">Title:</span> ${escapeHtml(title)}
            </div>
            <div class="info-item">
                <span class="info-label">Episode:</span> S${seasonStr}E${episodeStr}
            </div>
            <div class="info-item">
                <span class="info-label">Reason:</span> ${escapeHtml(reason)}
            </div>
        </div>
        <div class="description">
            <strong>Details:</strong><br>
            ${escapeHtml(description)}
        </div>
        <p style="color: #6c757d; font-size: 14px; margin-top: 30px;">
            This error stream was created by Streamzio to inform you that no playable streams were found for this content.
        </p>
    </div>
</body>
</html>`;
        
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(html);
    });
    
    app.get('/', (req, res) => {
        res.json({
            status: 'online',
            service: 'Streamzio',
            version: manifest.version,
            port: httpPort,
            endpoints: {
                manifest: '/manifest.json',
                health: '/health',
                error: '/error'
            },
            installUrl: `http://localhost:${httpPort}/manifest.json`
        });
    });
    
    const server = app.listen(httpPort, '127.0.0.1', () => {
        logger.info(`Streamzio server running on port ${httpPort}`);
        logger.info(`Install in Stremio: http://localhost:${httpPort}/manifest.json`);
        logger.info('For network access, use HTTPS (e.g., via localtunnel)');
    });
    
    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            logger.error(`Port ${httpPort} is already in use`);
            logger.error('Please stop the other process or use a different port');
            process.exit(1);
        } else {
            logger.error(`HTTP server error: ${error.message}`);
            process.exit(1);
        }
    });
    
    server.on('close', async () => {
        await gracefulShutdown();
    });
}

if (require.main === module) {
    startServer().catch((error) => {
        logger.error(`Failed to start server: ${error.message}`);
        process.exit(1);
    });
}

module.exports = { startServer };
