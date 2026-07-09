(function () {
  const ROOT_ID = 'ami-parts-bridge-root';
  const POSITION_KEY = 'amiPartsBridgeWidgetPosition';
  const DEFAULT_WIDTH = 360;
  const DEFAULT_HEIGHT = 520;
  const MIN_WIDTH = 280;
  const MIN_HEIGHT = 320;
  const COLLAPSED_WIDTH = 220;
  const COLLAPSED_HEIGHT = 44;

  if (window.__amiPartsBridgeWidgetLoaded) return;
  window.__amiPartsBridgeWidgetLoaded = true;

  const Ami = globalThis.AmiChrome;
  let dead = false;

  /** @type {HTMLElement | null} */
  let root = null;
  /** @type {HTMLIFrameElement | null} */
  let frame = null;
  /** @type {HTMLElement | null} */
  let resizeHandles = null;
  let collapsed = false;
  let width = DEFAULT_WIDTH;
  let height = DEFAULT_HEIGHT;

  function markDead(message) {
    dead = true;
    if (root) {
      const bar = root.querySelector('[data-ami-pb-drag]');
      if (bar && !root.querySelector('[data-ami-pb-dead]')) {
        const note = document.createElement('div');
        note.setAttribute('data-ami-pb-dead', 'true');
        note.textContent = message || 'Extension reloaded — refresh this tab';
        Object.assign(note.style, {
          padding: '6px 10px',
          background: '#7f1d1d',
          color: '#fff',
          fontSize: '11px',
          fontWeight: '600'
        });
        root.insertBefore(note, root.children[1] || null);
      }
    }
  }

  function ensureAlive() {
    if (dead) return false;
    if (!Ami?.extensionAlive()) {
      markDead();
      return false;
    }
    return true;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function maxWidth() {
    return Math.max(MIN_WIDTH, window.innerWidth - 16);
  }

  function maxHeight() {
    return Math.max(MIN_HEIGHT, window.innerHeight - 16);
  }

  function currentBoxWidth() {
    return collapsed ? COLLAPSED_WIDTH : width;
  }

  function currentBoxHeight() {
    return collapsed ? COLLAPSED_HEIGHT : height;
  }

  function defaultPosition() {
    return {
      left: Math.max(16, window.innerWidth - width - 24),
      top: 80
    };
  }

  function applyPosition(left, top) {
    if (!root) return;
    const maxLeft = Math.max(8, window.innerWidth - currentBoxWidth() - 8);
    const maxTop = Math.max(8, window.innerHeight - currentBoxHeight() - 8);
    root.style.left = `${clamp(left, 8, maxLeft)}px`;
    root.style.top = `${clamp(top, 8, maxTop)}px`;
  }

  function applySize(nextWidth, nextHeight) {
    width = clamp(nextWidth, MIN_WIDTH, maxWidth());
    height = clamp(nextHeight, MIN_HEIGHT, maxHeight());
    if (!root || collapsed) return;
    root.style.width = `${width}px`;
    root.style.height = `${height}px`;
  }

  function saveLayout() {
    if (!root || !ensureAlive()) return;
    const left = Number.parseFloat(root.style.left) || 0;
    const top = Number.parseFloat(root.style.top) || 0;
    void Ami.storageSet({
      [POSITION_KEY]: {
        left,
        top,
        width,
        height,
        collapsed
      }
    });
  }

  function setCollapsed(next) {
    collapsed = next;
    if (!root || !frame) return;
    root.classList.toggle('ami-pb-collapsed', collapsed);
    frame.style.display = collapsed ? 'none' : 'block';
    if (resizeHandles) {
      resizeHandles.style.display = collapsed ? 'none' : 'block';
    }
    root.style.height = `${currentBoxHeight()}px`;
    root.style.width = `${currentBoxWidth()}px`;
    const toggle = root.querySelector('[data-ami-pb-toggle]');
    if (toggle) toggle.textContent = collapsed ? '▴' : '▾';
    const left = Number.parseFloat(root.style.left) || 0;
    const top = Number.parseFloat(root.style.top) || 0;
    applyPosition(left, top);
    saveLayout();
  }

  function ensureWidget() {
    if (document.getElementById(ROOT_ID)) {
      root = document.getElementById(ROOT_ID);
      frame = root.querySelector('iframe');
      resizeHandles = root.querySelector('[data-ami-pb-handles]');
      root.style.display = 'flex';
      return;
    }

    root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute('data-ami-parts-bridge', 'true');

    Object.assign(root.style, {
      position: 'fixed',
      zIndex: '2147483646',
      width: `${width}px`,
      height: `${height}px`,
      display: 'flex',
      flexDirection: 'column',
      borderRadius: '14px',
      overflow: 'hidden',
      boxShadow: '0 18px 50px rgba(15, 39, 68, 0.28)',
      border: '1px solid rgba(15, 39, 68, 0.18)',
      background: '#0f2744',
      fontFamily: '"Segoe UI", system-ui, sans-serif'
    });

    const chromeBar = document.createElement('div');
    chromeBar.setAttribute('data-ami-pb-drag', 'true');
    Object.assign(chromeBar.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '8px',
      padding: '8px 10px',
      background: '#0f2744',
      color: '#fff',
      cursor: 'grab',
      userSelect: 'none',
      flexShrink: '0'
    });

    const title = document.createElement('div');
    title.textContent = 'AMI Parts Bridge';
    Object.assign(title.style, {
      fontSize: '12px',
      fontWeight: '700',
      letterSpacing: '0.02em'
    });

    const controls = document.createElement('div');
    Object.assign(controls.style, {
      display: 'flex',
      gap: '4px'
    });

    function makeChromeBtn(label, attr) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      if (attr) btn.setAttribute(attr, 'true');
      Object.assign(btn.style, {
        border: '0',
        background: 'rgba(255,255,255,0.12)',
        color: '#fff',
        width: '26px',
        height: '24px',
        borderRadius: '6px',
        cursor: 'pointer',
        fontSize: '12px',
        lineHeight: '1',
        fontWeight: '700'
      });
      return btn;
    }

    const toggleBtn = makeChromeBtn('▾', 'data-ami-pb-toggle');
    const closeBtn = makeChromeBtn('✕', 'data-ami-pb-close');
    controls.appendChild(toggleBtn);
    controls.appendChild(closeBtn);
    chromeBar.appendChild(title);
    chromeBar.appendChild(controls);

    frame = document.createElement('iframe');
    try {
      frame.src = chrome.runtime.getURL('widget/index.html');
    } catch {
      markDead('Extension reloaded — refresh this tab');
      return;
    }
    frame.title = 'AMI Parts Bridge';
    Object.assign(frame.style, {
      border: '0',
      width: '100%',
      flex: '1',
      background: '#f8fafc',
      display: 'block'
    });

    resizeHandles = document.createElement('div');
    resizeHandles.setAttribute('data-ami-pb-handles', 'true');
    Object.assign(resizeHandles.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none'
    });

    const handleDefs = [
      { edge: 'n', cursor: 'ns-resize', top: '0', left: '8px', right: '8px', height: '6px' },
      { edge: 's', cursor: 'ns-resize', bottom: '0', left: '8px', right: '8px', height: '6px' },
      { edge: 'e', cursor: 'ew-resize', top: '8px', right: '0', bottom: '8px', width: '6px' },
      { edge: 'w', cursor: 'ew-resize', top: '8px', left: '0', bottom: '8px', width: '6px' },
      { edge: 'ne', cursor: 'nesw-resize', top: '0', right: '0', width: '12px', height: '12px' },
      { edge: 'nw', cursor: 'nwse-resize', top: '0', left: '0', width: '12px', height: '12px' },
      { edge: 'se', cursor: 'nwse-resize', bottom: '0', right: '0', width: '14px', height: '14px' },
      { edge: 'sw', cursor: 'nesw-resize', bottom: '0', left: '0', width: '12px', height: '12px' }
    ];

    for (const def of handleDefs) {
      const handle = document.createElement('div');
      handle.setAttribute('data-ami-pb-resize', def.edge);
      Object.assign(handle.style, {
        position: 'absolute',
        pointerEvents: 'auto',
        cursor: def.cursor,
        top: def.top || 'auto',
        left: def.left || 'auto',
        right: def.right || 'auto',
        bottom: def.bottom || 'auto',
        width: def.width || 'auto',
        height: def.height || 'auto',
        zIndex: '2'
      });

      if (def.edge === 'se') {
        handle.style.background =
          'linear-gradient(135deg, transparent 55%, rgba(255,255,255,0.55) 55%, rgba(255,255,255,0.55) 70%, transparent 70%), linear-gradient(135deg, transparent 70%, rgba(255,255,255,0.4) 70%, rgba(255,255,255,0.4) 85%, transparent 85%)';
      }

      resizeHandles.appendChild(handle);
      setupResize(handle, def.edge);
    }

    root.appendChild(chromeBar);
    root.appendChild(frame);
    root.appendChild(resizeHandles);
    document.documentElement.appendChild(root);

    void Ami.storageGet([POSITION_KEY]).then((result) => {
      if (!ensureAlive()) return;
      const saved = result[POSITION_KEY];
      if (saved && typeof saved.width === 'number') width = saved.width;
      if (saved && typeof saved.height === 'number') height = saved.height;
      applySize(width, height);

      const pos = saved && typeof saved.left === 'number' ? saved : defaultPosition();
      applyPosition(pos.left, pos.top);
      if (saved?.collapsed) setCollapsed(true);
    });

    toggleBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      setCollapsed(!collapsed);
    });

    closeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (root) root.style.display = 'none';
    });

    setupDrag(chromeBar);
  }

  function setupDrag(handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    handle.addEventListener('pointerdown', (event) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('[data-ami-pb-toggle], [data-ami-pb-close], [data-ami-pb-resize]')) {
        return;
      }
      if (!root) return;

      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      originLeft = Number.parseFloat(root.style.left) || 0;
      originTop = Number.parseFloat(root.style.top) || 0;
      handle.style.cursor = 'grabbing';
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    handle.addEventListener('pointermove', (event) => {
      if (!dragging || !root) return;
      applyPosition(originLeft + (event.clientX - startX), originTop + (event.clientY - startY));
    });

    handle.addEventListener('pointerup', (event) => {
      if (!dragging) return;
      dragging = false;
      handle.style.cursor = 'grab';
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch {
        // ignore
      }
      saveLayout();
    });
  }

  function setupResize(handle, edge) {
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let startWidth = 0;
    let startHeight = 0;

    handle.addEventListener('pointerdown', (event) => {
      if (!root || collapsed) return;
      resizing = true;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = Number.parseFloat(root.style.left) || 0;
      startTop = Number.parseFloat(root.style.top) || 0;
      startWidth = width;
      startHeight = height;
      if (frame) frame.style.pointerEvents = 'none';
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    });

    handle.addEventListener('pointermove', (event) => {
      if (!resizing || !root) return;

      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      let nextLeft = startLeft;
      let nextTop = startTop;
      let nextWidth = startWidth;
      let nextHeight = startHeight;

      if (edge.includes('e')) {
        nextWidth = startWidth + dx;
      }
      if (edge.includes('s')) {
        nextHeight = startHeight + dy;
      }
      if (edge.includes('w')) {
        nextWidth = startWidth - dx;
        nextLeft = startLeft + dx;
      }
      if (edge.includes('n')) {
        nextHeight = startHeight - dy;
        nextTop = startTop + dy;
      }

      const clampedWidth = clamp(nextWidth, MIN_WIDTH, maxWidth());
      const clampedHeight = clamp(nextHeight, MIN_HEIGHT, maxHeight());

      if (edge.includes('w')) {
        nextLeft = startLeft + (startWidth - clampedWidth);
      }
      if (edge.includes('n')) {
        nextTop = startTop + (startHeight - clampedHeight);
      }

      applySize(clampedWidth, clampedHeight);
      applyPosition(nextLeft, nextTop);
    });

    handle.addEventListener('pointerup', (event) => {
      if (!resizing) return;
      resizing = false;
      if (frame) frame.style.pointerEvents = 'auto';
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch {
        // ignore
      }
      saveLayout();
    });
  }

  function showWidget() {
    ensureWidget();
    if (root) root.style.display = 'flex';
  }

  function hideWidget() {
    if (root) root.style.display = 'none';
  }

  function notifyWidgetStatus(text, kind) {
    if (!frame?.contentWindow) return;
    frame.contentWindow.postMessage(
      { source: 'ami-parts-bridge-host', type: 'AMI_HOST_STATUS', text, kind },
      '*'
    );
  }

  function requestFillVin() {
    if (!ensureAlive()) {
      notifyWidgetStatus('Extension reloaded — refresh this tab', 'err');
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('ami-parts-bridge-fill-vin-result', onResult);
      notifyWidgetStatus(
        result?.ok ? 'VIN filled on page' : result?.reason || 'Could not fill VIN',
        result?.ok ? 'ok' : 'err'
      );
    };
    const onResult = (e) => finish(e.detail || {});
    window.addEventListener('ami-parts-bridge-fill-vin-result', onResult);
    window.dispatchEvent(new CustomEvent('ami-parts-bridge-fill-vin'));

    void Ami.sendMessage({ type: 'AMI_GET_SESSION' }).then((response) => {
      if (response?.error && /invalidated|refresh/i.test(response.error)) {
        markDead(response.error);
        finish({ ok: false, reason: response.error });
        return;
      }
      const vin = response?.session?.vehicle?.vin;
      if (typeof window.__amiTryFillVin === 'function') {
        finish(window.__amiTryFillVin(vin));
        return;
      }
      window.setTimeout(() => {
        if (!settled) finish({ ok: false, reason: 'VIN field not found on this page' });
      }, 1200);
    });
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== 'ami-parts-bridge-widget') return;
    if (!ensureAlive()) return;

    if (data.type === 'AMI_WIDGET_FILL_VIN') {
      requestFillVin();
    }

    if (data.type === 'AMI_WIDGET_SCRAPE_NOW') {
      window.dispatchEvent(new CustomEvent('ami-parts-bridge-scrape-now'));
    }
  });

  function parseBridgePayloadFromHash() {
    try {
      const hash = window.location.hash.replace(/^#/, '');
      if (!hash) return null;
      const params = new URLSearchParams(hash.includes('=') ? hash : `x=${hash}`);
      let encoded = params.get('ami-bridge');
      if (!encoded && hash.includes('ami-bridge=')) {
        encoded = hash.split('ami-bridge=')[1]?.split('&')[0] || null;
      }
      if (!encoded) return null;
      const json = atob(decodeURIComponent(encoded));
      const payload = JSON.parse(json);
      if (!payload?.sessionId || !payload?.bridgeToken) return null;
      return payload;
    } catch {
      return null;
    }
  }

  function applySessionFromLaunchUrl() {
    if (!ensureAlive()) return;
    const payload = parseBridgePayloadFromHash();
    if (!payload) return;

    void Ami.sendMessage({
      type: 'AMI_SET_SESSION',
      session: {
        sessionId: payload.sessionId,
        bridgeToken: payload.bridgeToken,
        supplier: payload.supplier || 'oreilly',
        supplierUrl: window.location.href.split('#')[0],
        jobCardId: payload.jobCardId,
        jobNumber: payload.jobNumber,
        vehicle: payload.vehicle || {},
        crmOrigin: payload.crmOrigin,
        apiBaseUrl: payload.apiBaseUrl,
        lines: []
      }
    }).then((response) => {
      if (response?.ok === false && response.error) {
        notifyWidgetStatus(response.error, 'err');
        return;
      }
      // Clear any in-page scraped cart from a previous job/session.
      window.dispatchEvent(new CustomEvent('ami-parts-bridge-reset-cart'));
      showWidget();
      notifyWidgetStatus('Shop cart ready for this job', 'ok');
      // Clean the handshake out of the URL so refresh doesn't re-apply forever.
      try {
        const url = new URL(window.location.href);
        const hash = url.hash.replace(/^#/, '');
        if (hash.includes('ami-bridge=')) {
          const cleaned = hash
            .split('&')
            .filter((part) => part && !part.startsWith('ami-bridge='))
            .join('&');
          url.hash = cleaned;
          window.history.replaceState(null, '', url.toString());
        }
      } catch {
        // ignore
      }
    });
  }

  Ami?.onRuntimeMessage((message, _sender, sendResponse) => {
    if (!ensureAlive()) return;
    if (message?.type === 'AMI_SHOW_WIDGET') {
      showWidget();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === 'AMI_HIDE_WIDGET') {
      hideWidget();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === 'AMI_TOGGLE_WIDGET') {
      ensureWidget();
      if (root && root.style.display === 'none') showWidget();
      else hideWidget();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === 'AMI_SESSION_UPDATED') {
      if (message.resetCart) {
        window.dispatchEvent(new CustomEvent('ami-parts-bridge-reset-cart'));
      }
      showWidget();
      sendResponse({ ok: true });
      return;
    }
  });

  Ami?.onStorageChanged((changes, area) => {
    if (!ensureAlive()) return;
    if (area !== 'local') return;
    if (changes.amiPartsBridgeSession?.newValue) {
      showWidget();
    }
  });

  // Prefer launch-URL handshake (works even when CRM content script is stale).
  applySessionFromLaunchUrl();
  window.addEventListener('hashchange', () => {
    applySessionFromLaunchUrl();
  });

  void Ami?.sendMessage({ type: 'AMI_GET_SESSION' }).then((response) => {
    if (response?.session) showWidget();
    if (response?.error && /invalidated|refresh/i.test(response.error)) {
      markDead(response.error);
    }
  });

  window.addEventListener('resize', () => {
    if (!root || root.style.display === 'none') return;
    applySize(width, height);
    const left = Number.parseFloat(root.style.left) || 0;
    const top = Number.parseFloat(root.style.top) || 0;
    applyPosition(left, top);
  });
})();
