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

// Cleanup stale localtunnel processes - PORT AND SUBDOMAIN SPECIFIC
// Kills processes on our port OR using our subdomain to avoid conflicts
function cleanupStaleProcesses(deviceId, port) {
    try {
        console.log(`🧹 Cleaning up stale localtunnel processes on port ${port} or subdomain ${deviceId}...`);
        
        const processesToKill = [];
        
        // Find localtunnel processes that use our specific port OR our subdomain
        try {
            // First, find all localtunnel processes
            const allLtPids = execSync(`pgrep -f "lt --port"`, { encoding: 'utf8' }).trim();
            if (allLtPids) {
                allLtPids.split('\n').forEach(pid => {
                    try {
                        const pidNum = parseInt(pid);
                        // Get command line to check port and subdomain
                        const cmdline = execSync(`ps -p ${pidNum} -o args=`, { encoding: 'utf8' }).trim();
                        
                        // Check if it's a localtunnel process
                        if (cmdline.includes('lt') && cmdline.includes('--port')) {
                            // Extract port from command line
                            const portMatch = cmdline.match(/--port\s+(\d+)/);
                            const processPort = portMatch ? parseInt(portMatch[1]) : null;
                            
                            // Extract subdomain from command line
                            const subdomainMatch = cmdline.match(/--subdomain\s+([^\s]+)/);
                            const processSubdomain = subdomainMatch ? subdomainMatch[1] : null;
                            
                            // Kill if it matches our port OR our subdomain
                            if (processPort === port) {
                                console.log(`   Found localtunnel process ${pidNum} on port ${port}`);
                                processesToKill.push(pidNum);
                            } else if (processSubdomain === deviceId) {
                                console.log(`   Found localtunnel process ${pidNum} using subdomain ${deviceId} (different port: ${processPort})`);
                                processesToKill.push(pidNum);
                            } else {
                                console.log(`   Skipping process ${pidNum}: port=${processPort}, subdomain=${processSubdomain} (different addon)`);
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
        
        // Wait for processes to die AND for subdomain to be released on localtunnel server
        // Localtunnel server may keep subdomain reserved for a few seconds after process dies
        return new Promise((resolve) => {
            // First wait for local processes to die
            setTimeout(() => {
                // Verify port is free
                let retries = 0;
                const checkPort = setInterval(() => {
                    try {
                        const portPids = execSync(`lsof -ti:${port}`, { encoding: 'utf8' }).trim();
                        if (!portPids || retries >= 10) {
                            clearInterval(checkPort);
                            // Additional wait for localtunnel server to release subdomain
                            // This is important: the server-side reservation may take 5-10 seconds to clear
                            console.log('   Waiting for subdomain to be released on localtunnel server...');
                            setTimeout(() => {
                                console.log('✅ Cleanup complete (subdomain should be free now)');
                                resolve();
                            }, 8000); // Wait 8 seconds for server-side cleanup
                        }
                        retries++;
                    } catch (e) {
                        // Port is free
                        clearInterval(checkPort);
                        console.log('   Waiting for subdomain to be released on localtunnel server...');
                        setTimeout(() => {
                            console.log('✅ Cleanup complete (subdomain should be free now)');
                            resolve();
                        }, 8000); // Wait 8 seconds for server-side cleanup
                    }
                }, 500);
            }, processesToKill.length > 0 ? 3000 : 1000); // Longer wait if we killed processes
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

// Check if subdomain is still active by testing the URL
async function checkSubdomainActive(deviceId) {
    try {
        const testUrl = `https://${deviceId}.loca.lt`;
        const https = require('https');
        
        return new Promise((resolve) => {
            const req = https.get(testUrl, { timeout: 3000 }, (res) => {
                // If we get a response, subdomain is still active
                resolve(true);
            });
            
            req.on('error', (err) => {
                // Error means subdomain is likely not active
                resolve(false);
            });
            
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });
            
            setTimeout(() => {
                req.destroy();
                resolve(false);
            }, 3000);
        });
    } catch (error) {
        // On error, assume subdomain is not active
        return false;
    }
}

// Check if tunnel URL is still accessible (health check)
async function checkTunnelHealth(tunnelUrl) {
    if (!tunnelUrl) {
        return false;
    }
    
    try {
        const https = require('https');
        
        return new Promise((resolve) => {
            // Try to access the manifest endpoint to verify tunnel is working
            const manifestUrl = `${tunnelUrl}/manifest.json`;
            const req = https.get(manifestUrl, { timeout: 5000 }, (res) => {
                // If we get a response (even error codes), tunnel is active
                resolve(res.statusCode < 500); // 5xx errors might indicate tunnel is down
            });
            
            req.on('error', (err) => {
                // Connection errors mean tunnel is likely down
                resolve(false);
            });
            
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });
            
            setTimeout(() => {
                req.destroy();
                resolve(false);
            }, 5000);
        });
    } catch (error) {
        return false;
    }
}

// Start periodic health check for tunnel connection
function startHealthCheck(tunnelUrl, deviceId, port, maxRetries, ltProcess) {
    // Clear any existing health check intervals
    if (globalHealthCheckInterval) {
        clearInterval(globalHealthCheckInterval);
        globalHealthCheckInterval = null;
    }
    if (globalKeepaliveInterval) {
        clearInterval(globalKeepaliveInterval);
        globalKeepaliveInterval = null;
    }
    
    // More frequent health check (every 2 minutes) to detect closures quickly
    const HEALTH_CHECK_INTERVAL = 2 * 60 * 1000; // 2 minutes
    
    // Keepalive ping (every 30 seconds) to prevent idle closures
    const KEEPALIVE_INTERVAL = 30 * 1000; // 30 seconds
    
    console.log(`💓 Starting tunnel health check (checking every ${HEALTH_CHECK_INTERVAL / 60000} minutes)...`);
    console.log(`💓 Starting tunnel keepalive (pinging every ${KEEPALIVE_INTERVAL / 1000} seconds to prevent idle closures)...`);
    
    let checkCount = 0;
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 2; // Restart after 2 consecutive failures
    
    // Keepalive ping to prevent tunnel from closing due to inactivity
    globalKeepaliveInterval = setInterval(async () => {
        try {
            const isHealthy = await checkTunnelHealth(tunnelUrl);
            if (!isHealthy) {
                consecutiveFailures++;
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    console.log(`⚠️  Keepalive failed ${consecutiveFailures} times - tunnel may be down`);
                    // Don't restart here, let the health check handle it
                }
            } else {
                consecutiveFailures = 0; // Reset on success
            }
        } catch (error) {
            consecutiveFailures++;
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                console.log(`⚠️  Keepalive error - tunnel may be down: ${error.message}`);
            }
        }
    }, KEEPALIVE_INTERVAL);
    
    // Health check with process monitoring
    globalHealthCheckInterval = setInterval(async () => {
        checkCount++;
        
        // Check if the tunnel process is still running
        let processAlive = false;
        try {
            if (ltProcess && ltProcess.pid) {
                process.kill(ltProcess.pid, 0); // Signal 0 checks if process exists
                processAlive = true;
            }
        } catch (e) {
            // Process is dead
            processAlive = false;
        }
        
        // Check if tunnel URL is still accessible
        const tunnelHealthy = await checkTunnelHealth(tunnelUrl);
        
        if (!processAlive || !tunnelHealthy || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            console.log(`⚠️  Tunnel health check failed! Process alive: ${processAlive}, URL accessible: ${tunnelHealthy}, Consecutive failures: ${consecutiveFailures}`);
            console.log(`🔄 Restarting tunnel proactively...`);
            
            // Clear health check and keepalive intervals
            if (globalHealthCheckInterval) {
                clearInterval(globalHealthCheckInterval);
                globalHealthCheckInterval = null;
            }
            if (globalKeepaliveInterval) {
                clearInterval(globalKeepaliveInterval);
                globalKeepaliveInterval = null;
            }
            
            // Reset consecutive failures
            consecutiveFailures = 0;
            
            // Kill the dead/unresponsive tunnel process if it's still running
            if (ltProcess && !ltProcess.killed && ltProcess.pid) {
                try {
                    console.log(`   Stopping unresponsive tunnel process...`);
                    try {
                        process.kill(-ltProcess.pid, 'SIGTERM');
                    } catch (e) {
                        ltProcess.kill('SIGTERM');
                    }
                    // Wait a bit for graceful shutdown
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    // Force kill if still running
                    try {
                        process.kill(-ltProcess.pid, 'SIGKILL');
                    } catch (e) {
                        ltProcess.kill('SIGKILL');
                    }
                } catch (e) {
                    // Process already dead, that's fine
                }
            }
            
            // Cleanup stale processes
            await cleanupStaleProcesses(deviceId, port);
            
            // Check if subdomain is still active
            console.log(`🔍 Checking if subdomain ${deviceId} is still active...`);
            const isActive = await checkSubdomainActive(deviceId);
            if (isActive) {
                console.log(`⚠️  Subdomain ${deviceId} is still active! Waiting for it to be released...`);
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
            
            // Restart tunnel
            startTunnelInternal(deviceId, port, 0, maxRetries);
        } else {
            // Tunnel is healthy, log periodically (every 15th check = 30 minutes)
            if (checkCount % 15 === 0) {
                console.log(`✅ Tunnel health check passed - tunnel is active and accessible`);
            }
        }
    }, HEALTH_CHECK_INTERVAL);
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
        
        // Check if subdomain is still active on the server
        console.log(`🔍 Checking if subdomain ${deviceId} is still active on localtunnel server...`);
        const isActive = await checkSubdomainActive(deviceId);
        if (isActive) {
            console.log(`⚠️  Subdomain ${deviceId} is still active! Waiting for it to be released...`);
            // Wait a bit longer if subdomain is still active
            await new Promise(resolve => setTimeout(resolve, 10000));
        } else {
            console.log(`✅ Subdomain ${deviceId} appears to be free`);
        }
    }
    
    startTunnelInternal(deviceId, port, retryCount, MAX_RETRIES);
}

// Global health check and keepalive interval trackers (one per tunnel instance)
let globalHealthCheckInterval = null;
let globalKeepaliveInterval = null;

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
    let isShuttingDown = false; // Track if we're shutting down gracefully
    let shutdownTimeout = null; // Track shutdown timeout
    
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
                            console.error(`\n❌ Tunnel started with wrong URL! Shutting down gracefully...`);
                            hasError = true;
                            errorMessage = `Tunnel URL does not match expected subdomain: ${deviceId}`;
                            urlUpdated = true; // Set to true to prevent further processing
                            
                            // Kill the process gracefully to allow server-side cleanup
                            if (lt && !lt.killed && lt.pid) {
                                console.log(`   Sending SIGTERM to tunnel process ${lt.pid} for graceful shutdown...`);
                                try {
                                    process.kill(-lt.pid, 'SIGTERM'); // Kill process group
                                } catch (e) {
                                    lt.kill('SIGTERM');
                                }
                                
                                // Wait for graceful shutdown, then force kill if needed
                                setTimeout(() => {
                                    if (lt && !lt.killed) {
                                        console.log(`   Force killing tunnel process...`);
                                        try {
                                            process.kill(-lt.pid, 'SIGKILL');
                                        } catch (e) {
                                            lt.kill('SIGKILL');
                                        }
                                    }
                                    // Wait for server-side cleanup before retry
                                    console.log(`   Waiting for subdomain to be released on server...`);
                                }, 8000); // Give time for graceful shutdown
                            }
                            return;
                        }
                        
                        console.log(`\n✅ Tunnel URL detected and verified: ${tunnelUrl}`);
                        updateConfigWithTunnelUrl(tunnelUrl);
                        urlUpdated = true;
                        urlVerified = true;
                        
                        // Start periodic health check to detect inactivity/disconnections
                        startHealthCheck(tunnelUrl, deviceId, port, maxRetries, lt);
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
        
        // Clear health check and keepalive intervals when tunnel closes
        if (globalHealthCheckInterval) {
            clearInterval(globalHealthCheckInterval);
            globalHealthCheckInterval = null;
        }
        if (globalKeepaliveInterval) {
            clearInterval(globalKeepaliveInterval);
            globalKeepaliveInterval = null;
        }
        
        // Don't retry if we're shutting down gracefully
        if (isShuttingDown) {
            releaseLock();
            return;
        }
        
        // If tunnel closed unexpectedly after successful startup, restart it automatically
        if (urlVerified && code === 0 && !hasError) {
            console.log(`⚠️  Tunnel closed unexpectedly (code ${code}) after successful startup. Restarting...`);
            // Reset state for restart
            urlVerified = false;
            urlUpdated = false;
            tunnelUrl = null;
            hasError = false;
            errorMessage = '';
            
            // Restart tunnel with exponential backoff (but don't count against max retries)
            const restartDelay = 5000 + Math.random() * 2000; // 5-7 seconds
            console.log(`🔄 Restarting tunnel in ${Math.round(restartDelay/1000)} seconds...`);
            
            setTimeout(async () => {
                // Cleanup any stale processes before restart
                await cleanupStaleProcesses(deviceId, port);
                
                // Check if subdomain is still active
                console.log(`🔍 Checking if subdomain ${deviceId} is still active...`);
                const isActive = await checkSubdomainActive(deviceId);
                if (isActive) {
                    console.log(`⚠️  Subdomain ${deviceId} is still active! Waiting for it to be released...`);
                    await new Promise(resolve => setTimeout(resolve, 10000));
                }
                
                // Restart tunnel (reset retry count for unexpected closes)
                startTunnelInternal(deviceId, port, 0, maxRetries);
            }, restartDelay);
            return;
        }
        
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
                // Exponential backoff: 5s, 10s, 15s (longer to allow subdomain to be released)
                const baseDelay = 5000; // Start with 5 seconds
                const backoffDelay = baseDelay * (retryCount + 1) + Math.random() * 2000;
                
                // If URL verification failed, add extra wait time for server-side cleanup
                const extraWaitTime = (!urlVerified && urlUpdated) ? 10000 : 0;
                const totalDelay = backoffDelay + extraWaitTime;
                
                if (extraWaitTime > 0) {
                    console.log(`\n🔄 Retrying in ${Math.round(totalDelay/1000)} seconds (${Math.round(backoffDelay/1000)}s backoff + ${Math.round(extraWaitTime/1000)}s for subdomain release)...`);
                } else {
                    console.log(`\n🔄 Retrying in ${Math.round(backoffDelay/1000)} seconds (allowing time for subdomain release)...`);
                }
                
                setTimeout(async () => {
                    // Always cleanup stale processes before retry
                    await cleanupStaleProcesses(deviceId, port);
                    
                    // If URL verification failed, also check if subdomain is still active
                    if (!urlVerified && urlUpdated) {
                        console.log(`🔍 Checking if subdomain ${deviceId} is still active after cleanup...`);
                        const isActive = await checkSubdomainActive(deviceId);
                        if (isActive) {
                            console.log(`⚠️  Subdomain ${deviceId} is still active! Waiting additional 10 seconds...`);
                            await new Promise(resolve => setTimeout(resolve, 10000));
                        }
                    }
                    
                    // Retry - lock is already held, don't acquire again
                    startTunnelInternal(deviceId, port, retryCount + 1, maxRetries);
                }, totalDelay);
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
        }
        // Note: The else-if branch for urlVerified was removed because it's logically unreachable:
        // - First if handles: urlVerified && code === 0 && !hasError (restarts)
        // - Second if handles: code !== 0 || hasError || !urlVerified (errors/retries)
        // There's no case where urlVerified is true but the first condition didn't match
    });
    
    // Handle graceful shutdown
    const shutdown = (signal) => {
        console.log(`\n🛑 Received ${signal}, shutting down tunnel...`);
        isShuttingDown = true; // Mark that we're shutting down
        clearTimeout(startupTimeout);
        
        // Clear health check and keepalive intervals
        if (globalHealthCheckInterval) {
            clearInterval(globalHealthCheckInterval);
            globalHealthCheckInterval = null;
        }
        if (globalKeepaliveInterval) {
            clearInterval(globalKeepaliveInterval);
            globalKeepaliveInterval = null;
        }
        
        // Set up close handler BEFORE killing (in case process exits quickly)
        let shutdownComplete = false;
        const completeShutdown = () => {
            if (!shutdownComplete) {
                shutdownComplete = true;
                releaseLock();
                process.exit(0);
            }
        };
        
        // Listen for process exit
        if (lt) {
            lt.once('close', () => {
                console.log('   Tunnel process closed');
                completeShutdown();
            });
        }
        
        if (lt && !lt.killed && lt.pid) {
            try {
                // Send SIGTERM to allow graceful shutdown
                // This gives localtunnel time to notify the server and release the subdomain
                console.log(`   Sending SIGTERM to tunnel process ${lt.pid}...`);
                try {
                    process.kill(-lt.pid, 'SIGTERM'); // Kill process group
                } catch (e) {
                    lt.kill('SIGTERM');
                }
                
                // Give it more time to shutdown gracefully and release subdomain on server
                const shutdownTimeout = setTimeout(() => {
                    if (lt && !lt.killed) {
                        console.log(`   Force killing tunnel process...`);
                        try {
                            process.kill(-lt.pid, 'SIGKILL');
                        } catch (e) {
                            lt.kill('SIGKILL');
                        }
                    }
                    // Wait a bit more for server-side cleanup
                    setTimeout(() => {
                        completeShutdown();
                    }, 2000);
                }, 8000); // Increased from 5s to 8s for better server-side cleanup
            } catch (e) {
                console.error(`   Error during shutdown: ${e.message}`);
                completeShutdown();
            }
        } else {
            // Process already dead or never started
            completeShutdown();
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

