/**
 * Runs first on NAPA ProLink: capture #ami-bridge session, strip the hash
 * synchronously so ProLink never fights the fragment, then apply session.
 */
(function () {
  function parseBridgePayloadFromHash() {
    try {
      const hash = window.location.hash.replace(/^#/, '');
      if (!hash || !hash.includes('ami-bridge=')) return null;
      const params = new URLSearchParams(hash.includes('=') ? hash : `x=${hash}`);
      let encoded = params.get('ami-bridge');
      if (!encoded) {
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

  function clearAmiHash() {
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
      window.history.replaceState(null, '', url.toString().replace(/#$/, ''));
    } catch {
      // ignore
    }
  }

  const payload = parseBridgePayloadFromHash();
  // Always strip foreign ami_* fragments before ProLink boots further.
  clearAmiHash();
  if (!payload) return;

  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.id) return;
    chrome.runtime.sendMessage({
      type: 'AMI_SET_SESSION',
      session: {
        sessionId: payload.sessionId,
        bridgeToken: payload.bridgeToken,
        supplier: payload.supplier || 'napa',
        supplierUrl: window.location.href.split('#')[0],
        jobCardId: payload.jobCardId,
        jobNumber: payload.jobNumber,
        vehicle: payload.vehicle || {},
        crmOrigin: payload.crmOrigin,
        apiBaseUrl: payload.apiBaseUrl,
        lines: []
      }
    });
  } catch {
    // ignore
  }
})();
