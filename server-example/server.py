"""
Minimal example backend for the Save to Notes Chrome extension.

Receives POST requests at /save-blog-post with article content and saves
them as HTML, Markdown, or PDF files with embedded images.

Usage:
    python server.py [--port 8765] [--output-dir ./saved-articles]

Optional dependencies:
    pip install requests        # Better image downloading
    pip install markdownify     # Markdown format support
    pip install weasyprint      # PDF format support
"""

import argparse
import base64
import http.server
import json
import os
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

try:
    import requests
    REQUESTS_AVAILABLE = True
except ImportError:
    REQUESTS_AVAILABLE = False

try:
    from markdownify import markdownify as md
    MARKDOWNIFY_AVAILABLE = True
except ImportError:
    MARKDOWNIFY_AVAILABLE = False

try:
    from weasyprint import HTML as WeasyHTML
    WEASYPRINT_AVAILABLE = True
except ImportError:
    WEASYPRINT_AVAILABLE = False


def make_handler(output_dir):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def do_POST(self):
            if self.path == '/save-blog-post':
                self.handle_save()
            else:
                self.send_error(404)

        def do_OPTIONS(self):
            self.send_response(200)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.end_headers()

        def handle_save(self):
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode('utf-8')
            data = json.loads(body)

            title = data.get('title', '').strip()
            html_content = data.get('html', '')
            source_url = data.get('url', '')
            save_format = data.get('format', 'html')

            if not title or not html_content:
                self.send_json({'error': 'title and html required'}, 400)
                return

            # Validate format and dependencies
            if save_format == 'markdown' and not MARKDOWNIFY_AVAILABLE:
                self.send_json({'error': 'Markdown format requires markdownify: pip install markdownify'}, 400)
                return
            if save_format == 'pdf' and not WEASYPRINT_AVAILABLE:
                self.send_json({'error': 'PDF format requires weasyprint: pip install weasyprint'}, 400)
                return

            # Create slug from title
            slug = re.sub(r'[^\w\s-]', '', title.lower())
            slug = re.sub(r'[\s_]+', '-', slug).strip('-')[:80]

            save_dir = Path(output_dir)
            save_dir.mkdir(parents=True, exist_ok=True)

            ext = {'html': '.html', 'markdown': '.md', 'pdf': '.pdf'}[save_format]
            if (save_dir / f'{slug}{ext}').exists():
                slug = f'{slug}-{datetime.now().strftime("%H%M%S")}'

            # Download remaining external images server-side
            image_stats = {'total': 0, 'downloaded': 0, 'failed': 0}
            if data.get('download_images') and REQUESTS_AVAILABLE:
                html_content, image_stats = self.download_external_images(
                    html_content, source_url
                )

            # Build styled HTML (used by html and pdf formats)
            styled_html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>{title}</title>
