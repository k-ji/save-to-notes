# Save to Notes

A Chrome extension that saves any web page as HTML, Markdown, or PDF with all images preserved. One click to capture articles, blog posts, research — complete with images, ready for offline reading or AI processing.

## Features

- **One-click capture** — click the extension icon or use the popup
- **Multiple formats** — save as HTML (self-contained), Markdown (with image folder), or PDF
- **Full image extraction** — downloads and embeds all images as base64 (including lazy-loaded, srcset, CSS backgrounds, Next.js proxied images)
- **Smart content selection** — automatically finds the article content (tries `article`, `.post-content`, `[role=main]`, `main`, then falls back to `body`)
- **Configurable server** — set your own backend URL in the popup

## Setup

### 1. Install the Chrome Extension

1. Clone or download this repo
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** → select this folder
5. Pin the extension to your toolbar

### 2. Start the Backend Server

A minimal example server is included:

```bash
cd server-example
python server.py
```

Options:
```
--port 8765              Server port (default: 8765)
--output-dir ./articles  Where to save files (default: ./saved-articles)
```

Optional dependencies (install as needed):
```bash
pip install requests      # Better image downloading
pip install markdownify   # Markdown format support
pip install weasyprint    # PDF format support
```

### 3. Configure (Optional)

Click the extension icon to open the popup. You can configure:
- **Server URL** — default is `http://localhost:8765`
- **Save Format** — HTML, Markdown, or PDF

## Usage

1. Navigate to any article or web page
2. Click the **Save to Notes** icon (or open popup → **Capture Page**)
3. The extension extracts content, downloads images, and sends everything to your server
4. A toast notification confirms the save with an image count

## How It Works

1. **Content extraction** (runs in the page): Finds the main article element, clones it, resolves all image URLs (including lazy-loaded, srcset, picture elements, CSS backgrounds)
2. **Image download** (runs in the background service worker): Fetches all images with credentials, converts to base64 data URLs, replaces in HTML
3. **Server save**: POSTs the content to your backend, which saves as the chosen format:
   - **HTML**: Self-contained file with base64 images inline
   - **Markdown**: `.md` file with images extracted to a `_images/` subfolder
   - **PDF**: Rendered PDF with images embedded

## Backend API

The extension sends a `POST` to `{serverUrl}/save-blog-post` with:

```json
{
  "title": "Article Title",
  "html": "<article>...content with embedded base64 images...</article>",
  "url": "https://original-source.com/article",
  "format": "html",
  "images": {},
  "download_images": true
}
```

Expected response:
```json
{
  "ok": true,
  "url": "/saved-article-slug.html",
  "image_stats": { "total": 5, "downloaded": 3, "failed": 2 }
}
```

You can implement this endpoint in any language/framework — the example Python server is just a starting point.

## Project Structure

```
save-to-notes/
├── manifest.json        # Chrome extension manifest (v3)
├── background.js        # Service worker: image download + server communication
├── popup.html           # Extension popup UI
├── popup.js             # Popup logic + content extraction (injected into page)
├── icon16/48/128.png    # Extension icons
├── server-example/
│   └── server.py        # Minimal Python backend
└── README.md
```

## Customization

- **Change save behavior**: Modify `server-example/server.py` or write your own backend
- **Adjust content selectors**: Edit the `selectors` array in `popup.js` → `extractContent()`
- **Change UI colors**: The toast uses `#f0913a` (orange) — search and replace in `background.js` and `popup.html`

## Contributing

Found a bug or have a feature request? [Open an issue](https://github.com/k-ji/save-to-notes/issues).

Want to fix it yourself?

1. Fork this repo
2. Create a branch (`git checkout -b fix/my-fix`)
3. Commit your changes
4. Open a pull request

## License

MIT
