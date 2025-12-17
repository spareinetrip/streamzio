#!/bin/bash
# Wrapper script that starts both streamzio and tunnel
# This script manages both processes and ensures proper startup order

set -e

WORKING_DIR="/opt/streamzio"
CONFIG_FILE="${WORKING_DIR}/config.json"
PORT=8004

# Get port from config if available
if [ -f "$CONFIG_FILE" ]; then
    CONFIG_PORT=$(grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]*' "$CONFIG_FILE" | grep -o '[0-9]*' | head -1 || echo "")
    if [ -n "$CONFIG_PORT" ]; then
        PORT=$CONFIG_PORT
    fi
fi

# Store PIDs
STREAMZIO_PID=""
TUNNEL_PID=""

# Cleanup function
cleanup() {
    echo "🛑 Shutting down streamzio..."
    
    # Kill tunnel first
    if [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
        echo "   Stopping tunnel (PID: $TUNNEL_PID)..."
        kill -TERM "$TUNNEL_PID" 2>/dev/null || true
        sleep 2
        if kill -0 "$TUNNEL_PID" 2>/dev/null; then
            kill -KILL "$TUNNEL_PID" 2>/dev/null || true
        fi
    fi
    
    # Kill localtunnel processes on our specific port OR subdomain as backup
    # This ensures we clean up even if PID tracking fails
    if [ -n "$PORT" ]; then
        # Get device ID from file if it exists
        DEVICE_ID_FILE="${WORKING_DIR}/.device-id"
        DEVICE_ID=""
        if [ -f "$DEVICE_ID_FILE" ]; then
            DEVICE_ID=$(cat "$DEVICE_ID_FILE" 2>/dev/null || echo "")
        fi
        
        # Find localtunnel processes using our port OR subdomain
        pgrep -f "lt --port" | while read pid; do
            cmdline=$(ps -p "$pid" -o args= 2>/dev/null || echo "")
            if [ -n "$cmdline" ]; then
                # Check if it uses our port
                if echo "$cmdline" | grep -q "lt.*--port.*${PORT}"; then
                    echo "   Stopping localtunnel process ${pid} on port ${PORT}..."
                    kill -TERM "$pid" 2>/dev/null || true
                # Check if it uses our subdomain (if we have one)
                elif [ -n "$DEVICE_ID" ] && echo "$cmdline" | grep -q "lt.*--subdomain.*${DEVICE_ID}"; then
                    echo "   Stopping localtunnel process ${pid} using subdomain ${DEVICE_ID}..."
                    kill -TERM "$pid" 2>/dev/null || true
                fi
            fi
        done
        sleep 2  # Give processes time to shutdown gracefully
        # Force kill any remaining
        pgrep -f "lt --port" | while read pid; do
            cmdline=$(ps -p "$pid" -o args= 2>/dev/null || echo "")
            if [ -n "$cmdline" ]; then
                if echo "$cmdline" | grep -q "lt.*--port.*${PORT}"; then
                    kill -KILL "$pid" 2>/dev/null || true
                elif [ -n "$DEVICE_ID" ] && echo "$cmdline" | grep -q "lt.*--subdomain.*${DEVICE_ID}"; then
                    kill -KILL "$pid" 2>/dev/null || true
                fi
            fi
        done
    fi
    
    # Kill streamzio
    if [ -n "$STREAMZIO_PID" ] && kill -0 "$STREAMZIO_PID" 2>/dev/null; then
        echo "   Stopping streamzio (PID: $STREAMZIO_PID)..."
        kill -TERM "$STREAMZIO_PID" 2>/dev/null || true
        sleep 2
        if kill -0 "$STREAMZIO_PID" 2>/dev/null; then
            kill -KILL "$STREAMZIO_PID" 2>/dev/null || true
        fi
    fi
    
    exit 0
}

# Set up signal handlers
trap cleanup SIGTERM SIGINT SIGHUP EXIT

# Change to working directory
cd "$WORKING_DIR" || exit 1

# Start streamzio
echo "🚀 Starting streamzio server..."
npm start &
STREAMZIO_PID=$!

echo "   Streamzio started with PID: $STREAMZIO_PID"
echo "⏳ Waiting for streamzio to be ready on port $PORT..."

# Wait for streamzio to be ready
MAX_RETRIES=30
RETRY_COUNT=0
RETRY_DELAY=2

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    # Check if process is still running
    if ! kill -0 "$STREAMZIO_PID" 2>/dev/null; then
        echo "❌ Streamzio process died!"
        wait "$STREAMZIO_PID" || true
        exit 1
    fi
    
    # Check if port is listening
    if lsof -ti:$PORT >/dev/null 2>&1; then
        # Try to connect and get HTTP response
        if curl -s -f -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/manifest.json" 2>/dev/null; then
            echo "✅ Streamzio is ready on port $PORT"
            break
        fi
    fi
    
    RETRY_COUNT=$((RETRY_COUNT + 1))
    if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
        sleep $RETRY_DELAY
    fi
done

if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
    echo "❌ Streamzio did not become ready after $MAX_RETRIES attempts"
    cleanup
    exit 1
fi

# Start tunnel
echo "🚀 Starting localtunnel..."
node start-tunnel.js &
TUNNEL_PID=$!

echo "   Tunnel started with PID: $TUNNEL_PID"
echo "✅ Both services started successfully"

# Wait for both processes - if either dies, exit
wait -n "$STREAMZIO_PID" "$TUNNEL_PID" || {
    EXIT_CODE=$?
    echo "❌ One of the processes exited with code $EXIT_CODE"
    cleanup
    exit $EXIT_CODE
}

