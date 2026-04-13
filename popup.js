var DEFAULT_SERVER = 'http://localhost:8765';

var serverInput = document.getElementById('server-url');
var formatSelect = document.getElementById('save-format');
var saveBtn = document.getElementById('save-btn');
var captureBtn = document.getElementById('capture-btn');
var statusEl = document.getElementById('status');

// Load saved settings
chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER, saveFormat: 'html' }, function(data) {
  serverInput.value = data.serverUrl;
  formatSelect.value = data.saveFormat;
});

// Save settings
saveBtn.addEventListener('click', function() {
  var url = serverInput.value.trim().replace(/\/+$/, '');
  if (!url) {
    statusEl.textContent = 'URL cannot be empty';
    statusEl.className = 'status error';
    return;
  }
  chrome.storage.sync.set({ serverUrl: url, saveFormat: formatSelect.value }, function() {
    statusEl.textContent = 'Settings saved';
    statusEl.className = 'status success';
    setTimeout(function() { statusEl.textContent = ''; }, 2000);
  });
});

// Capture current page
captureBtn.addEventListener('click', function() {
  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    if (!tabs[0]) return;
    statusEl.textContent = 'Capturing...';
    statusEl.className = 'status';
    chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      function: extractContent
    });
    // Close popup after a short delay (background.js handles the rest)
    setTimeout(function() { window.close(); }, 500);
  });
});

