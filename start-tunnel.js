#!/usr/bin/env node

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadConfig, saveConfig } = require('./config');

const DEVICE_ID_FILE = path.join(__dirname, '.device-id');
const LOCK_FILE = path.join(__dirname, '.tunnel.lock');
const PORT = 8004; // Default port, will be read from config

// Acquire lock to prevent concurrent tunnel starts
function acquireLock() {
    try {
        // Try to create lock file exclusively
        const fd = fs.openSync(LOCK_FILE, 'wx');
        fs.writeSync(fd, process.pid.toString());
        fs.closeSync(fd);
        return true;
    } catch (error) {
        if (error.code === 'EEXIST') {
            // Lock file exists, check if process is still running
            try {
                const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim());
                // Check if process is still running
                try {
                    process.kill(pid, 0); // Signal 0 just checks if process exists
                    console.log(`⚠️  Lock file exists, process ${pid} is still running`);
                    return false;
                } catch (e) {
                    // Process doesn't exist, remove stale lock
                    console.log(`🧹 Removing stale lock file`);
                    fs.unlinkSync(LOCK_FILE);
                    return acquireLock();
                }
            } catch (e) {
                // Can't read lock file, remove it
                fs.unlinkSync(LOCK_FILE);
                return acquireLock();
            }
        }
        return false;
    }
}

// Release lock
function releaseLock() {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            fs.unlinkSync(LOCK_FILE);
        }
    } catch (error) {
        // Ignore errors
    }
}

// Cleanup stale localtunnel processes - PORT-SPECIFIC VERSION
// Only kills processes on our specific port to avoid interfering with other addons
function cleanupStaleProcesses(deviceId, port) {
    try {
        console.log(`🧹 Cleaning up stale localtunnel processes on port ${port}...`);
        
        const processesToKill = [];
        
        // Find localtunnel processes that use our specific port
        try {
            // First, find all localtunnel processes
            const allLtPids = execSync(`pgrep -f "lt --port"`, { encoding: 'utf8' }).trim();
            if (allLtPids) {
                allLtPids.split('\n').forEach(pid => {
                    try {
                        const pidNum = parseInt(pid);
                        // Get command line to check port
                        const cmdline = execSync(`ps -p ${pidNum} -o args=`, { encoding: 'utf8' }).trim();
                        
                        // Check if it's a localtunnel process
                        if (cmdline.includes('lt') && cmdline.includes('--port')) {
                            // Extract port from command line
                            const portMatch = cmdline.match(/--port\s+(\d+)/);
                            const processPort = portMatch ? parseInt(portMatch[1]) : null;
                            
                            // Only kill if it matches our port
                            if (processPort === port) {
                                console.log(`   Found localtunnel process ${pidNum} on port ${port}`);
                                processesToKill.push(pidNum);
                            } else {
                                console.log(`   Skipping process ${pidNum}: port=${processPort} (different addon)`);
                            }
                        }
                    } catch (e) {
                        // Process might be gone or can't read cmdline
                    }
                });
            }
        } catch (e) {
            // No processes found, that's fine
        }
        
        // Also check for processes directly on the port (as fallback)
        try {
            const portPids = execSync(`lsof -ti:${port}`, { encoding: 'utf8' }).trim();
            if (portPids) {
                portPids.split('\n').forEach(pid => {
                    try {
                        const pidNum = parseInt(pid);
                        // Only add if not already in list
                        if (!processesToKill.includes(pidNum)) {
                            // Check if it's a localtunnel process
                            const cmdline = execSync(`ps -p ${pidNum} -o args=`, { encoding: 'utf8' }).trim();
                            if (cmdline.includes('lt') && cmdline.includes('--port')) {
                                // Extract port to verify
                                const portMatch = cmdline.match(/--port\s+(\d+)/);
                                const processPort = portMatch ? parseInt(portMatch[1]) : null;
                                
                                if (processPort === port) {
                                    console.log(`   Found localtunnel process ${pidNum} on port ${port}`);
                                    processesToKill.push(pidNum);
                                }
                            }
                        }
                    } catch (e) {
                        // Process might be gone
                    }
                });
            }
        } catch (e) {
            // No processes on port, that's fine
        }
        
        // Kill only the processes on our port
        if (processesToKill.length > 0) {
            console.log(`   Killing ${processesToKill.length} localtunnel process(es) on port ${port}: ${processesToKill.join(', ')}`);
            processesToKill.forEach(pidNum => {
                try {
                    // Kill process group for clean shutdown
                    try {
                        process.kill(-pidNum, 'SIGTERM');
                        console.log(`   Sent SIGTERM to process group ${pidNum}`);
                    } catch (e) {
                        process.kill(pidNum, 'SIGTERM');
                        console.log(`   Sent SIGTERM to process ${pidNum}`);
                    }
                } catch (e) {
                    // Process might already be gone
                }
            });
            
            // Wait for graceful shutdown
            let waitCount = 0;
            const checkInterval = setInterval(() => {
                waitCount++;
                const stillRunning = processesToKill.filter(pidNum => {
                    try {
                        process.kill(pidNum, 0); // Signal 0 checks if process exists
                        return true; // Process still exists
                    } catch (e) {
                        return false; // Process is gone
                    }
                });
                
                if (stillRunning.length === 0 || waitCount >= 5) {
                    clearInterval(checkInterval);
                    // Force kill any remaining
                    stillRunning.forEach(pidNum => {
                        try {
                            try {
                                process.kill(-pidNum, 'SIGKILL');
                            } catch (e) {
                                process.kill(pidNum, 'SIGKILL');
                            }
                            console.log(`   Force killed process ${pidNum}`);
                        } catch (e) {
                            // Process already gone
                        }
                    });
                }
            }, 1000);
        } else {
            console.log(`   No localtunnel processes found on port ${port}`);
        }
        
        // Wait a bit for all processes to die
        return new Promise((resolve) => {
            setTimeout(() => {
                // Verify port is free
                let retries = 0;
                const checkPort = setInterval(() => {
                    try {
                        const portPids = execSync(`lsof -ti:${port}`, { encoding: 'utf8' }).trim();
                        if (!portPids || retries >= 5) {
                            clearInterval(checkPort);
                            console.log('✅ Cleanup complete');
                            resolve();
                        }
                        retries++;
                    } catch (e) {
                        // Port is free
                        clearInterval(checkPort);
                        console.log('✅ Cleanup complete');
                        resolve();
                    }
                }, 500);
            }, 2000);
        });
    } catch (error) {
        console.error(`⚠️  Cleanup error (non-fatal): ${error.message}`);
        return Promise.resolve();
    }
}

