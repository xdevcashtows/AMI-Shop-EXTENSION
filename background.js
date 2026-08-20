const STORAGE_KEYS = {
  session: 'amiPartsBridgeSession',
  settings: 'amiPartsBridgeSettings',
  pendingLines: 'amiPartsBridgePendingLines'
};

const DEFAULT_API_BASE = 'http://localhost:8787';

function isOreillyUrl(url) {
  if (!url) return false;
  return (
    url.includes('firstcallonline.com') ||
    url.includes('oreillyauto.com')
  );
}

function isNapaUrl(url) {
  if (!url) return false;
  return url.includes('napaprolink.com');
}

function isWebEstUrl(url) {
  if (!url) return false;
  return url.includes('web-est.com');
}

function isSupplierUrl(url) {
  return isOreillyUrl(url) || isNapaUrl(url) || isWebEstUrl(url);
}

function urlMatchesSupplier(url, supplier) {
  if (supplier === 'napa') return isNapaUrl(url);
  if (supplier === 'webest') return isWebEstUrl(url);
  if (supplier === 'oreilly') return isOreillyUrl(url);
  return isSupplierUrl(url);
}

function getStoredSession() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEYS.session], (result) => {
      resolve(result[STORAGE_KEYS.session] || null);
    });
  });
}

function querySupplierTabs() {
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      resolve(
        (tabs || []).filter((tab) => tab.id != null && isSupplierUrl(tab.url || ''))
      );
    });
  });
}

async function findSupplierTabId(preferredTabId) {
  if (preferredTabId != null) {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (tab?.id != null && isSupplierUrl(tab.url || '')) return tab.id;
    } catch {
      // fall through
    }
  }

  const supplierTabs = await querySupplierTabs();
  if (!supplierTabs.length) return null;

  const session = await getStoredSession();
  const matching = session?.supplier
    ? supplierTabs.filter((tab) => urlMatchesSupplier(tab.url || '', session.supplier))
    : supplierTabs;
  const pool = matching.length ? matching : supplierTabs;
  const active = pool.find((tab) => tab.active);
  return (active || pool[0]).id ?? null;
}

function openSidePanelForTab(tabId) {
  if (tabId == null || !chrome.sidePanel?.open) return;
  try {
    void chrome.sidePanel.open({ tabId }).catch(() => {
      // May require a user gesture; toolbar icon still opens the panel.
    });
  } catch {
    // ignore
  }
}

async function openSidePanelOnSupplierTabs(preferredTabId) {
  const tabId = await findSupplierTabId(preferredTabId);
  if (tabId != null) {
    openSidePanelForTab(tabId);
    return;
  }
  const supplierTabs = await querySupplierTabs();
  for (const tab of supplierTabs) {
    openSidePanelForTab(tab.id);
  }
}

function notifySupplierTabs(message) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id || !isSupplierUrl(tab.url || '')) continue;
      chrome.tabs.sendMessage(tab.id, message, () => {
        void chrome.runtime.lastError;
      });
    }
  });
}

function sendToSupplierTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError.message || 'Supplier tab not ready'
        });
        return;
      }
      resolve(response ?? { ok: true });
    });
  });
}

