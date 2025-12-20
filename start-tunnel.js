#!/usr/bin/env node

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadConfig, saveConfig } = require('./config');

const DEVICE_ID_FILE = path.join(__dirname, '.device-id');
const LOCK_FILE = path.join(__dirname, '.tunnel.lock');
const DEFAULT_PORT = 8004;
const MAX_RETRIES = 3;
const HEALTH_CHECK_INTERVAL = 10 * 60 * 1000; // 10 minutes
const STARTUP_TIMEOUT = 30000; // 30 seconds
const GRACEFUL_SHUTDOWN_TIMEOUT = 8000; // 8 seconds
const SUBDOMAIN_RELEASE_WAIT = 8000; // 8 seconds

// Logging helper
const logger = {
    info: (msg) => console.log(`[TUNNEL] ${msg}`),
    warn: (msg) => console.log(`[TUNNEL] WARN: ${msg}`),
    error: (msg) => console.error(`[TUNNEL] ERROR: ${msg}`),
    debug: (msg) => console.log(`[TUNNEL] DEBUG: ${msg}`)
};

// Global health check interval tracker
let globalHealthCheckInterval = null;

// Acquire lock to prevent concurrent tunnel starts
function acquireLock() {
    try {
        const fd = fs.openSync(LOCK_FILE, 'wx');
        fs.writeSync(fd, process.pid.toString());
        fs.closeSync(fd);
        return true;
    } catch (error) {
        if (error.code === 'EEXIST') {
            try {
                const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim());
                try {
                    process.kill(pid, 0);
                    logger.warn(`Lock file exists, process ${pid} is still running`);
                    return false;
                } catch (e) {
                    logger.debug('Removing stale lock file');
                    fs.unlinkSync(LOCK_FILE);
                    return acquireLock();
                }
            } catch (e) {
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

// Cleanup stale localtunnel processes
function cleanupStaleProcesses(deviceId, port) {
    try {
        logger.debug(`Cleaning up stale localtunnel processes on port ${port} or subdomain ${deviceId}`);
        
        const processesToKill = [];
        
        try {
            const allLtPids = execSync(`pgrep -f "lt --port"`, { encoding: 'utf8' }).trim();
            if (allLtPids) {
                allLtPids.split('\n').forEach(pid => {
                    try {
                        const pidNum = parseInt(pid);
                        const cmdline = execSync(`ps -p ${pidNum} -o args=`, { encoding: 'utf8' }).trim();
                        
                        if (cmdline.includes('lt') && cmdline.includes('--port')) {
                            const portMatch = cmdline.match(/--port\s+(\d+)/);
                            const processPort = portMatch ? parseInt(portMatch[1]) : null;
                            
                            const subdomainMatch = cmdline.match(/--subdomain\s+([^\s]+)/);
                            const processSubdomain = subdomainMatch ? subdomainMatch[1] : null;
                            
                            if (processPort === port) {
                                logger.debug(`Found localtunnel process ${pidNum} on port ${port}`);
                                processesToKill.push(pidNum);
                            } else if (processSubdomain === deviceId) {
                                logger.debug(`Found localtunnel process ${pidNum} using subdomain ${deviceId} (different port: ${processPort})`);
                                processesToKill.push(pidNum);
                            }
                        }
                    } catch (e) {
                        // Process might be gone
                    }
                });
            }
        } catch (e) {
            // No processes found
        }
        
        try {
            const portPids = execSync(`lsof -ti:${port}`, { encoding: 'utf8' }).trim();
            if (portPids) {
                portPids.split('\n').forEach(pid => {
                    try {
                        const pidNum = parseInt(pid);
                        if (!processesToKill.includes(pidNum)) {
                            const cmdline = execSync(`ps -p ${pidNum} -o args=`, { encoding: 'utf8' }).trim();
                            if (cmdline.includes('lt') && cmdline.includes('--port')) {
                                const portMatch = cmdline.match(/--port\s+(\d+)/);
                                const processPort = portMatch ? parseInt(portMatch[1]) : null;
                                
                                if (processPort === port) {
                                    logger.debug(`Found localtunnel process ${pidNum} on port ${port}`);
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
            // No processes on port
        }
        
        if (processesToKill.length > 0) {
            logger.info(`Killing ${processesToKill.length} localtunnel process(es) on port ${port}`);
            processesToKill.forEach(pidNum => {
                try {
                    try {
                        process.kill(-pidNum, 'SIGTERM');
                    } catch (e) {
                        process.kill(pidNum, 'SIGTERM');
                    }
                } catch (e) {
                    // Process might already be gone
                }
            });
            
            let waitCount = 0;
            const checkInterval = setInterval(() => {
                waitCount++;
                const stillRunning = processesToKill.filter(pidNum => {
                    try {
                        process.kill(pidNum, 0);
                        return true;
                    } catch (e) {
                        return false;
                    }
                });
                
                if (stillRunning.length === 0 || waitCount >= 5) {
                    clearInterval(checkInterval);
                    stillRunning.forEach(pidNum => {
                        try {
                            try {
                                process.kill(-pidNum, 'SIGKILL');
                            } catch (e) {
                                process.kill(pidNum, 'SIGKILL');
                            }
                        } catch (e) {
                            // Process already gone
                        }
                    });
                }
            }, 1000);
        } else {
            logger.debug(`No localtunnel processes found on port ${port}`);
        }
        
        return new Promise((resolve) => {
            setTimeout(() => {
                let retries = 0;
                const checkPort = setInterval(() => {
                    try {
                        const portPids = execSync(`lsof -ti:${port}`, { encoding: 'utf8' }).trim();
                        if (!portPids || retries >= 10) {
                            clearInterval(checkPort);
                            logger.debug('Waiting for subdomain to be released on localtunnel server');
                            setTimeout(() => {
                                logger.debug('Cleanup complete (subdomain should be free now)');
                                resolve();
                            }, SUBDOMAIN_RELEASE_WAIT);
                        }
                        retries++;
                    } catch (e) {
                        clearInterval(checkPort);
                        logger.debug('Waiting for subdomain to be released on localtunnel server');
                        setTimeout(() => {
                            logger.debug('Cleanup complete (subdomain should be free now)');
                            resolve();
                        }, SUBDOMAIN_RELEASE_WAIT);
                    }
                }, 500);
            }, processesToKill.length > 0 ? 3000 : 1000);
        });
    } catch (error) {
        logger.warn(`Cleanup error (non-fatal): ${error.message}`);
        return Promise.resolve();
    }
}

// Get or generate device ID
function getDeviceId() {
    if (fs.existsSync(DEVICE_ID_FILE)) {
        return fs.readFileSync(DEVICE_ID_FILE, 'utf8').trim();
    }
    
    const os = require('os');
    let hostname = os.hostname().toLowerCase();
    
    if (hostname.includes('raspberry') || hostname.includes('pi')) {
        hostname = 'pi';
    } else {
        hostname = hostname.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    }
    
    const randomHash = crypto.randomBytes(4).toString('hex');
    const deviceId = `${hostname}-${randomHash}`;
    const cleanDeviceId = deviceId.replace(/^streamzio-/, '');
    const fullDeviceId = `streamzio-${cleanDeviceId}`;
    
    fs.writeFileSync(DEVICE_ID_FILE, fullDeviceId);
    return fullDeviceId;
}

// Update config.json with tunnel URL
function updateConfigWithTunnelUrl(tunnelUrl) {
    try {
        const config = loadConfig();
        config.server.publicBaseUrl = tunnelUrl;
        saveConfig(config);
        logger.info(`Updated config.json with tunnel URL: ${tunnelUrl}`);
    } catch (error) {
        logger.error(`Error updating config: ${error.message}`);
    }
}

// Verify tunnel URL matches expected subdomain
function verifyTunnelUrl(tunnelUrl, expectedDeviceId) {
    if (!tunnelUrl || !expectedDeviceId) {
        return false;
    }
    
    const urlMatch = tunnelUrl.match(/https:\/\/([^.]+)\.loca\.lt/);
    if (!urlMatch) {
        return false;
    }
    
    const actualSubdomain = urlMatch[1];
    
    if (actualSubdomain === expectedDeviceId) {
        return true;
    }
    
    if (actualSubdomain.includes(expectedDeviceId) || expectedDeviceId.includes(actualSubdomain)) {
        return true;
    }
    
    logger.error(`URL verification failed! Expected: ${expectedDeviceId}, Actual: ${actualSubdomain}`);
    return false;
}

// Check if subdomain is still active
async function checkSubdomainActive(deviceId) {
    try {
        const testUrl = `https://${deviceId}.loca.lt`;
        const https = require('https');
        
        return new Promise((resolve) => {
            const req = https.get(testUrl, { timeout: 3000 }, (res) => {
                resolve(true);
            });
            
            req.on('error', () => {
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
        return false;
    }
}

// Check if tunnel URL is still accessible
async function checkTunnelHealth(tunnelUrl) {
    if (!tunnelUrl) {
        return false;
    }
    
    try {
        const https = require('https');
        
        return new Promise((resolve) => {
            const manifestUrl = `${tunnelUrl}/manifest.json`;
            const req = https.get(manifestUrl, { timeout: 5000 }, (res) => {
                resolve(res.statusCode < 500);
            });
            
            req.on('error', () => {
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

// Start periodic health check
function startHealthCheck(tunnelUrl, deviceId, port, maxRetries, ltProcess) {
    if (globalHealthCheckInterval) {
        clearInterval(globalHealthCheckInterval);
        globalHealthCheckInterval = null;
    }
    
    logger.info(`Starting tunnel health check (checking every ${HEALTH_CHECK_INTERVAL / 60000} minutes)`);
    
    let checkCount = 0;
    globalHealthCheckInterval = setInterval(async () => {
        checkCount++;
        
        let processAlive = false;
        try {
            if (ltProcess && ltProcess.pid) {
                process.kill(ltProcess.pid, 0);
                processAlive = true;
            }
        } catch (e) {
            processAlive = false;
        }
        
        const tunnelHealthy = await checkTunnelHealth(tunnelUrl);
        
        if (!processAlive || !tunnelHealthy) {
            logger.warn(`Tunnel health check failed! Process alive: ${processAlive}, URL accessible: ${tunnelHealthy}`);
            logger.info('Restarting tunnel proactively');
            
            if (globalHealthCheckInterval) {
                clearInterval(globalHealthCheckInterval);
                globalHealthCheckInterval = null;
            }
            
            if (ltProcess && !ltProcess.killed && ltProcess.pid) {
                try {
                    logger.debug('Stopping unresponsive tunnel process');
                    try {
                        process.kill(-ltProcess.pid, 'SIGTERM');
                    } catch (e) {
                        ltProcess.kill('SIGTERM');
                    }
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    try {
                        process.kill(-ltProcess.pid, 'SIGKILL');
                    } catch (e) {
                        ltProcess.kill('SIGKILL');
                    }
                } catch (e) {
                    // Process already dead
                }
            }
            
            await cleanupStaleProcesses(deviceId, port);
            
            logger.debug(`Checking if subdomain ${deviceId} is still active`);
            const isActive = await checkSubdomainActive(deviceId);
            if (isActive) {
                logger.warn(`Subdomain ${deviceId} is still active! Waiting for it to be released`);
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
            
            startTunnelInternal(deviceId, port, 0, maxRetries);
        } else {
            if (checkCount % 6 === 0) {
                logger.debug('Tunnel health check passed - tunnel is active and accessible');
            }
        }
    }, HEALTH_CHECK_INTERVAL);
}

// Start Localtunnel with retry logic
async function startTunnel(retryCount = 0) {
    const deviceId = getDeviceId();
    
    const config = loadConfig();
    const port = config.server.port || DEFAULT_PORT;
    
    if (retryCount === 0) {
        if (!acquireLock()) {
            logger.error('Could not acquire lock. Another tunnel instance may be starting.');
            process.exit(1);
        }
        
        await cleanupStaleProcesses(deviceId, port);
        
        logger.debug(`Checking if subdomain ${deviceId} is still active on localtunnel server`);
        const isActive = await checkSubdomainActive(deviceId);
        if (isActive) {
            logger.warn(`Subdomain ${deviceId} is still active! Waiting for it to be released`);
            await new Promise(resolve => setTimeout(resolve, 10000));
        } else {
            logger.debug(`Subdomain ${deviceId} appears to be free`);
        }
    }
    
    startTunnelInternal(deviceId, port, retryCount, MAX_RETRIES);
}

// Internal tunnel start function
function startTunnelInternal(deviceId, port, retryCount, maxRetries) {
    logger.info(`Starting Localtunnel with subdomain: ${deviceId}, port: ${port}`);
    if (retryCount > 0) {
        logger.info(`Retry attempt: ${retryCount}/${maxRetries}`);
    }
    
    const lt = spawn('lt', ['--port', port.toString(), '--subdomain', deviceId], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
    });
    
    let tunnelUrl = null;
    let hasError = false;
    let errorMessage = '';
    let urlVerified = false;
    let isShuttingDown = false;
    
    let outputBuffer = '';
    let urlUpdated = false;
    let startupTimeout;
    
    startupTimeout = setTimeout(() => {
        if (!urlUpdated) {
            logger.error('Timeout waiting for tunnel URL');
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
    }, STARTUP_TIMEOUT);
    
    lt.stdout.on('data', (data) => {
        const output = data.toString();
        process.stdout.write(output);
        outputBuffer += output;
        
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
                        
                        if (!verifyTunnelUrl(tunnelUrl, deviceId)) {
                            logger.error('Tunnel started with wrong URL! Shutting down gracefully');
                            hasError = true;
                            errorMessage = `Tunnel URL does not match expected subdomain: ${deviceId}`;
                            urlUpdated = true;
                            
                            if (lt && !lt.killed && lt.pid) {
                                logger.debug(`Sending SIGTERM to tunnel process ${lt.pid} for graceful shutdown`);
                                try {
                                    process.kill(-lt.pid, 'SIGTERM');
                                } catch (e) {
                                    lt.kill('SIGTERM');
                                }
                                
                                setTimeout(() => {
                                    if (lt && !lt.killed) {
                                        logger.debug('Force killing tunnel process');
                                        try {
                                            process.kill(-lt.pid, 'SIGKILL');
                                        } catch (e) {
                                            lt.kill('SIGKILL');
                                        }
                                    }
                                    logger.debug('Waiting for subdomain to be released on server');
                                }, GRACEFUL_SHUTDOWN_TIMEOUT);
                            }
                            return;
                        }
                        
                        logger.info(`Tunnel URL detected and verified: ${tunnelUrl}`);
                        updateConfigWithTunnelUrl(tunnelUrl);
                        urlUpdated = true;
                        urlVerified = true;
                        
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
        
        if (globalHealthCheckInterval) {
            clearInterval(globalHealthCheckInterval);
            globalHealthCheckInterval = null;
        }
        
        if (isShuttingDown) {
            releaseLock();
            return;
        }
        
        if (urlVerified && code === 0 && !hasError) {
            logger.warn(`Tunnel closed unexpectedly (code ${code}) after successful startup. Restarting`);
            urlVerified = false;
            urlUpdated = false;
            tunnelUrl = null;
            hasError = false;
            errorMessage = '';
            
            const restartDelay = 5000 + Math.random() * 2000;
            logger.info(`Restarting tunnel in ${Math.round(restartDelay/1000)} seconds`);
            
            setTimeout(async () => {
                await cleanupStaleProcesses(deviceId, port);
                
                logger.debug(`Checking if subdomain ${deviceId} is still active`);
                const isActive = await checkSubdomainActive(deviceId);
                if (isActive) {
                    logger.warn(`Subdomain ${deviceId} is still active! Waiting for it to be released`);
                    await new Promise(resolve => setTimeout(resolve, 10000));
                }
                
                startTunnelInternal(deviceId, port, 0, maxRetries);
            }, restartDelay);
            return;
        }
        
        if (code !== 0 || hasError || !urlVerified) {
            logger.error(`Localtunnel exited with code ${code}`);
            if (errorMessage) {
                logger.error(`Error: ${errorMessage}`);
            }
            if (!urlVerified && urlUpdated) {
                logger.error('URL verification failed - tunnel had wrong subdomain');
            }
            
            if (retryCount < maxRetries) {
                const baseDelay = 5000;
                const backoffDelay = baseDelay * (retryCount + 1) + Math.random() * 2000;
                const extraWaitTime = (!urlVerified && urlUpdated) ? 10000 : 0;
                const totalDelay = backoffDelay + extraWaitTime;
                
                if (extraWaitTime > 0) {
                    logger.info(`Retrying in ${Math.round(totalDelay/1000)} seconds (${Math.round(backoffDelay/1000)}s backoff + ${Math.round(extraWaitTime/1000)}s for subdomain release)`);
                } else {
                    logger.info(`Retrying in ${Math.round(backoffDelay/1000)} seconds`);
                }
                
                setTimeout(async () => {
                    await cleanupStaleProcesses(deviceId, port);
                    
                    if (!urlVerified && urlUpdated) {
                        logger.debug(`Checking if subdomain ${deviceId} is still active after cleanup`);
                        const isActive = await checkSubdomainActive(deviceId);
                        if (isActive) {
                            logger.warn(`Subdomain ${deviceId} is still active! Waiting additional 10 seconds`);
                            await new Promise(resolve => setTimeout(resolve, 10000));
                        }
                    }
                    
                    startTunnelInternal(deviceId, port, retryCount + 1, maxRetries);
                }, totalDelay);
            } else {
                releaseLock();
                logger.error(`Max retries (${maxRetries}) exceeded. Giving up.`);
                logger.error('Please check:');
                logger.error(`  1. Is streamzio running on port ${port}?`);
                logger.error(`  2. Is the subdomain ${deviceId} available?`);
                logger.error('  3. Are there stale localtunnel processes? Run: pkill -f "lt --port"');
                logger.error('  4. Check logs: journalctl -u streamzio -f');
                process.exit(1);
            }
        }
    });
    
    // Handle graceful shutdown
    const shutdown = (signal) => {
        logger.info(`Received ${signal}, shutting down tunnel`);
        isShuttingDown = true;
        clearTimeout(startupTimeout);
        
        if (globalHealthCheckInterval) {
            clearInterval(globalHealthCheckInterval);
            globalHealthCheckInterval = null;
        }
        
        let shutdownComplete = false;
        const completeShutdown = () => {
            if (!shutdownComplete) {
                shutdownComplete = true;
                releaseLock();
                process.exit(0);
            }
        };
        
        if (lt) {
            lt.once('close', () => {
                logger.debug('Tunnel process closed');
                completeShutdown();
            });
        }
        
        if (lt && !lt.killed && lt.pid) {
            try {
                logger.debug(`Sending SIGTERM to tunnel process ${lt.pid}`);
                try {
                    process.kill(-lt.pid, 'SIGTERM');
                } catch (e) {
                    lt.kill('SIGTERM');
                }
                
                const shutdownTimeout = setTimeout(() => {
                    if (lt && !lt.killed) {
                        logger.debug('Force killing tunnel process');
                        try {
                            process.kill(-lt.pid, 'SIGKILL');
                        } catch (e) {
                            lt.kill('SIGKILL');
                        }
                    }
                    setTimeout(() => {
                        completeShutdown();
                    }, 2000);
                }, GRACEFUL_SHUTDOWN_TIMEOUT);
            } catch (e) {
                logger.error(`Error during shutdown: ${e.message}`);
                completeShutdown();
            }
        } else {
            completeShutdown();
        }
    };
    
    process.on('uncaughtException', (error) => {
        logger.error(`Uncaught exception: ${error.message}`);
        releaseLock();
        shutdown('UNCAUGHT_EXCEPTION');
    });
    
    process.on('unhandledRejection', (reason, promise) => {
        logger.error(`Unhandled rejection: ${reason}`);
        releaseLock();
        shutdown('UNHANDLED_REJECTION');
    });
    
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGHUP', () => shutdown('SIGHUP'));
}

// Start the tunnel
startTunnel();