// Get or generate device ID
function getDeviceId() {
    if (fs.existsSync(DEVICE_ID_FILE)) {
        return fs.readFileSync(DEVICE_ID_FILE, 'utf8').trim();
    }
    
    // Generate unique device ID based on hostname and random hash
    const os = require('os');
    let hostname = os.hostname().toLowerCase();
    
    // Normalize hostname: if it contains "raspberry" or "pi", use "pi"
    if (hostname.includes('raspberry') || hostname.includes('pi')) {
        hostname = 'pi';
    } else {
        // Clean hostname: remove special chars, keep only alphanumeric and hyphens
        hostname = hostname.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    }
    
    const randomHash = crypto.randomBytes(4).toString('hex');
    const deviceId = `${hostname}-${randomHash}`;
    
    // Create full device ID with streamzio prefix
    // Remove any existing streamzio prefix to avoid duplication
    const cleanDeviceId = deviceId.replace(/^streamzio-/, '');
    const fullDeviceId = `streamzio-${cleanDeviceId}`;
    
    // Save for future use
    fs.writeFileSync(DEVICE_ID_FILE, fullDeviceId);
    return fullDeviceId;
}

// Update config.json with tunnel URL
function updateConfigWithTunnelUrl(tunnelUrl) {
    try {
        const config = loadConfig();
        config.server.publicBaseUrl = tunnelUrl;
        saveConfig(config);
        console.log(`✅ Updated config.json with tunnel URL: ${tunnelUrl}`);
    } catch (error) {
        console.error(`❌ Error updating config: ${error.message}`);
    }
}

