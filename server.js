const { addonBuilder, getRouter, serveHTTP } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { getConfig } = require('./config');

// Use stealth plugin to bypass Cloudflare detection
puppeteer.use(StealthPlugin());

const REALDEBRID_API_URL = 'https://api.real-debrid.com/rest/1.0';
const CINEMETA_API_URL = 'https://v3-cinemeta.strem.io';

// Addon Manifest
const manifest = {
    id: 'org.streamzio.flemish',
    version: '1.0.0',
    name: 'Streamzio - Flemish Content',
    description: 'Flemish content from scnlog.me with Real-Debrid integration',
    logo: 'https://via.placeholder.com/150',
    background: '',
    types: ['series', 'movie'],
    catalogs: [],
    resources: ['stream'],
    idPrefixes: ['tt'] // Enable for Cinemeta (IMDB) content
};

const builder = new addonBuilder(manifest);

const path = require('path');
const fs = require('fs');

// Global browser instance (reused across requests for speed)
let globalBrowser = null;
let browserInitializing = false;
let browserInitPromise = null;
let cloudflareChallengeDetected = false;  // Track if Cloudflare challenge was detected
let isBrowserHeadless = false;  // Track if current browser is in headless mode

// Find Chrome/Chromium executable (works on macOS, Linux, Raspberry Pi)
function findBrowserExecutable() {
    const possiblePaths = [
        // macOS
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        // Linux / Raspberry Pi
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/snap/bin/chromium',
        // Environment variables
        process.env.CHROME_PATH,
        process.env.CHROMIUM_PATH,
        // Common fallbacks
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

// Initialize browser instance (reused for speed)
async function getBrowser() {
    // Return existing browser if available
    if (globalBrowser && globalBrowser.isConnected()) {
        return globalBrowser;
    }
    
    // If already initializing, wait for that promise
    if (browserInitializing && browserInitPromise) {
        return await browserInitPromise;
    }
    
    // Start initialization
    browserInitializing = true;
    browserInitPromise = (async () => {
        try {
            console.log(`🌐 Initializing browser instance (will be reused for all requests)...`);
            
            const executablePath = findBrowserExecutable();
            if (executablePath) {
                console.log(`✅ Found browser at: ${executablePath}`);
            } else {
                console.log(`⚠️  Browser not found in common paths, trying default...`);
            }
            
            // Create user data directory for persistent cookies/session
            const userDataDir = path.join(__dirname, '.browser-data');
            if (!fs.existsSync(userDataDir)) {
                fs.mkdirSync(userDataDir, { recursive: true });
            }
            
            // Check if we have cookies (indicates Cloudflare was solved before)
            const cookieDbPath = path.join(userDataDir, 'Default', 'Cookies');
            const hasCookies = fs.existsSync(cookieDbPath);
            
            // Check if DISPLAY is available (for headless systems like Raspberry Pi without X server)
            const hasDisplay = process.env.DISPLAY && process.env.DISPLAY !== '';
            
            // Use headless mode if:
            // 1. No display available (headless server), OR
            // 2. Cookies exist AND no challenge was detected recently
            // Otherwise use visible browser for Cloudflare challenge (only if display is available)
            const useHeadless = !hasDisplay || (hasCookies && !cloudflareChallengeDetected);
            
            if (!hasDisplay) {
                console.log(`   No DISPLAY detected - using headless mode (required for headless servers)`);
            } else {
                console.log(`   Mode: ${useHeadless ? 'headless' : 'visible'} (cookies exist: ${hasCookies}, challenge detected: ${cloudflareChallengeDetected})`);
            }
            
            // Browser args optimized for speed and Raspberry Pi compatibility
            const browserArgs = [
                '--no-sandbox',  // Required for Raspberry Pi
                '--disable-setuid-sandbox',  // Required for Raspberry Pi
                '--disable-dev-shm-usage',  // Prevents crashes on low-memory systems
                '--disable-blink-features=AutomationControlled',  // Hide automation
                '--disable-gpu',  // Faster, especially on Raspberry Pi
                '--disable-software-rasterizer',
                '--disable-extensions',  // Faster startup
                '--disable-background-networking',  // Faster
                '--disable-background-timer-throttling',  // Faster
                '--disable-renderer-backgrounding',  // Faster
                '--disable-backgrounding-occluded-windows',  // Faster
                '--disable-ipc-flooding-protection',  // Faster
                '--memory-pressure-off',  // Better for Raspberry Pi
                '--max_old_space_size=4096'  // Limit memory usage
            ];
            
            // Add headless-specific args if no display is available
            if (!hasDisplay) {
                browserArgs.push('--headless=new');  // New headless mode
                browserArgs.push('--virtual-time-budget=5000');  // Helps with Cloudflare bypass
            }
            
            // Launch browser with persistent user data directory
            // Force headless if no display is available
            const finalHeadless = !hasDisplay ? true : useHeadless;
            
            globalBrowser = await puppeteer.launch({
                headless: finalHeadless,
                executablePath: executablePath || undefined,
                userDataDir: userDataDir,
                args: browserArgs
            });
            
            console.log(`✅ Browser initialized and ready (${finalHeadless ? 'headless' : 'visible'} mode)`);
            
            // Track headless state
            isBrowserHeadless = finalHeadless;
            
            // Handle browser disconnection
            globalBrowser.on('disconnected', () => {
                console.log(`⚠️  Browser disconnected, will reinitialize on next request`);
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
            console.error(`❌ Failed to initialize browser: ${error.message}`);
            throw error;
        }
    })();
    
    return await browserInitPromise;
}

// Pre-start browser on server startup for faster first request
async function preStartBrowser() {
    try {
        console.log(`🚀 Pre-starting browser for faster first request...`);
        await getBrowser();
        console.log(`✅ Browser pre-started successfully`);
    } catch (error) {
        console.log(`⚠️  Browser pre-start failed (will start on first request): ${error.message}`);
    }
}

// Fetch MultiUp page using Puppeteer (handles Cloudflare automatically)
async function fetchMultiUpPage(url) {
    let browser = await getBrowser();
    let page = await browser.newPage();
    let needsVisibleBrowser = false;
    
    try {
        console.log(`📄 Fetching page with Puppeteer: ${url}`);
        
        // Set realistic browser properties (optimized)
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1920, height: 1080 });
        
        // Remove webdriver property
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
            });
        });
        
        // Navigate and wait for Cloudflare challenge to complete
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });
        
        // Check if we got a Cloudflare challenge page
        const pageTitle = await page.title();
        const pageContent = await page.content();
        
        if (pageTitle.includes('Just a moment') || pageContent.includes('challenges.cloudflare.com')) {
            console.log(`⚠️  Cloudflare challenge detected!`);
            
            // Check if DISPLAY is available
            const hasDisplay = process.env.DISPLAY && process.env.DISPLAY !== '';
            
            // If we're in headless mode and got a challenge, restart in visible mode (only if display is available)
            if (isBrowserHeadless && hasDisplay) {
                console.log(`🔄 Cookies niet meer geldig! Browser opent opnieuw in visible mode voor Cloudflare challenge...`);
                cloudflareChallengeDetected = true;
                needsVisibleBrowser = true;
                
                // Close current browser and page
                await page.close();
                await browser.close();
                globalBrowser = null;
                browserInitializing = false;
                browserInitPromise = null;
                isBrowserHeadless = false;
                
                // Get new browser in visible mode
                browser = await getBrowser();
                page = await browser.newPage();
                
                // Set properties again
                await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                await page.setViewport({ width: 1920, height: 1080 });
                await page.evaluateOnNewDocument(() => {
                    Object.defineProperty(navigator, 'webdriver', {
                        get: () => undefined
                    });
                });
                
                // Navigate again
                console.log(`📄 Opnieuw navigeren met visible browser...`);
                await page.goto(url, {
                    waitUntil: 'networkidle2',
                    timeout: 60000
                });
                
                // Check again after navigation
                const newPageTitle = await page.title();
                const newPageContent = await page.content();
                if (newPageTitle.includes('Just a moment') || newPageContent.includes('challenges.cloudflare.com')) {
                    console.log(`⚠️  Browser venster is nu zichtbaar - voltooi de Cloudflare challenge handmatig`);
                }
            } else if (isBrowserHeadless && !hasDisplay) {
                console.log(`⚠️  Cloudflare challenge detected but no display available - waiting in headless mode...`);
                console.log(`   💡 On headless servers, Cloudflare may need manual intervention or cookies from another machine`);
            } else {
                console.log(`⚠️  Browser is al in visible mode - voltooi de Cloudflare challenge handmatig`);
            }
        }
        
        // Wait for Cloudflare challenge to complete
        console.log(`⏳ Waiting for Cloudflare challenge...`);
        try {
            await Promise.race([
                page.waitForSelector('h2', { timeout: 45000 }),
                page.waitForFunction(
                    () => !document.title.includes('Just a moment'),
                    { timeout: 45000 }
                )
            ]);
            console.log(`✅ Cloudflare challenge passed`);
            
            // Reset challenge flag after successful pass
            if (needsVisibleBrowser) {
                cloudflareChallengeDetected = false;
                console.log(`✅ Cookies opgeslagen - volgende requests gebruiken headless mode`);
            }
        } catch (e) {
            console.log(`⚠️  Still waiting for Cloudflare...`);
            await page.waitForTimeout(3000);
        }
        
        // Wait for h2 element (like MultiUp-Direct)
        try {
            await page.waitForSelector('h2', { timeout: 30000 });
            console.log(`✅ Page content loaded`);
        } catch (e) {
            console.log(`⚠️  h2 element not found, continuing anyway...`);
        }
        
        // Get page HTML
        const pageHtml = await page.content();
        console.log(`✅ Got HTML (length: ${pageHtml.length})`);
        
        // Final check - if we still have Cloudflare challenge, user needs to complete it manually
        if (pageHtml.includes('Just a moment') || pageHtml.includes('challenges.cloudflare.com')) {
            console.log(`⚠️  ⚠️  ⚠️  Nog steeds op Cloudflare challenge pagina!`);
            console.log(`   💡 Voltooi de challenge handmatig in het browser venster`);
            console.log(`   💡 Na voltooiing worden cookies opgeslagen voor volgende requests`);
        }
        
        // Cookies are automatically saved to .browser-data by Puppeteer
        
        return pageHtml;
    } finally {
        await page.close();
    }
}

