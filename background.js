const STORAGE_KEYS = {
  session: 'amiPartsBridgeSession',
  settings: 'amiPartsBridgeSettings',
  pendingLines: 'amiPartsBridgePendingLines'
};

const DEFAULT_API_BASE = 'http://localhost:8787';

function showWidgetOnTab(tabId) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: 'AMI_SHOW_WIDGET' }, () => {
    void chrome.runtime.lastError;
  });
}

function isOreillyUrl(url) {
  if (!url) return false;
  return (
    url.includes('firstcallonline.com') ||
    url.includes('oreillyauto.com')
  );
}

function showWidgetOnOreillyTabs() {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;
      if (isOreillyUrl(tab.url)) showWidgetOnTab(tab.id);
    }
  });
}

chrome.action.onClicked.addListener((tab) => {
  if (tab?.id == null) return;
  if (!isOreillyUrl(tab.url || '')) {
    // Widget only lives on O'Reilly / FirstCall pages.
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: 'AMI_TOGGLE_WIDGET' }, () => {
    void chrome.runtime.lastError;
  });
});

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

        // Fresh Order from O'Reilly / new session always starts with an empty shop cart.
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
            // Never carry pending scrapes into a newly opened FirstCall session.
            [STORAGE_KEYS.pendingLines]: sameSession ? pending : []
          },
          () => {
            showWidgetOnOreillyTabs();
            // Also push session to open O'Reilly tabs explicitly.
            chrome.tabs.query({}, (tabs) => {
              for (const tab of tabs) {
                if (!tab.id || !isOreillyUrl(tab.url || '')) continue;
                chrome.tabs.sendMessage(
                  tab.id,
                  {
                    type: 'AMI_SESSION_UPDATED',
                    session: next,
                    resetCart: !sameSession
                  },
                  () => {
                    void chrome.runtime.lastError;
                  }
                );
              }
            });
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
        sendResponse({ ok: true, payload });
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
    showWidgetOnOreillyTabs();
    sendResponse({ ok: true });
    return;
  }

  // Widget Refresh → content script re-fetches FirstCall miniquote.
  if (message.type === 'AMI_SCRAPE_NOW') {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: 'No tab for scrape' });
      return;
    }
    chrome.tabs.sendMessage(tabId, { type: 'AMI_SCRAPE_NOW' }, (response) => {
      if (chrome.runtime.lastError) {
        sendResponse({
          ok: false,
          error: chrome.runtime.lastError.message || 'Scrape failed'
        });
        return;
      }
      sendResponse(response ?? { ok: true });
    });
    return true;
  }
});