// Verify tunnel URL matches expected subdomain
function verifyTunnelUrl(tunnelUrl, expectedDeviceId) {
    if (!tunnelUrl || !expectedDeviceId) {
        return false;
    }
    
    // Extract subdomain from URL (format: https://subdomain.loca.lt)
    const urlMatch = tunnelUrl.match(/https:\/\/([^.]+)\.loca\.lt/);
    if (!urlMatch) {
        return false;
    }
    
    const actualSubdomain = urlMatch[1];
    
    // Check if URL contains expected device ID
    if (actualSubdomain === expectedDeviceId) {
        return true;
    }
    
    // Also check if URL contains device ID as substring (in case of prefix/suffix)
    if (actualSubdomain.includes(expectedDeviceId) || expectedDeviceId.includes(actualSubdomain)) {
        return true;
    }
    
    console.error(`❌ URL verification failed!`);
    console.error(`   Expected subdomain: ${expectedDeviceId}`);
    console.error(`   Actual subdomain: ${actualSubdomain}`);
    console.error(`   Full URL: ${tunnelUrl}`);
    
    return false;
}

// Start Localtunnel with retry logic
async function startTunnel(retryCount = 0) {
    const MAX_RETRIES = 3;
    const deviceId = getDeviceId();
    
    // Get port from config
    const config = loadConfig();
    const port = config.server.port || PORT;
    
    // Acquire lock to prevent concurrent starts (only on first attempt)
    if (retryCount === 0) {
        if (!acquireLock()) {
            console.error('❌ Could not acquire lock. Another tunnel instance may be starting.');
            process.exit(1);
        }
        
        // Cleanup stale processes before starting
        await cleanupStaleProcesses(deviceId, port);
    }
    
    startTunnelInternal(deviceId, port, retryCount, MAX_RETRIES);
}