// Open the native side panel when the toolbar icon is clicked.
try {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
} catch {
  // ignore
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'AMI_GET_SESSION') {
    chrome.storage.local.get([STORAGE_KEYS.session, STORAGE_KEYS.settings], (result) => {
      sendResponse({
        session: result[STORAGE_KEYS.session] || null,
        settings: result[STORAGE_KEYS.settings] || { apiBaseUrl: DEFAULT_API_BASE }
      });
    });
    return true;
  }

  if (message.type === 'AMI_SET_SESSION') {
    const session = message.session;
    if (!session) {
      sendResponse({ ok: false, error: 'Missing session' });
      return;
    }
    chrome.storage.local.get(
      [STORAGE_KEYS.settings, STORAGE_KEYS.pendingLines, STORAGE_KEYS.session],
      (result) => {
        const settings = result[STORAGE_KEYS.settings] || {};
        const previous = result[STORAGE_KEYS.session] || null;
        const pending = Array.isArray(result[STORAGE_KEYS.pendingLines])
          ? result[STORAGE_KEYS.pendingLines]
          : [];
        const apiBaseUrl = settings.apiBaseUrl || DEFAULT_API_BASE;
        const incomingLines = Array.isArray(session.lines) ? session.lines : [];

        const sameSession =
          previous && previous.sessionId && previous.sessionId === session.sessionId;

        // Fresh Order from supplier / new session always starts with an empty shop cart.
        // Only keep lines if this is an explicit update to the same sessionId with lines provided.
        const lines = incomingLines.length
          ? incomingLines
          : sameSession
            ? previous.lines || []
            : [];

        const next = {
          ...session,
          apiBaseUrl: session.apiBaseUrl || apiBaseUrl,
          lines,
          updatedAt: new Date().toISOString()
        };
        chrome.storage.local.set(
          {
            [STORAGE_KEYS.session]: next,
            // Never carry pending scrapes into a newly opened supplier session.
            [STORAGE_KEYS.pendingLines]: sameSession ? pending : []
          },
          () => {
            notifySupplierTabs({
              type: 'AMI_SESSION_UPDATED',
              session: next,
              resetCart: !sameSession
            });
            void openSidePanelOnSupplierTabs(sender.tab?.id);
            sendResponse({ ok: true, session: next });
          }
        );
      }
    );
    return true;
  }

  if (message.type === 'AMI_UPDATE_CART') {
    chrome.storage.local.get([STORAGE_KEYS.session], (result) => {
      const session = result[STORAGE_KEYS.session];
      const lines = Array.isArray(message.lines) ? message.lines : [];
      // Explicit clears / O'Reilly sync / widget ✕ must be allowed to empty the cart.
      const allowEmpty = message.allowEmpty === true;

      // Keep scraped lines even before a CRM session exists.
      if (!session) {
        chrome.storage.local.set({ [STORAGE_KEYS.pendingLines]: lines }, () => {
          sendResponse({ ok: true, pending: true, lines });
        });
        return;
      }

      // Don't wipe a populated cart with an accidental empty scrape —
      // unless the caller explicitly allows empty (remove / authoritative sync).
      if (
        !allowEmpty &&
        lines.length === 0 &&
        Array.isArray(session.lines) &&
        session.lines.length > 0
      ) {
        sendResponse({ ok: true, session, ignoredEmpty: true });
        return;
      }

      const next = {
        ...session,
        lines,
        updatedAt: new Date().toISOString()
      };
      chrome.storage.local.set({ [STORAGE_KEYS.session]: next }, () => {
        sendResponse({ ok: true, session: next });
      });
    });
    return true;
  }

  if (message.type === 'AMI_CLEAR_SESSION') {
    chrome.storage.local.remove(
      [STORAGE_KEYS.session, STORAGE_KEYS.pendingLines],
      () => {
        sendResponse({ ok: true });
      }
    );
    return true;
  }

  if (message.type === 'AMI_TRANSFER') {
    chrome.storage.local.get([STORAGE_KEYS.session, STORAGE_KEYS.settings], async (result) => {
      const session = result[STORAGE_KEYS.session];
      const settings = result[STORAGE_KEYS.settings] || {};
      if (!session) {
        sendResponse({ ok: false, error: 'No active session' });
        return;
      }
      const lines = Array.isArray(message.lines)
        ? message.lines
        : session.lines || [];
      if (!lines.length) {
        sendResponse({ ok: false, error: 'Cart is empty' });
        return;
      }

      const apiBase = (settings.apiBaseUrl || session.apiBaseUrl || DEFAULT_API_BASE).replace(
        /\/$/,
        ''
      );

      try {
        const response = await fetch(
          `${apiBase}/api/parts-bridge/session/${encodeURIComponent(session.sessionId)}/parts`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              bridgeToken: session.bridgeToken,
              supplier: session.supplier,
              jobCardId: session.jobCardId,
              jobNumber: session.jobNumber,
              vehicle: session.vehicle,
              lines,
              transferredAt: new Date().toISOString()
            })
          }
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          sendResponse({
            ok: false,
            error: payload.error || `Transfer failed (${response.status})`
          });
          return;
        }
        const cleared = {
          ...session,
          lines: [],
          updatedAt: new Date().toISOString()
        };
        chrome.storage.local.set({ [STORAGE_KEYS.session]: cleared }, () => {
          sendResponse({ ok: true, payload, session: cleared });
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Transfer failed'
        });
      }
    });
    return true;
  }

  if (message.type === 'AMI_SHOW_WIDGET') {
    void openSidePanelOnSupplierTabs(sender.tab?.id);
    sendResponse({ ok: true, sidePanel: true });
    return true;
  }

  if (message.type === 'AMI_FILL_VIN') {
    void (async () => {
      const tabId = await findSupplierTabId(sender.tab?.id);
      if (tabId == null) {
        sendResponse({
          ok: false,
          error: 'Open a NAPA, O\'Reilly, or WebEst tab first'
        });
        return;
      }
      sendResponse(await sendToSupplierTab(tabId, { type: 'AMI_FILL_VIN' }));
    })();
    return true;
  }

  if (message.type === 'AMI_REMOVE_ESTIMATE_LINE') {
    void (async () => {
      const tabId = await findSupplierTabId(sender.tab?.id);
      if (tabId == null) {
        sendResponse({
          ok: false,
          error: 'Open a WebEst tab first'
        });
        return;
      }
      const result = await sendToSupplierTab(tabId, {
        type: 'AMI_REMOVE_ESTIMATE_LINE',
        externalId: message.externalId,
        estimateLineId: message.estimateLineId
      });
      if (result?.ok && Array.isArray(result.lines)) {
        const stored = await getStoredSession();
        if (stored) {
          const next = {
            ...stored,
            lines: result.lines,
            updatedAt: new Date().toISOString()
          };
          chrome.storage.local.set({ [STORAGE_KEYS.session]: next }, () => {
            sendResponse({ ok: true, session: next, lines: result.lines });
          });
          return;
        }
      }
      sendResponse(result);
    })();
    return true;
  }

  // Side panel Refresh → content script re-fetches supplier cart snapshot.
  if (message.type === 'AMI_SCRAPE_NOW') {
    void (async () => {
      const tabId = await findSupplierTabId(sender.tab?.id);
      if (tabId == null) {
        sendResponse({
          ok: false,
          error: 'Open a NAPA, O\'Reilly, or WebEst tab first'
        });
        return;
      }
      // Ping cart scripts + supplier-bridge (both listen for AMI_SCRAPE_NOW).
      sendResponse(await sendToSupplierTab(tabId, { type: 'AMI_SCRAPE_NOW' }));
    })();
    return true;
  }
});