// Content extraction function — injected into the active tab
function extractContent() {
  var boilerplateMarkers = [
    'contents & disclosures',
    'report at a glance',
    'exhibit gallery',
    'audiocast',
    'visualizations'
  ];

  function normalizeText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function isGenericTitle(text) {
    text = normalizeText(text);
    if (!text) return true;
    var lower = text.toLowerCase();
    if (['article', 'research', 'report', 'overview', 'home'].indexOf(lower) !== -1) return true;
    if (text.length <= 3) return true;
    return text.indexOf(' ') === -1 && text.length <= 8;
  }

  function hasBoilerplatePrefix(text) {
    var lower = normalizeText(text).toLowerCase().slice(0, 1800);
    for (var i = 0; i < boilerplateMarkers.length; i++) {
      if (lower.indexOf(boilerplateMarkers[i]) !== -1) return true;
    }
    return false;
  }

  function scoreContainer(el, bodyTextLen) {
    var text = normalizeText(el.innerText || el.textContent);
    var textLen = text.length;
    if (textLen < MIN_CONTENT_LENGTH) return { score: -1, textLen: textLen };

    var depth = 0;
    var p = el;
    while (p.parentElement) { depth++; p = p.parentElement; }

    var tables = el.querySelectorAll('table').length;
    var imgs = el.querySelectorAll('img').length;
    var headings = el.querySelectorAll('h1, h2, h3').length;
    var paras = el.querySelectorAll('p').length;
    var score = textLen + (depth * 40) + (tables * 700) + (imgs * 120) + (headings * 180) + (paras * 120);

    if (hasBoilerplatePrefix(text)) score -= 5000;
    if (bodyTextLen && textLen > bodyTextLen * 0.95) score -= 1200;
    if (el.matches('article, main')) score += 500;

    return { score: score, textLen: textLen };
  }

  function deriveTitle(container, fallbackTitle) {
    var candidates = [];
    var seen = {};

    function addCandidate(text, score) {
      text = normalizeText(text);
      if (!text || text.length < 4 || text.length > 160) return;
      var lower = text.toLowerCase();
      if (seen[lower]) return;
      if (boilerplateMarkers.indexOf(lower) !== -1) return;
      candidates.push({ text: text, score: score });
      seen[lower] = true;
    }

    if (!isGenericTitle(fallbackTitle)) addCandidate(fallbackTitle, 50);

    var embeddedTitles = container.querySelectorAll('title');
    for (var i = 0; i < embeddedTitles.length && i < 8; i++) {
      var embedded = normalizeText(embeddedTitles[i].textContent);
      if (!isGenericTitle(embedded)) addCandidate(embedded, 1000 - (i * 10));
    }

    var headings = container.querySelectorAll('h1, h2, h3');
    for (var j = 0; j < headings.length && j < 20; j++) {
      var headingText = normalizeText(headings[j].textContent);
      var score = headings[j].tagName === 'H1' ? 900 : (headings[j].tagName === 'H2' ? 700 : 500);
      addCandidate(headingText, score - (j * 10));
    }

    if (!candidates.length) return normalizeText(fallbackTitle) || document.title;

    candidates.sort(function(a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return b.text.length - a.text.length;
    });
    return candidates[0].text;
  }

  // Find the best content container by picking the selector with the most text
  var selectors = ['article', '.post-content', '.article-content', '.report-content',
                   '.research-content', '.entry-content', '[role=main]', 'main',
                   '.content-body', '.post-body', '#content', '#article-body'];
  var c = null;
  var matchedSelector = 'body (fallback)';
  var bodyTextLen = normalizeText(document.body.innerText || document.body.textContent).length;
  var bestTextLen = 0;
  var bestScore = -1;
  var MIN_CONTENT_LENGTH = 200;

  for (var si = 0; si < selectors.length; si++) {
    var elements = document.querySelectorAll(selectors[si]);
    for (var ei = 0; ei < elements.length; ei++) {
      var el = elements[ei];
      var scored = scoreContainer(el, bodyTextLen);
      var textLen = scored.textLen;
      console.log('[AI Notes] Selector "' + selectors[si] + '[' + ei + ']": ' + el.querySelectorAll('img').length + ' imgs, ' + textLen + ' chars');
      if (textLen >= MIN_CONTENT_LENGTH && scored.score > bestScore) {
        c = el;
        matchedSelector = selectors[si] + '[' + ei + ']';
        bestTextLen = textLen;
        bestScore = scored.score;
      }
    }
  }

  // If no good selector match, find the deepest element with the most content
  if (!c || bestTextLen < 500) {
    console.log('[AI Notes] Standard selectors insufficient (' + bestTextLen + ' chars), scanning DOM...');
    var candidates = document.body.querySelectorAll('div, section');
    var best = c;
    var autoBestScore = bestScore;
    for (var ci = 0; ci < candidates.length; ci++) {
      var el = candidates[ci];
      var scored = scoreContainer(el, bodyTextLen);
      var tl = scored.textLen;
      if (tl < 500 || tl > bodyTextLen * 0.95) continue;
      if (scored.score > autoBestScore) {
        best = el;
        autoBestScore = scored.score;
        matchedSelector = el.tagName + '.' + (el.className || '').toString().split(' ')[0] + ' (auto)';
      }
    }
    if (best && best !== c) {
      c = best;
      console.log('[AI Notes] Auto-detected content: ' + matchedSelector + ' (' + c.textContent.trim().length + ' chars)');
    }
  }

  if (!c) c = document.body;
  console.log('[AI Notes] Using: ' + matchedSelector + ', ' + c.querySelectorAll('img').length + ' imgs, ' + c.textContent.trim().length + ' chars');

  var t = document.title
    .replace(/^\(\d+\)\s*/, '')
    .replace(/\s*[-–|](?:\s*by\s*)?\s*[^-–|]*$/i, '')
    .trim();
  t = deriveTitle(c, t);

  var u = location.href;

  // Show immediate feedback
  var statusEl = document.createElement('div');
  statusEl.id = 'ainotes-status';
  statusEl.style.cssText = 'position:fixed;top:20px;right:20px;background:#f0913a;color:white;padding:16px 24px;border-radius:12px;font-family:-apple-system,sans-serif;font-size:15px;font-weight:600;z-index:999999;box-shadow:0 4px 20px rgba(0,0,0,0.15)';
  statusEl.textContent = 'Extracting content...';
  document.body.appendChild(statusEl);

  // Clone and resolve image sources
  var cl = c.cloneNode(true);
  var origImgs = c.querySelectorAll('img');
  var cloneImgs = cl.querySelectorAll('img');
  var imageUrls = [];

  for (var i = 0; i < origImgs.length; i++) {
    var real = origImgs[i].currentSrc || origImgs[i].src;
    if (!real || real === 'about:blank' || real.endsWith('/blank.gif') || real.includes('data:image/gif') || real.includes('data:image/svg')) {
      real = origImgs[i].getAttribute('data-src') ||
             origImgs[i].getAttribute('data-lazy-src') ||
             origImgs[i].getAttribute('data-original') ||
             origImgs[i].getAttribute('data-full-url') ||
             origImgs[i].getAttribute('data-image') ||
             origImgs[i].getAttribute('data-hi-res-src') ||
             origImgs[i].getAttribute('data-large-file') ||
             origImgs[i].dataset.src || '';
    }
    // Fallback to srcset
    if (!real || real === 'about:blank') {
      var srcset = origImgs[i].getAttribute('srcset') || origImgs[i].getAttribute('data-srcset') || '';
      if (srcset) {
        var candidates = srcset.split(',').map(function(s) {
          var parts = s.trim().split(/\s+/);
          return { url: parts[0], desc: parseFloat(parts[1]) || 0 };
        }).filter(function(c) { return c.url; });
        candidates.sort(function(a, b) { return b.desc - a.desc; });
        if (candidates.length > 0) real = candidates[0].url;
      }
    }
    // Check noscript siblings
    if (!real) {
      var noscript = origImgs[i].parentElement && origImgs[i].parentElement.querySelector('noscript');
      if (noscript) {
        var m = noscript.textContent.match(/src=["']([^"']+)["']/);
        if (m) real = m[1];
      }
    }
    if (real && !real.startsWith('data:')) {
      try { real = new URL(real, location.origin).href; } catch(e) { continue; }
      // Handle Next.js proxy URLs
      if (real.includes('/_next/image')) {
        try {
          var imgUrl = new URL(real);
          var actualUrl = imgUrl.searchParams.get('url');
          if (actualUrl) {
            real = actualUrl.startsWith('http') ? actualUrl : new URL(actualUrl, location.origin).href;
          }
        } catch(e) {}
      }
      cloneImgs[i].setAttribute('src', real);
      if (imageUrls.indexOf(real) === -1) imageUrls.push(real);
    }
    cloneImgs[i].removeAttribute('srcset');
    cloneImgs[i].removeAttribute('loading');
    cloneImgs[i].removeAttribute('data-src');
    cloneImgs[i].removeAttribute('data-lazy-src');
    cloneImgs[i].removeAttribute('data-srcset');
  }

  // Handle <picture> elements
  cl.querySelectorAll('picture').forEach(function(pic) {
    var img = pic.querySelector('img');
    var sources = pic.querySelectorAll('source');
    if (img && sources.length > 0) {
      var imgSrc = img.getAttribute('src') || '';
      if (!imgSrc || imgSrc.startsWith('data:') || imgSrc === 'about:blank') {
        for (var s = 0; s < sources.length; s++) {
          var srcset = sources[s].getAttribute('srcset') || '';
          if (srcset) {
            var firstUrl = srcset.split(',')[0].trim().split(/\s+/)[0];
            if (firstUrl && !firstUrl.startsWith('data:')) {
              try { firstUrl = new URL(firstUrl, location.origin).href; } catch(e) {}
              img.setAttribute('src', firstUrl);
              if (imageUrls.indexOf(firstUrl) === -1) imageUrls.push(firstUrl);
              break;
            }
          }
        }
      }
    }
    sources.forEach(function(s) { s.remove(); });
  });

  // Extract CSS background images
  var bgCandidates = c.querySelectorAll('div, section, figure, span, a, header, [style*="background"]');
  var cloneBgCandidates = cl.querySelectorAll('div, section, figure, span, a, header, [style*="background"]');
  for (var j = 0; j < bgCandidates.length && j < cloneBgCandidates.length; j++) {
    var computed = window.getComputedStyle(bgCandidates[j]);
    var bgImage = computed.backgroundImage;
    if (bgImage && bgImage !== 'none' && !bgImage.includes('gradient')) {
      var urlMatch = bgImage.match(/url\(\s*["']?([^"')]+)["']?\s*\)/);
      if (urlMatch && urlMatch[1] && !urlMatch[1].startsWith('data:') && !urlMatch[1].includes('.svg')) {
        if (!cloneBgCandidates[j].querySelector('img')) {
          var bgUrl = urlMatch[1];
          try { bgUrl = new URL(bgUrl, location.origin).href; } catch(e) { continue; }
          var newImg = document.createElement('img');
          newImg.setAttribute('src', bgUrl);
          newImg.setAttribute('alt', '');
          cloneBgCandidates[j].insertBefore(newImg, cloneBgCandidates[j].firstChild);
          if (imageUrls.indexOf(bgUrl) === -1) imageUrls.push(bgUrl);
        }
      }
    }
  }

  // Remove heavy media
  cl.querySelectorAll('video, iframe, script, style').forEach(function(el) { el.remove(); });

  var h = cl.innerHTML;
  if (h.length > 20000000) h = h.substring(0, 20000000);

  statusEl.textContent = 'Found ' + imageUrls.length + ' images, downloading...';

  chrome.runtime.sendMessage({
    type: 'save-article',
    title: t,
    html: h,
    url: u,
    imageUrls: imageUrls
  });
}