// Fetch title from IMDB ID using Cinemeta
async function getTitleFromImdbId(imdbId, type) {
    try {
        console.log(`🔍 Fetching title from Cinemeta for ${imdbId}`);
        const response = await axios.get(`${CINEMETA_API_URL}/meta/${type}/${imdbId}.json`, {
            timeout: 10000
        });
        
        if (response.data && response.data.meta && response.data.meta.name) {
            const title = response.data.meta.name;
            console.log(`✅ Found title: ${title}`);
            return title;
        }
        return null;
    } catch (error) {
        console.error(`❌ Error fetching title from Cinemeta:`, error.message);
        return null;
    }
}

// Helper function to format title for search
function formatTitleForSearch(title, season, episode) {
    // Normalize title: remove special chars, replace spaces with dots
    let searchTitle = title
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, '.')
        .replace(/\.+/g, '.')
        .replace(/^\.|\.$/g, '')
        .toUpperCase();
    
    // Format season and episode as SxxExx
    const seasonStr = season.toString().padStart(2, '0');
    const episodeStr = episode.toString().padStart(2, '0');
    
    return `${searchTitle}.S${seasonStr}E${episodeStr}.FLEMISH`;
}

// Search scnlog.me for content
async function searchScnlog(title, season, episode) {
    try {
        const searchQuery = formatTitleForSearch(title, season, episode);
        console.log(`🔍 Searching scnlog.me for: ${searchQuery}`);
        
        // Search on scnlog.me
        const searchUrl = `https://scnlog.me/?s=${encodeURIComponent(searchQuery)}`;
        const response = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 30000
        });
        
        const $ = cheerio.load(response.data);
        
        // Find the first matching post link
        let postUrl = null;
        const titleLower = title.toLowerCase();
        const searchPattern = new RegExp(`S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}`, 'i');
        
        $('a').each((i, elem) => {
            const href = $(elem).attr('href');
            const text = $(elem).text();
            
            if (href && href.includes('/foreign/')) {
                const textLower = text.toLowerCase();
                // Check if title matches (flexible matching)
                const titleMatch = titleLower.split(' ').every(word => 
                    word.length > 2 ? textLower.includes(word) : true
                );
                
                // Check if it matches the season/episode pattern
                if (titleMatch && searchPattern.test(text)) {
                    postUrl = href.startsWith('http') ? href : `https://scnlog.me${href}`;
                    return false; // break
                }
            }
        });
        
        if (!postUrl) {
            console.log(`❌ No matching post found for ${searchQuery}`);
            return null;
        }
        
        console.log(`✅ Found post: ${postUrl}`);
        return postUrl;
    } catch (error) {
        console.error('❌ Error searching scnlog.me:', error.message);
        return null;
    }
}

