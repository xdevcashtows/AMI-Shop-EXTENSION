(function () {
  const PING = 'ami-parts-bridge-ping';
  const PONG = 'ami-parts-bridge-pong';
  const SESSION_EVENT = 'ami-parts-bridge-session';

  let detached = false;

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

  /** After an extension reload this content script is orphaned — stop listening. */
  function detach() {
    if (detached) return;
    detached = true;
    try {
      window.removeEventListener(PING, onPing);
      window.removeEventListener(SESSION_EVENT, onSession);
    } catch (_error) {
      // ignore
    }
  }

  function safeSend(message) {
    return new Promise((resolve) => {
      if (!isAlive()) {
        detach();
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
              if (/invalidated/i.test(err.message || '')) detach();
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
            detach();
            resolve({
              ok: false,
              error: 'Extension was reloaded — refresh this CRM tab'
            });
          }
        });
      } catch (_error) {
        detach();
        resolve({
          ok: false,
          error: 'Extension was reloaded — refresh this CRM tab'
        });
      }
    });
  }

  function onPing() {
    try {
      if (!isAlive()) {
        detach();
        return;
      }
      window.dispatchEvent(new CustomEvent(PONG));
    } catch (_error) {
      detach();
    }
  }

  function onSession(event) {
    try {
      const detail = event?.detail;
      if (!detail || !detail.sessionId || !detail.bridgeToken) return;

      // Session is also passed via the supplier launch URL hash, so a dead
      // CRM bridge is non-fatal — detach quietly and let the supplier tab handle it.
      if (!isAlive()) {
        detach();
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
            if (/reloaded|invalidated/i.test(response.error)) detach();
            return;
          }
          void safeSend({ type: 'AMI_SHOW_WIDGET' });
        } catch (_error) {
          detach();
        }
      });
    } catch (_error) {
      detach();
    }
  }

  window.addEventListener(PING, onPing);
  window.addEventListener(SESSION_EVENT, onSession);

  try {
    if (isAlive()) {
      window.dispatchEvent(new CustomEvent(PONG));
    } else {
      detach();
    }
  } catch (_error) {
    detach();
  }
})();
