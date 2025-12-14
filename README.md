# Streamzio - Flemish Content Stremio Addon

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