// Extract MultiUp link from scnlog page
async function extractMultiUpLink(postUrl) {
    try {
        console.log(`📄 Fetching page: ${postUrl}`);
        const response = await axios.get(postUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 30000
        });
        
        const $ = cheerio.load(response.data);
        
        // Look for MultiUp links - prioritize download links
        let multiUpLink = null;
        
        // First, try to find download links (preferred)
        $('a[href*="multiup.io"], a[href*="multiup.org"]').each((i, elem) => {
            const href = $(elem).attr('href');
            if (href && href.includes('/download/')) {
                multiUpLink = href;
                return false; // break
            }
        });
        
        // If no download link, try mirror links
        if (!multiUpLink) {
            $('a[href*="multiup.io"], a[href*="multiup.org"]').each((i, elem) => {
                const href = $(elem).attr('href');
                if (href && href.includes('/mirror/')) {
                    multiUpLink = href;
                    return false; // break
                }
            });
        }
        
        // Also check text content for MultiUp links
        if (!multiUpLink) {
            const textContent = $.text();
            const multiUpMatch = textContent.match(/https?:\/\/(?:www\.)?multiup\.(?:io|org)\/[^\s<>"']+/i);
            if (multiUpMatch) {
                multiUpLink = multiUpMatch[0];
            }
        }
        
        if (!multiUpLink) {
            console.log(`❌ No MultiUp link found on page`);
            return null;
        }
        
        console.log(`✅ Found MultiUp link: ${multiUpLink}`);
        return multiUpLink;
    } catch (error) {
        console.error('❌ Error extracting MultiUp link:', error.message);
        return null;
    }
}

// Extract quality (1080p/720p/2160p/4K) and scenegroup from scnlog post title
function extractMetadataFromPostTitle(postTitle) {
    // Check for 4K first (can be written as 4K or 2160p)
    let quality = null;
    if (postTitle.match(/4k/i)) {
        quality = '4K';
    } else {
        // Check for resolution patterns: 2160p, 1080p, 720p, etc.
        const qualityMatch = postTitle.match(/(\d{3,4}p)/i);
        if (qualityMatch) {
            // Convert to lowercase 'p' and handle 2160p -> 4K if needed
            const res = qualityMatch[1].toLowerCase();
            if (res === '2160p') {
                quality = '4K';
            } else {
                quality = res; // e.g., '1080p', '720p'
            }
        }
    }
    
    // Scenegroup is usually at the end after a dash, e.g., -TRIPEL, -MERCATOR
    const scenegroupMatch = postTitle.match(/-([A-Z]+)(?:\.mkv|\.mp4|\.avi|$)/i);
    const scenegroup = scenegroupMatch ? scenegroupMatch[1].toUpperCase() : null;
    
    return { quality, scenegroup };
}

// Parse MultiUp h2 heading to extract filename and size
// Format: " / Mirror list filename.ext ( size unit )"
function parseMultiUpHeading(heading) {
    if (!heading) return { filename: null, size: null, sizeUnit: null };
    
    // Extract size and unit: " ( 5.60 kB )" or " ( 1.2 GB )"
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
    
    // Convert to GB if needed for display
    let displaySize = size;
    let displayUnit = unit;
    
    if (unit === 'KB') {
        displaySize = size / (1024 * 1024);
        displayUnit = 'GB';
    } else if (unit === 'MB') {
        displaySize = size / 1024;
        displayUnit = 'GB';
    }
    
    // Round to 2 decimal places
    displaySize = Math.round(displaySize * 100) / 100;
    
    return `${displaySize} ${displayUnit}`;
}

// Extract hoster links from MultiUp using Puppeteer (following MultiUp-Direct logic)
async function extractHosterLinks(multiUpLink, postTitle = '') {
    try {
        console.log(`🔗 Extracting hoster links from: ${multiUpLink}`);
        
        let extractUrl = multiUpLink;
        
        // If it's a download link, convert to mirror page
        // Format: https://multiup.io/download/{id}/{filename}
        if (multiUpLink.includes('/download/')) {
            const match = multiUpLink.match(/\/download\/([a-f0-9]{32})/);
            if (match) {
                extractUrl = `https://multiup.io/en/mirror/${match[1]}`;
                console.log(`   Converted to mirror page: ${extractUrl}`);
            } else {
                console.log(`⚠️  Could not extract ID from download link`);
                return [];
            }
        } else if (multiUpLink.includes('/mirror/')) {
            // Already a mirror link, ensure it has the /en/ prefix
            if (!multiUpLink.includes('/en/mirror/')) {
                const match = multiUpLink.match(/\/mirror\/([a-f0-9]{32})/);
                if (match) {
                    extractUrl = `https://multiup.io/en/mirror/${match[1]}`;
                }
            }
        }
        
        // Fetch page using Puppeteer (handles Cloudflare automatically)
        console.log(`📄 Fetching page: ${extractUrl}`);
        const pageHtml = await fetchMultiUpPage(extractUrl);
        
        // Parse HTML with cheerio (like MultiUp-Direct uses scraper)
        const $ = cheerio.load(pageHtml);
        
        // Extract h2 heading for filename and size (like MultiUp-Direct)
        const h2Selector = 'body > section > div > section > header > h2';
        const h2Element = $(h2Selector).first();
        const h2Text = h2Element.text().trim();
        const { size, sizeUnit } = parseMultiUpHeading(h2Text);
        console.log(`📊 File size: ${size} ${sizeUnit || 'unknown'}`);
        
        // Extract links using EXACT selector as MultiUp-Direct: "button[type='submit'], a.host"
        // MultiUp-Direct code exactly:
        //   let host = button.attr("namehost").ok_or_else(...)?;
        //   let link = button.attr("link").ok_or_else(...)?;
        //   if link.starts_with("/") { continue; }
        //   let validity = button.attr("validity").ok_or_else(...)?;
        const hosterLinks = [];
        
        // Try multiple selectors to find hoster links
        const buttons1 = $('button[type="submit"]');
        const buttons2 = $('a.host');
        const buttons3 = $('button[type="submit"], a.host');
        console.log(`📊 Found ${buttons1.length} button[type="submit"] elements`);
        console.log(`📊 Found ${buttons2.length} a.host elements`);
        console.log(`📊 Found ${buttons3.length} combined button/a.host elements`);
        
        // Log page structure for debugging
        const bodyHtml = $('body').html();
        if (bodyHtml) {
            console.log(`   Body HTML length: ${bodyHtml.length}`);
            console.log(`   Body HTML preview: ${bodyHtml.substring(0, 500)}`);
        }
        
        // Check for common MultiUp page elements
        const hasSection = $('section').length > 0;
        const hasHeader = $('header').length > 0;
        console.log(`   Page structure: ${hasSection ? 'has section' : 'no section'}, ${hasHeader ? 'has header' : 'no header'}`);
        
        const buttons = buttons3;
        
        buttons.each((i, elem) => {
            try {
                // Get attributes (HTML is case-insensitive, but cheerio might need exact case)
                // Try lowercase first (as Rust code uses), then camelCase
                let host = $(elem).attr('namehost');
                if (!host) {
                    host = $(elem).attr('nameHost');  // Fallback to camelCase
                }
                
                const link = $(elem).attr('link');
                let validity = $(elem).attr('validity');
                
                // MultiUp-Direct requires all three attributes, skips if missing
                if (!host || !link || !validity) {
                    return; // Skip this element
                }
                
                // Skip relative links (like MultiUp-Direct: if link.starts_with("/") { continue; })
                if (link.startsWith('/')) {
                    return;
                }
                
                // MultiUp-Direct creates DirectLink with host, link, validity
                hosterLinks.push({
                    host: host,
                    url: link,
                    validity: validity
                });
            } catch (error) {
                // Skip elements with errors (like Rust's ok_or_else)
                return;
            }
        });
        
        console.log(`✅ Extracted ${hosterLinks.length} hoster links`);
        
        // Check for password protection (like MultiUp-Direct)
        const hasPassword = $('input[name="password"][type="password"]').length > 0;
        if (hasPassword) {
            console.log(`⚠️  Page is password protected - skipping`);
            return { links: [], metadata: { quality: null, scenegroup: null, size: null, sizeUnit: null } };
        }
        
        // Check for error messages (like MultiUp-Direct)
        const errorElement = $('.alert.alert-danger > strong').first();
        if (errorElement.length > 0) {
            const errorText = errorElement.text().trim();
            if (errorText && errorText.includes('could not be found')) {
                console.log(`❌ File not found: ${errorText}`);
                return { links: [], metadata: { quality: null, scenegroup: null, size: null, sizeUnit: null } };
            }
        }
        
        if (hosterLinks.length === 0) {
            console.log(`❌ No hoster links found`);
            return { links: [], metadata: { quality: null, scenegroup: null, size: null, sizeUnit: null } };
        }
        
        // Filter to only valid links (like MultiUp-Direct)
        const validLinks = hosterLinks.filter(link => link.validity === 'valid');
        const linksToReturn = validLinks.length > 0 ? validLinks : hosterLinks;
        
        // Extract metadata from post title
        const { quality, scenegroup } = extractMetadataFromPostTitle(postTitle);
        
        console.log(`✅ Found ${linksToReturn.length} hoster links (${validLinks.length} valid)`);
        return {
            links: linksToReturn,
            metadata: {
                quality: quality || 'Unknown',
                scenegroup: scenegroup || 'Unknown',
                size: size,
                sizeUnit: sizeUnit
            }
        };
    } catch (error) {
        // Don't close browser on error - keep it alive for next request
        console.error('❌ Error extracting hoster links:', error.message);
        console.error('Stack:', error.stack);
        return { links: [], metadata: { quality: null, scenegroup: null, size: null, sizeUnit: null } };
    }
}


// Add link to Real-Debrid and get streaming URL
async function getRealDebridStream(link, apiKey) {
    try {
        console.log(`🔓 Adding to Real-Debrid: ${link}`);
        
        // Use Real-Debrid unrestrict API
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
            console.log(`✅ Real-Debrid stream ready: ${data.download}`);
            return {
                url: data.download,
                filename: data.filename || null,
                size: data.filesize || null
            };
        }
        
        return null;
    } catch (error) {
        console.error(`❌ Real-Debrid error:`, error.response?.data || error.message);
        return null;
    }
}

