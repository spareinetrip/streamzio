# Streamzio

A Stremio addon that provides Flemish content from scnlog.me with Real-Debrid integration for high-quality streaming.

## Features

- 🔍 Automatic search for Flemish content on scnlog.me
- 🔗 MultiUp link extraction and hoster link resolution
- 🔓 Real-Debrid integration for premium streaming links
- 📺 Supports TV series with season/episode matching (SxxExx format)
- ⚡ Fast and efficient link resolution

## Prerequisites

- Node.js (v14 or higher)
- Real-Debrid account with API key ([Get API key here](https://real-debrid.com/apitoken))
- **Chrome or Chromium browser** installed on your system
  - macOS: Usually at `/Applications/Google Chrome.app` or `/Applications/Chromium.app`
  - Linux/Raspberry Pi: Install via `sudo apt-get install chromium-browser` or `sudo apt-get install chromium`
  - Windows: Chrome is usually auto-detected

## Installation

1. Clone or download this repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure Real-Debrid:
   - Edit `config.json` and add your Real-Debrid API key:
     ```json
     {
       "realdebrid": {
         "apiKey": "YOUR_API_KEY_HERE",
         "enabled": true
       },
       "server": {
         "port": 7004
       }
     }
     ```
   - Or set the environment variable:
     ```bash
     export REALDEBRID_API_KEY="YOUR_API_KEY_HERE"
     ```

## Usage

1. Start the server:
   ```bash
   npm start
   ```

2. Install the addon in Stremio:
   - Open Stremio
   - Go to Addons
   - Click "Add Addon"
   - Enter: `http://localhost:7004/manifest.json`

## How It Works

1. **Content Request**: Stremio requests content with IMDB ID, season, and episode
   - The addon handles IMDB IDs (e.g., `tt13802360:7:7`) and resolves titles via Cinemeta
2. **Search**: The addon searches scnlog.me for matching Flemish content (format: `Title.SxxExx.FLEMISH`)
3. **Link Extraction**: Extracts the MultiUp link from the scnlog.me page
4. **Cloudflare Bypass**: Uses Puppeteer with stealth plugin to bypass Cloudflare protection
   - First request: Visible browser (for manual Cloudflare challenge if needed)
   - Subsequent requests: Headless browser (faster, cookies reused automatically)
5. **Hoster Resolution**: Extracts individual hoster links from MultiUp mirror page
6. **Real-Debrid**: Adds hoster links to Real-Debrid and retrieves premium streaming URLs
7. **Stream Delivery**: Returns streaming URLs to Stremio with formatted titles showing quality, size, and scenegroup

## Performance Optimizations

- **Browser Reuse**: Browser instance is reused across all requests (faster startup)
- **Cookie Persistence**: Cloudflare cookies are saved and reused automatically
- **Headless Mode**: After first Cloudflare challenge, browser runs in headless mode (faster)
- **Raspberry Pi Optimized**: Includes optimizations for low-memory systems
- **Pre-start Browser**: Browser is pre-started on server launch for faster first request

## Configuration

### config.json

```json
{
  "realdebrid": {
    "apiKey": "your-api-key",
    "enabled": true
  },
  "server": {
    "port": 7004,
    "publicBaseUrl": ""
  }
}
```

### Environment Variables

- `REALDEBRID_API_KEY`: Your Real-Debrid API key
- `PORT`: Server port (default: 7004)
- `PUBLIC_BASE_URL`: Public base URL for network access

## Network Access

For network access (not just localhost), you need HTTPS. Options:

1. **Localtunnel** (recommended for testing):
   ```bash
   npm install -g localtunnel
   lt --port 7004
   ```
   Use the HTTPS URL provided in Stremio.

2. **Deploy to a hosting service** (Heroku, Railway, etc.)

## Systemd Service Setup (Raspberry Pi / Linux)

For automatic startup and tunnel management, you can set up systemd services:

### Step 1: Install Localtunnel

```bash
sudo npm install -g localtunnel
```

### Step 2: Copy Service Files

```bash
cd /opt/streamzio
sudo cp streamzio.service /etc/systemd/system/
sudo cp streamzio-tunnel.service /etc/systemd/system/
```

**Important:** Edit the service files to match your username:
```bash
sudo nano /etc/systemd/system/streamzio.service
sudo nano /etc/systemd/system/streamzio-tunnel.service
```

Change `User=YOUR_USERNAME` to your actual username (e.g., `User=pi` or `User=julien`).

### Step 3: Enable and Start Services

```bash
# Reload systemd to recognize new services
sudo systemctl daemon-reload

# Enable services to start on boot
sudo systemctl enable streamzio
sudo systemctl enable streamzio-tunnel

# Start the services now
sudo systemctl start streamzio
sudo systemctl start streamzio-tunnel
```

### Step 4: Check Service Status

```bash
# Check main service status
sudo systemctl status streamzio

# Check tunnel service status
sudo systemctl status streamzio-tunnel
```

**To view logs:**
```bash
# Main service logs
sudo journalctl -u streamzio -f

# Tunnel service logs (to see your tunnel URL)
sudo journalctl -u streamzio-tunnel -f

# Press Ctrl + C to exit log view
```

**To get your tunnel URL:**
```bash
sudo journalctl -u streamzio-tunnel -n 50 | grep "https://"
```

Or check your `config.json`:
```bash
cat /opt/streamzio/config.json | grep publicBaseUrl
```

The tunnel URL will be automatically saved to `config.json`. Your unique subdomain will be something like `streamzio-pi-abc123.loca.lt`.

**Note:** 
- The tunnel service automatically generates a fixed subdomain based on your device hostname and a unique hash, so the URL stays the same across restarts.
- The tunnel URL is automatically updated in `config.json` when the tunnel starts. You can find it there or in the tunnel service logs.
- For Raspberry Pi devices, the subdomain will use `pi` instead of the full hostname (e.g., `streamzio-pi-abc123` instead of `streamzio-raspberry-pi-abc123`).

## Raspberry Pi Setup

For Raspberry Pi, install Chromium:

**Debian Trixie (and newer):**
```bash
sudo apt-get update
sudo apt-get install chromium
```

**Older Debian/Raspbian versions:**
```bash
sudo apt-get update
sudo apt-get install chromium-browser
```

The addon will automatically detect Chromium at `/usr/bin/chromium`, `/usr/bin/chromium-browser`, or other common paths.

**Note**: On first run, you may need to manually complete the Cloudflare challenge once. After that, cookies are saved and the browser runs in headless mode automatically.

## Troubleshooting

### No streams found
- Verify the content exists on scnlog.me with the exact format: `Title.SxxExx.FLEMISH`
- Check that Real-Debrid is properly configured
- Check server logs for errors

### Real-Debrid errors
- Verify your API key is correct
- Check your Real-Debrid account status
- Ensure the hoster links are supported by Real-Debrid

### Browser not found
- Install Chromium/Chrome on your system
- Or set `CHROMIUM_PATH` or `CHROME_PATH` environment variable to the browser executable path

### Port already in use
- Change the port in `config.json`
- Or kill the process using the port: `kill -9 $(lsof -ti:7004)`

### Cloudflare challenge
- On first run, a browser window will open - complete the Cloudflare challenge manually
- After that, cookies are saved and subsequent requests use headless mode automatically

### Cloudflare challenge on headless server (Raspberry Pi with display)
If you see "Cloudflare challenge detected but no display available" but you have access to a display through a web portal:

1. **Find your DISPLAY value:**
   ```bash
   # Check current DISPLAY (if set)
   echo $DISPLAY
   
   # Check if running Wayland
   echo $XDG_SESSION_TYPE
   echo $WAYLAND_DISPLAY
   
   # Check for XWayland/X11 sockets (works without xdpyinfo)
   ls -la /tmp/.X11-unix/ 2>/dev/null || echo "No X11 sockets found"
   
   # Check if X11/XWayland is accessible (optional - requires xdpyinfo package)
   # sudo apt-get install x11-utils  # Install xdpyinfo if needed
   # xdpyinfo -display :0 2>&1 | head -1
   
   # Check if X11 is running (X11 systems)
   ps aux | grep -E "Xorg|Xwayland" | grep -v grep
   
   # Check for VNC displays
   ps aux | grep vnc | grep -v grep
   
   # Common values:
   # - X11 desktop environment: :0
   # - Wayland/XWayland: :0 (usually) - check /tmp/.X11-unix/X0
   # - VNC: :1, :2, etc.
   ```

2. **Update systemd service file:**
   ```bash
   sudo nano /etc/systemd/system/streamzio.service
   ```
   
   Uncomment and set the DISPLAY line:
   ```ini
   Environment=DISPLAY=:0
   ```
   (Replace `:0` with your actual display number if different. For Wayland systems, XWayland typically uses `:0`)

3. **Reload and restart:**
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl restart streamzio
   ```

4. **Verify it's working:**
   ```bash
   sudo journalctl -u streamzio -f
   ```
   
   You should see: `✅ Detected X11 display socket`, `✅ XWayland display :0 is accessible`, or `✅ X11 display :0 is accessible`

**Note:** 
- The code now automatically detects X11 and Wayland/XWayland displays, but setting DISPLAY explicitly in the systemd service is more reliable.
- For Wayland systems, XWayland provides X11 compatibility - Chromium will use XWayland to display windows.
- If automatic detection fails, manually set `DISPLAY=:0` in the systemd service file.

## Development

The addon uses:
- **stremio-addon-sdk**: Stremio addon framework
- **axios**: HTTP requests
- **cheerio**: HTML parsing
- **express**: HTTP server
- **puppeteer-extra**: Headless browser automation
- **puppeteer-extra-plugin-stealth**: Cloudflare bypass

## License

MIT

## Disclaimer

This addon is for educational purposes. Ensure you have the right to access the content you're streaming.

