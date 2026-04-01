var DEFAULT_SERVER = 'http://localhost:8765';

// Helper: get configured server URL
function getServerUrl(callback) {
  chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER }, function(data) {
    callback(data.serverUrl.replace(/\/+$/, ''));
  });
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.type === 'save-article') {
    handleSaveArticle(msg, sender.tab.id);
  }
});

async function handleSaveArticle(msg, tabId) {
  var { title, html, url, imageUrls } = msg;

  // Notify user we're downloading images
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    function: showStatus,
    args: ['Downloading ' + imageUrls.length + ' images...']
  });

  // Download all images from the background script (no CORS restrictions)
  var imageMap = {};
  var downloaded = 0;
  var failed = 0;

  var promises = imageUrls.map(async function(imgUrl) {
    try {
      var resp = await fetch(imgUrl, {
        credentials: 'include',
        headers: {
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        }
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var blob = await resp.blob();
      if (blob.size < 500) throw new Error('too small (' + blob.size + ' bytes)');
      var reader = new FileReader();
      var dataUrl = await new Promise(function(resolve, reject) {
        reader.onloadend = function() { resolve(reader.result); };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      imageMap[imgUrl] = dataUrl;
      downloaded++;
    } catch(e) {
      failed++;
    }
  });

  await Promise.all(promises);

  // Replace image src URLs with data URLs in the HTML
  for (var [origUrl, dataUrl] of Object.entries(imageMap)) {
    var escaped = origUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(escaped, 'g'), dataUrl);
  }

  // Update status
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    function: showStatus,
    args: ['Saving (' + downloaded + '/' + imageUrls.length + ' images)...']
  });

  // Send to server
  getServerUrl(async function(serverUrl) {
    try {
      var resp = await fetch(serverUrl + '/save-blog-post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          html: html,
          url: url,
          images: {},
          download_images: true
        })
      });
      var result = await resp.json();
      if (result.ok) {
        var serverExtra = (result.image_stats && result.image_stats.downloaded) || 0;
        chrome.scripting.executeScript({
          target: { tabId: tabId },
          function: showSuccess,
          args: [downloaded + serverExtra, imageUrls.length, serverUrl + (result.url || '')]
        });
      } else {
        chrome.scripting.executeScript({
          target: { tabId: tabId },
          function: showError,
          args: [result.error || 'unknown error']
        });
      }
    } catch(e) {
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        function: showError,
        args: [e.message + '\n\nIs the server running at ' + serverUrl + '?']
      });
    }
  });
}

// --- Functions injected into the page ---

function showStatus(msg) {
  var el = document.getElementById('ainotes-status');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ainotes-status';
    el.style.cssText = 'position:fixed;top:20px;right:20px;background:#f0913a;color:white;padding:16px 24px;border-radius:12px;font-family:-apple-system,sans-serif;font-size:15px;font-weight:600;z-index:999999;box-shadow:0 4px 20px rgba(0,0,0,0.15)';
    document.body.appendChild(el);
  }
  el.textContent = msg;
}

function showSuccess(count, total, resultUrl) {
  var el = document.getElementById('ainotes-status');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ainotes-status';
    el.style.cssText = 'position:fixed;top:20px;right:20px;background:#f0913a;color:white;padding:16px 24px;border-radius:12px;font-family:-apple-system,sans-serif;font-size:15px;font-weight:600;z-index:999999;box-shadow:0 4px 20px rgba(0,0,0,0.15);cursor:pointer';
    document.body.appendChild(el);
  }
  el.textContent = 'Saved to AI Notes (' + count + '/' + total + ' images)';
  el.style.cursor = 'pointer';
  el.onclick = function() { window.open(resultUrl, '_blank'); };
  setTimeout(function() {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.5s';
    setTimeout(function() { el.remove(); }, 500);
  }, 4000);
}

function showError(msg) {
  var el = document.getElementById('ainotes-status');
  if (el) el.remove();
  alert('Failed to save: ' + msg);
}
