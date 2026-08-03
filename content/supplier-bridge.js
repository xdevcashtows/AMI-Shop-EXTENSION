/**
 * Supplier-page bridge (no overlay). Handles launch-URL session handshake,
 * Fill VIN / scrape / reset relays for the Chrome Side Panel UI.
 */
(function () {
  if (window.__amiPartsBridgeSupplierBridgeLoaded) return;
  window.__amiPartsBridgeSupplierBridgeLoaded = true;

  const Ami = globalThis.AmiChrome;
  let dead = false;

  function markDead() {
    dead = true;
  }

  function ensureAlive() {
    if (dead) return false;
    if (!Ami?.extensionAlive()) {
      markDead();
      return false;
    }
    return true;
  }

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

  function stripBridgeHashFromUrl() {
    try {
      const url = new URL(window.location.href);
      const hash = url.hash.replace(/^#/, '');
      if (
        !hash ||
        (!hash.includes('ami-bridge=') && !hash.includes('ami_ts='))
      ) {
        return;
      }
      const cleaned = hash
        .split('&')
        .filter(
          (part) =>
            part &&
            !part.startsWith('ami-bridge=') &&
            !part.startsWith('ami_ts=')
        )
        .join('&');
      url.hash = cleaned;
      window.history.replaceState(
        null,
        '',
        url.toString().replace(/#$/, '')
      );
    } catch {
      // ignore
    }
  }

  function applySessionFromLaunchUrl() {
    if (!ensureAlive()) return;
    const payload = parseBridgePayloadFromHash();
    if (!payload) {
      stripBridgeHashFromUrl();
      return;
    }

    stripBridgeHashFromUrl();

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
      if (response?.ok === false && response.error) return;
      window.dispatchEvent(new CustomEvent('ami-parts-bridge-reset-cart'));
    });
  }

  function requestFillVin(sendResponse) {
    if (!ensureAlive()) {
      sendResponse?.({ ok: false, error: 'Extension reloaded — refresh this tab' });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('ami-parts-bridge-fill-vin-result', onResult);
      sendResponse?.(
        result?.ok
          ? { ok: true, message: 'VIN filled on page' }
          : {
              ok: false,
              error: result?.reason || 'Could not fill VIN'
            }
      );
    };
    const onResult = (e) => finish(e.detail || {});
    window.addEventListener('ami-parts-bridge-fill-vin-result', onResult);
    window.dispatchEvent(new CustomEvent('ami-parts-bridge-fill-vin'));

    void Ami.sendMessage({ type: 'AMI_GET_SESSION' }).then((response) => {
      if (response?.error && /invalidated|refresh/i.test(response.error)) {
        markDead();
        finish({ ok: false, reason: response.error });
        return;
      }
      const vin = response?.session?.vehicle?.vin;
      if (typeof window.__amiTryFillVin === 'function') {
        finish(window.__amiTryFillVin(vin));
        return;
      }
      window.setTimeout(() => {
        if (!settled) {
          finish({ ok: false, reason: 'VIN field not found on this page' });
        }
      }, 1200);
    });
  }

  Ami?.onRuntimeMessage((message, _sender, sendResponse) => {
    if (!ensureAlive()) return;
    if (!message || typeof message !== 'object') return;

    if (message.type === 'AMI_FILL_VIN') {
      requestFillVin(sendResponse);
      return true;
    }

    if (message.type === 'AMI_SESSION_UPDATED') {
      if (message.resetCart) {
        window.dispatchEvent(new CustomEvent('ami-parts-bridge-reset-cart'));
      }
      sendResponse?.({ ok: true });
      return;
    }

    // Legacy show/hide/toggle no-ops — UI lives in the Chrome Side Panel.
    if (
      message.type === 'AMI_SHOW_WIDGET' ||
      message.type === 'AMI_HIDE_WIDGET' ||
      message.type === 'AMI_TOGGLE_WIDGET'
    ) {
      sendResponse?.({ ok: true, sidePanel: true });
      return;
    }
  });

  applySessionFromLaunchUrl();
  window.addEventListener('hashchange', () => {
    applySessionFromLaunchUrl();
  });

  void Ami?.sendMessage({ type: 'AMI_GET_SESSION' }).then((response) => {
    if (response?.error && /invalidated|refresh/i.test(response.error)) {
      markDead();
    }
  });
})();