// Stream Handler
builder.defineStreamHandler(async ({ type, id }) => {
    console.log(`\n📺 Stream request received: type=${type}, id=${id}`);
    
    const config = getConfig();
    
    if (!config.realdebrid.apiKey || !config.realdebrid.enabled) {
        console.log('⚠️  Real-Debrid not configured');
        return Promise.resolve({ streams: [] });
    }
    
    try {
        // Parse the ID to extract title, season, episode
        // Stremio uses IMDB IDs: tt123456:season:episode for series
        // Or custom IDs: title:season:episode
        const parts = id.split(':');
        
        if (type === 'series' && parts.length >= 3) {
            const imdbId = parts[0]; // e.g., "tt123456"
            const season = parseInt(parts[parts.length - 2]);
            const episode = parseInt(parts[parts.length - 1]);
            
            // Check if it's an IMDB ID (starts with "tt")
            let title = null;
            if (imdbId.startsWith('tt')) {
                // For IMDB IDs, fetch the title from Cinemeta
                title = await getTitleFromImdbId(imdbId, type);
                if (!title) {
                    console.log(`❌ Could not fetch title for IMDB ID: ${imdbId}`);
                    return Promise.resolve({ streams: [] });
                }
            } else {
                // Title-based ID
                title = parts.slice(0, -2).join(':'); // Handle titles with colons
            }
            
            // Validate season and episode
            if (isNaN(season) || isNaN(episode) || season < 1 || episode < 1) {
                console.log(`❌ Invalid season/episode: S${season}E${episode}`);
                return Promise.resolve({ streams: [] });
            }
            
            if (!title) {
                console.log(`❌ No title found in ID: ${id}`);
                return Promise.resolve({ streams: [] });
            }
            
            console.log(`🎬 Processing: ${title} S${season}E${episode}`);
            
            // Search scnlog.me
            const postUrl = await searchScnlog(title, season, episode);
            if (!postUrl) {
                return Promise.resolve({ streams: [] });
            }
            
            // Extract MultiUp link
            const multiUpLink = await extractMultiUpLink(postUrl);
            if (!multiUpLink) {
                return Promise.resolve({ streams: [] });
            }
            
            // Get post title for metadata extraction (from the actual post heading, not page title)
            const postTitleResponse = await axios.get(postUrl, { timeout: 15000 }).catch(() => null);
            let postTitle = '';
            if (postTitleResponse) {
                const $post = cheerio.load(postTitleResponse.data);
                // Try to get the post title from common scnlog.me selectors
                postTitle = $post('h1.post-title, h1.entry-title, .post-title, .entry-title').first().text().trim() ||
                           $post('h1').first().text().trim() ||
                           $post('title').text();
            }
            
            // Extract hoster links with metadata
            const { links: hosterLinks, metadata } = await extractHosterLinks(multiUpLink, postTitle);
            if (hosterLinks.length === 0) {
                return Promise.resolve({ streams: [] });
            }
            
            // Format stream title and subtitle (swapped)
            // Quality should be lowercase 'p' (1080p, 720p, 4K)
            let qualityDisplay = metadata.quality || 'Unknown';
            // Ensure quality ends with lowercase 'p' if it's a resolution (not 4K)
            if (qualityDisplay !== '4K' && qualityDisplay.match(/\d+p/i)) {
                qualityDisplay = qualityDisplay.toLowerCase();
            }
            
            const sizeDisplay = formatFileSize(metadata.size, metadata.sizeUnit);
            const scenegroupDisplay = metadata.scenegroup || 'Unknown';
            
            // Get Real-Debrid streams - try all hoster links
            const streams = [];
            for (const hosterLink of hosterLinks) {
                try {
                    const stream = await getRealDebridStream(hosterLink.url, config.realdebrid.apiKey);
                    if (stream) {
                        // Title: "📁 'Movie/series Title' SxxExx\n💾 x GB   🏷️ 'Scenegroup name'\n🔎 'hoster'"
                        const titleLine1 = `📁 ${title} S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}`;
                        const titleLine2Parts = [];
                        
                        if (sizeDisplay) {
                            titleLine2Parts.push(`💾 ${sizeDisplay}`);
                        }
                        
                        titleLine2Parts.push(`🏷️ ${scenegroupDisplay}`);
                        
                        const titleLine2 = titleLine2Parts.join('   '); // 3 spaces between GB and 🏷️
                        const titleLine3 = `🔎 ${hosterLink.host}`;
                        const streamTitle = `${titleLine1}\n${titleLine2}\n${titleLine3}`;
                        
                        // Subtitle: "Streamzio 1080p" (lowercase p)
                        const streamSubtitle = `Streamzio ${qualityDisplay}`;
                        
                        streams.push({
                            title: streamTitle,
                            name: streamSubtitle,  // Use 'name' for subtitle in Stremio
                            url: stream.url,
                            behaviorHints: {
                                bingeGroup: `${title}-S${season}E${episode}`,
                                notWebReady: false
                            }
                        });
                        console.log(`✅ Added stream from ${hosterLink.host}`);
                    }
                } catch (error) {
                    console.log(`⚠️  Failed to get stream from ${hosterLink.host}: ${error.message}`);
                    // Continue to next hoster
                }
            }
            
            return Promise.resolve({ streams });
        } else if (type === 'movie' && parts.length >= 2) {
            const title = parts.slice(1).join(':');
            
            console.log(`\n🎬 Request for movie: ${title}`);
            
            // For movies, search without season/episode
            // This would need a different search strategy
            // For now, return empty
            return Promise.resolve({ streams: [] });
        }
        
        return Promise.resolve({ streams: [] });
    } catch (error) {
        console.error('❌ Error in stream handler:', error);
        return Promise.resolve({ streams: [] });
    }
});

