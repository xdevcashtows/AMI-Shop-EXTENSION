/** Shared helpers for content scripts / widget pages. */
(function (global) {
  /**
   * After an extension reload, Chromium invalidates old content-script worlds.
   * Touching chrome.runtime then throws "Extension context invalidated".
   * Never read chrome.runtime outside a try/catch.
   */
  function extensionAlive() {
    try {
      // Avoid optional chaining on chrome.runtime — some Chromium builds still throw.
      if (typeof chrome === 'undefined') return false;
      const runtime = chrome.runtime;
      if (!runtime) return false;
      const id = runtime.id;
      return typeof id === 'string' && id.length > 0;
    } catch (_error) {
      return false;
    }
  }

  function invalidatedResult(fallbackMessage) {
    return {
      ok: false,
      error: fallbackMessage || 'Extension was reloaded — refresh this tab'
    };
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      if (!extensionAlive()) {
        resolve(invalidatedResult());
        return;
      }
      try {
        chrome.runtime.sendMessage(message, (response) => {
          try {
            const err = chrome.runtime.lastError;
            if (err) {
              resolve(
                invalidatedResult(
                  /invalidated/i.test(err.message || '')
                    ? 'Extension was reloaded — refresh this tab'
                    : err.message
                )
              );
              return;
            }
            resolve(response ?? { ok: true });
          } catch (_error) {
            resolve(invalidatedResult());
          }
        });
      } catch (_error) {
        resolve(invalidatedResult());
      }
    });
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      if (!extensionAlive()) {
        resolve({});
        return;
      }
      try {
        chrome.storage.local.get(keys, (result) => {
          try {
            if (chrome.runtime.lastError) {
              resolve({});
              return;
            }
            resolve(result || {});
          } catch (_error) {
            resolve({});
          }
        });
      } catch (_error) {
        resolve({});
      }
    });
  }

  function storageSet(values) {
    return new Promise((resolve) => {
      if (!extensionAlive()) {
        resolve(false);
        return;
      }
      try {
        chrome.storage.local.set(values, () => {
          try {
            resolve(!chrome.runtime.lastError);
          } catch (_error) {
            resolve(false);
          }
        });
      } catch (_error) {
        resolve(false);
      }
    });
  }

  function onStorageChanged(listener) {
    if (!extensionAlive()) return () => {};
    try {
      const wrapped = (changes, area) => {
        try {
          if (!extensionAlive()) return;
          listener(changes, area);
        } catch (_error) {
          // ignore
        }
      };
      chrome.storage.onChanged.addListener(wrapped);
      return () => {
        try {
          chrome.storage.onChanged.removeListener(wrapped);
        } catch (_error) {
          // ignore
        }
      };
    } catch (_error) {
      return () => {};
    }
  }

  function onRuntimeMessage(listener) {
    if (!extensionAlive()) return () => {};
    try {
      const wrapped = (message, sender, sendResponse) => {
        try {
          if (!extensionAlive()) return;
          return listener(message, sender, sendResponse);
        } catch (_error) {
          return undefined;
        }
      };
      chrome.runtime.onMessage.addListener(wrapped);
      return () => {
        try {
          chrome.runtime.onMessage.removeListener(wrapped);
        } catch (_error) {
          // ignore
        }
      };
    } catch (_error) {
      return () => {};
    }
  }

  global.AmiChrome = {
    extensionAlive,
    sendMessage,
    storageGet,
    storageSet,
    onStorageChanged,
    onRuntimeMessage
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
