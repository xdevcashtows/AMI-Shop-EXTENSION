(function () {
  const PING = 'ami-parts-bridge-ping';
  const PONG = 'ami-parts-bridge-pong';
  const SESSION_EVENT = 'ami-parts-bridge-session';

  /** Local alive check — never throws. */
  function isAlive() {
    try {
      if (typeof chrome === 'undefined') return false;
      const runtime = chrome.runtime;
      if (!runtime) return false;
      return typeof runtime.id === 'string' && runtime.id.length > 0;
    } catch (_error) {
      return false;
    }
  }

  function safeSend(message) {
    return new Promise((resolve) => {
      if (!isAlive()) {
        resolve({
          ok: false,
          error: 'Extension was reloaded — refresh this CRM tab'
        });
        return;
      }
      try {
        chrome.runtime.sendMessage(message, (response) => {
          try {
            const err = chrome.runtime.lastError;
            if (err) {
              resolve({
                ok: false,
                error: /invalidated/i.test(err.message || '')
                  ? 'Extension was reloaded — refresh this CRM tab'
                  : err.message
              });
              return;
            }
            resolve(response ?? { ok: true });
          } catch (_error) {
            resolve({
              ok: false,
              error: 'Extension was reloaded — refresh this CRM tab'
            });
          }
        });
      } catch (_error) {
        resolve({
          ok: false,
          error: 'Extension was reloaded — refresh this CRM tab'
        });
      }
    });
  }

  function onPing() {
    try {
      if (!isAlive()) return;
      window.dispatchEvent(new CustomEvent(PONG));
    } catch (_error) {
      // Swallow — stale content script after extension reload.
    }
  }

  function onSession(event) {
    try {
      const detail = event?.detail;
      if (!detail || !detail.sessionId || !detail.bridgeToken) return;

      if (!isAlive()) {
        console.warn(
          '[AMI Parts Bridge] Extension was reloaded. Refresh this CRM tab, then click Order from O\'Reilly again.'
        );
        return;
      }

      void safeSend({
        type: 'AMI_SET_SESSION',
        session: {
          sessionId: detail.sessionId,
          bridgeToken: detail.bridgeToken,
          supplier: detail.supplier,
          supplierUrl: detail.supplierUrl,
          jobCardId: detail.jobCardId,
          jobNumber: detail.jobNumber,
          vehicle: detail.vehicle || {},
          crmOrigin: detail.crmOrigin || window.location.origin,
          lines: []
        }
      }).then((response) => {
        try {
          if (response?.ok === false && response.error) {
            console.warn('[AMI Parts Bridge]', response.error);
            return;
          }
          void safeSend({ type: 'AMI_SHOW_WIDGET' });
        } catch (_error) {
          // ignore
        }
      });
    } catch (_error) {
      // Swallow — stale content script after extension reload.
    }
  }

  window.addEventListener(PING, onPing);
  window.addEventListener(SESSION_EVENT, onSession);

  try {
    if (isAlive()) {
      window.dispatchEvent(new CustomEvent(PONG));
    }
  } catch (_error) {
    // ignore
  }
})();