// Start server
async function startServer() {
    const config = getConfig();
    
    if (!config.realdebrid.apiKey || !config.realdebrid.enabled) {
        console.log('⚠️  Real-Debrid not configured. Please set REALDEBRID_API_KEY or edit config.json');
    }
    
    // Pre-start browser for faster first request
    preStartBrowser().catch(err => {
        console.log(`⚠️  Browser pre-start error: ${err.message}`);
    });
    
    const httpPort = config.server.port || 7004;
    const app = express();
    
    // Mount Stremio addon router
    const addonInterface = builder.getInterface();
    const router = getRouter(addonInterface);
    app.use(router);
    
    // Health check endpoint
    app.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            realdebrid: config.realdebrid.enabled ? 'configured' : 'not configured'
        });
    });
    
    // Info endpoint
    app.get('/', (req, res) => {
        res.json({
            status: 'online',
            service: 'Streamzio - Flemish Content',
            version: manifest.version,
            port: httpPort,
            endpoints: {
                manifest: '/manifest.json',
                health: '/health'
            },
            installUrl: `http://localhost:${httpPort}/manifest.json`
        });
    });
    
    // Start HTTP server
    const server = app.listen(httpPort, '127.0.0.1', () => {
        console.log(`\n🌐 Streamzio server running on port ${httpPort}`);
        console.log(`📡 Install in Stremio:`);
        console.log(`   http://localhost:${httpPort}/manifest.json`);
        console.log(`\n⚠️  For network access, use HTTPS (e.g., via localtunnel)`);
    });
    
    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            console.error(`\n❌ Port ${httpPort} is already in use.`);
            console.error(`   Please stop the other process or use a different port.`);
            process.exit(1);
        } else {
            console.error('❌ HTTP server error:', error);
            process.exit(1);
        }
    });
}

if (require.main === module) {
    startServer().catch((error) => {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    });
}

module.exports = { startServer };