function startTunnelInternal(deviceId, port, retryCount, maxRetries) {
    console.log(`🚀 Starting Localtunnel with subdomain: ${deviceId}`);
    console.log(`   Port: ${port}`);
    if (retryCount > 0) {
        console.log(`   Retry attempt: ${retryCount}/${maxRetries}`);
    }
    
    const lt = spawn('lt', ['--port', port.toString(), '--subdomain', deviceId], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
    });
    
    let tunnelUrl = null;
    let hasError = false;
    let errorMessage = '';
    let urlVerified = false;
    
    // Parse tunnel URL from output
    let outputBuffer = '';
    let urlUpdated = false;
    let startupTimeout;
    
    // Set timeout for startup - if no URL after 30 seconds, consider it failed
    startupTimeout = setTimeout(() => {
        if (!urlUpdated) {
            console.error('❌ Timeout waiting for tunnel URL');
            hasError = true;
            errorMessage = 'Timeout waiting for tunnel URL';
            if (lt && !lt.killed) {
                try {
                    process.kill(-lt.pid, 'SIGTERM');
                } catch (e) {
                    lt.kill('SIGTERM');
                }
            }
        }
    }, 30000);
    
    lt.stdout.on('data', (data) => {
        const output = data.toString();
        process.stdout.write(output);
        outputBuffer += output;
        
        // Look for the URL in the output - Localtunnel outputs "your url is: https://..."
        if (!urlUpdated) {
            const urlPatterns = [
                /your url is:\s*(https:\/\/[^\s]+)/i,
                /(https:\/\/[a-z0-9-]+\.loca\.lt)/i,
                /(https:\/\/[^\s]+loca\.lt[^\s]*)/i
            ];
            
            for (const pattern of urlPatterns) {
                const match = outputBuffer.match(pattern);
                if (match) {
                    const foundUrl = (match[1] || match[0]).trim();
                    if (foundUrl && foundUrl.includes('loca.lt') && foundUrl.startsWith('https://')) {
                        tunnelUrl = foundUrl;
                        clearTimeout(startupTimeout);
                        
                        // VERIFY URL MATCHES EXPECTED SUBDOMAIN
                        if (!verifyTunnelUrl(tunnelUrl, deviceId)) {
                            console.error(`\n❌ Tunnel started with wrong URL! Killing process...`);
                            hasError = true;
                            errorMessage = `Tunnel URL does not match expected subdomain: ${deviceId}`;
                            urlUpdated = true; // Set to true to prevent further processing
                            
                            // Kill the process immediately
                            setTimeout(() => {
                                if (lt && !lt.killed) {
                                    try {
                                        process.kill(-lt.pid, 'SIGTERM');
                                    } catch (e) {
                                        lt.kill('SIGTERM');
                                    }
                                    setTimeout(() => {
                                        if (lt && !lt.killed) {
                                            try {
                                                process.kill(-lt.pid, 'SIGKILL');
                                            } catch (e) {
                                                lt.kill('SIGKILL');
                                            }
                                        }
                                    }, 2000);
                                }
                            }, 500);
                            return;
                        }
                        
                        console.log(`\n✅ Tunnel URL detected and verified: ${tunnelUrl}`);
                        updateConfigWithTunnelUrl(tunnelUrl);
                        urlUpdated = true;
                        urlVerified = true;
                        break;
                    }
                }
            }
        }
    });
    
    lt.stderr.on('data', (data) => {
        const errorOutput = data.toString();
        process.stderr.write(errorOutput);
        errorMessage += errorOutput;
        
        // Check for common errors
        if (errorOutput.includes('subdomain') && errorOutput.includes('taken')) {
            hasError = true;
            errorMessage = 'Subdomain already taken';
        } else if (errorOutput.includes('ECONNREFUSED') || errorOutput.includes('connection refused')) {
            hasError = true;
            errorMessage = 'Connection refused - is streamzio running?';
        }
    });
    
    lt.on('close', (code) => {
        clearTimeout(startupTimeout);
        
        if (code !== 0 || hasError || !urlVerified) {
            console.error(`❌ Localtunnel exited with code ${code}`);
            if (errorMessage) {
                console.error(`   Error: ${errorMessage}`);
            }
            if (!urlVerified && urlUpdated) {
                console.error(`   URL verification failed - tunnel had wrong subdomain`);
            }
            
            // Retry if we haven't exceeded max retries
            if (retryCount < maxRetries) {
                // Exponential backoff: 2s, 5s, 10s
                const backoffDelay = Math.min(1000 * Math.pow(2, retryCount) + Math.random() * 1000, 10000);
                console.log(`\n🔄 Retrying in ${Math.round(backoffDelay/1000)} seconds...`);
                setTimeout(async () => {
                    await cleanupStaleProcesses(deviceId, port);
                    // Retry - lock is already held, don't acquire again
                    startTunnelInternal(deviceId, port, retryCount + 1, maxRetries);
                }, backoffDelay);
            } else {
                // Final failure - release lock
                releaseLock();
                console.error(`\n❌ Max retries (${maxRetries}) exceeded. Giving up.`);
                console.error(`   Please check:`);
                console.error(`   1. Is streamzio running on port ${port}?`);
                console.error(`   2. Is the subdomain ${deviceId} available?`);
                console.error(`   3. Are there stale localtunnel processes? Run: pkill -f "lt --port"`);
                console.error(`   4. Check logs: journalctl -u streamzio -f`);
                process.exit(1);
            }
        } else if (urlVerified) {
            console.log('✅ Tunnel started successfully with correct URL');
            // Keep lock until shutdown
        }
    });
    
    // Handle graceful shutdown
    const shutdown = (signal) => {
        console.log(`\n🛑 Received ${signal}, shutting down tunnel...`);
        clearTimeout(startupTimeout);
        releaseLock();
        
        if (lt && !lt.killed) {
            try {
                // Kill process group for clean shutdown
                process.kill(-lt.pid, 'SIGTERM');
            } catch (e) {
                lt.kill('SIGTERM');
            }
            
            // Give it time to shutdown gracefully
            const shutdownTimeout = setTimeout(() => {
                if (lt && !lt.killed) {
                    try {
                        process.kill(-lt.pid, 'SIGKILL');
                    } catch (e) {
                        lt.kill('SIGKILL');
                    }
                }
                process.exit(0);
            }, 5000);
            
            // If process exits before timeout, clear timeout
            lt.on('close', () => {
                clearTimeout(shutdownTimeout);
                process.exit(0);
            });
        } else {
            process.exit(0);
        }
    };
    
    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
        console.error('❌ Uncaught exception:', error);
        releaseLock();
        shutdown('UNCAUGHT_EXCEPTION');
    });
    
    process.on('unhandledRejection', (reason, promise) => {
        console.error('❌ Unhandled rejection:', reason);
        releaseLock();
        shutdown('UNHANDLED_REJECTION');
    });
    
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGHUP', () => shutdown('SIGHUP'));
}

// Start the tunnel
startTunnel();