<style>
    body {{
        max-width: 800px;
        margin: 40px auto;
        padding: 0 20px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        line-height: 1.6;
        color: #333;
    }}
    img {{ max-width: 100%; height: auto; }}
    .source-link {{
        color: #888;
        font-size: 13px;
        margin-bottom: 20px;
        border-bottom: 1px solid #eee;
        padding-bottom: 12px;
    }}
    .source-link a {{ color: #f0913a; }}
</style>
</head>
<body>
<h1>{title}</h1>
<div class="source-link">
    Saved {datetime.now().strftime('%Y-%m-%d %H:%M')}
    {f' &mdash; <a href="{source_url}">Source</a>' if source_url else ''}
</div>
{html_content}
</body>
</html>"""

            filepath = save_dir / f'{slug}{ext}'

            if save_format == 'html':
                filepath.write_text(styled_html, encoding='utf-8')

            elif save_format == 'markdown':
                # Save images to a subfolder, replace base64 with local paths
                images_dir = save_dir / f'{slug}_images'
                markdown_content = self.html_to_markdown(
                    html_content, title, source_url, images_dir, slug
                )
                filepath.write_text(markdown_content, encoding='utf-8')

            elif save_format == 'pdf':
                WeasyHTML(string=styled_html).write_pdf(str(filepath))

            file_size = filepath.stat().st_size
            print(f'Saved [{save_format}]: {filepath} ({file_size:,} bytes)')

            self.send_json({
                'ok': True,
                'url': f'/{slug}{ext}',
                'image_stats': image_stats
            })

        def html_to_markdown(self, html_content, title, source_url, images_dir, slug):
            """Convert HTML to Markdown, extracting base64 images to files."""
            # Extract base64 images and save to files
            img_counter = [0]
            def replace_b64_img(match):
                full_tag = match.group(0)
                b64_match = re.search(r'src=["\']data:image/(\w+);base64,([^"\']+)["\']', full_tag)
                if not b64_match:
                    return full_tag
                img_ext = b64_match.group(1)
                if img_ext == 'jpeg':
                    img_ext = 'jpg'
                img_data = b64_match.group(2)
                img_counter[0] += 1
                img_filename = f'{slug}_{img_counter[0]:03d}.{img_ext}'
                images_dir.mkdir(parents=True, exist_ok=True)
                (images_dir / img_filename).write_bytes(base64.b64decode(img_data))
                alt = re.search(r'alt=["\']([^"\']*)["\']', full_tag)
                alt_text = alt.group(1) if alt else ''
                return f'<img src="{slug}_images/{img_filename}" alt="{alt_text}">'

            html_content = re.sub(r'<img[^>]+>', replace_b64_img, html_content)

            # Convert to markdown
            markdown = md(html_content, heading_style='ATX', strip=['script', 'style'])
            # Clean up excessive blank lines
            markdown = re.sub(r'\n{3,}', '\n\n', markdown).strip()

            # Add header
            header = f'# {title}\n\n'
            if source_url:
                header += f'Source: {source_url}\n'
            header += f'Saved: {datetime.now().strftime("%Y-%m-%d %H:%M")}\n\n---\n\n'

            return header + markdown

        def download_external_images(self, html_content, source_url):
            """Download any remaining external images and embed as base64."""
            stats = {'total': 0, 'downloaded': 0, 'failed': 0}
            img_pattern = re.compile(r'<img[^>]+src=["\']?(https?://[^"\'>\s]+)["\']?', re.I)

            for match in img_pattern.finditer(html_content):
                src = match.group(1)
                stats['total'] += 1
                try:
                    resp = requests.get(src, timeout=15, headers={
                        'User-Agent': 'Mozilla/5.0 Chrome/131.0.0.0',
                        'Referer': source_url,
                        'Accept': 'image/*,*/*;q=0.8',
                    })
                    ct = resp.headers.get('content-type', '')
                    if resp.status_code == 200 and len(resp.content) > 500:
                        if not ct.startswith('image'):
                            ext = src.lower().rsplit('.', 1)[-1].split('?')[0]
                            ct_map = {'png': 'image/png', 'jpg': 'image/jpeg',
                                      'jpeg': 'image/jpeg', 'gif': 'image/gif',
                                      'webp': 'image/webp'}
                            ct = ct_map.get(ext, 'image/png')
                        else:
                            ct = ct.split(';')[0]
                        b64 = base64.b64encode(resp.content).decode()
                        html_content = html_content.replace(src, f'data:{ct};base64,{b64}')
                        stats['downloaded'] += 1
                    else:
                        stats['failed'] += 1
                except Exception:
                    stats['failed'] += 1

            return html_content, stats

        def send_json(self, data, status=200):
            body = json.dumps(data).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Length', len(body))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):
            print(f'[{datetime.now().strftime("%H:%M:%S")}] {format % args}')

    return Handler


def main():
    parser = argparse.ArgumentParser(description='Save to Notes server')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--output-dir', default='./saved-articles')
    args = parser.parse_args()

    handler = make_handler(args.output_dir)
    server = http.server.HTTPServer(('0.0.0.0', args.port), handler)
    print(f'Save to Notes server running on http://localhost:{args.port}')
    print(f'Saving articles to: {os.path.abspath(args.output_dir)}')
    server.serve_forever()


if __name__ == '__main__':
    main()
