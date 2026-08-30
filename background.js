const STORAGE_KEYS = {
  sessionsByTab: 'amiPartsBridgeSessionsByTab',
  settings: 'amiPartsBridgeSettings',
  pendingByTab: 'amiPartsBridgePendingLinesByTab',
  // Legacy singleton keys — removed on startup so they cannot fight the tab map.
  legacySession: 'amiPartsBridgeSession',
  legacyPending: 'amiPartsBridgePendingLines'
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

function isAutoIntegrateUrl(url) {
  if (!url) return false;
  return (
    url.includes('online.autointegrate.com') ||
    url.includes('api.autointegrate.com')
  );
}

function isERepairUrl(url) {
  if (!url) return false;
  return url.includes('erepair.wheels.com');
}

function isSupplierUrl(url) {
  return (
    isOreillyUrl(url) ||
    isNapaUrl(url) ||
    isWebEstUrl(url) ||
    isAutoIntegrateUrl(url) ||
    isERepairUrl(url)
  );
}

function tabKey(tabId) {
  return String(tabId);
}

function senderIsSupplierTab(sender) {
  return Boolean(sender?.tab?.id != null && isSupplierUrl(sender.tab.url || ''));
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => {
      resolve(result || {});
    });
  });
}

function storageSet(values) {
  return new Promise((resolve) => {
    chrome.storage.local.set(values, () => resolve());
  });
}

/** Serialize read-modify-write so two supplier tabs cannot clobber each other's carts. */
let tabStateChain = Promise.resolve();

function enqueueTabState(task) {
  const run = tabStateChain.then(task, task);
  tabStateChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function mutateTabState(mutator) {
  return enqueueTabState(async () => {
    const result = await storageGet([
      STORAGE_KEYS.sessionsByTab,
      STORAGE_KEYS.pendingByTab
    ]);
    const ctx = {
      sessions: asObject(result[STORAGE_KEYS.sessionsByTab]),
      pending: asObject(result[STORAGE_KEYS.pendingByTab]),
      result: undefined
    };
    await mutator(ctx);
    await storageSet({
      [STORAGE_KEYS.sessionsByTab]: ctx.sessions,
      [STORAGE_KEYS.pendingByTab]: ctx.pending
    });
    return ctx.result;
  });
}

async function getSessionForTab(tabId) {
  if (tabId == null) return null;
  const result = await storageGet([STORAGE_KEYS.sessionsByTab]);
  return asObject(result[STORAGE_KEYS.sessionsByTab])[tabKey(tabId)] || null;
}

function moveTabState(fromTabId, toTabId) {
  if (fromTabId == null || toTabId == null || fromTabId === toTabId) {
    return Promise.resolve();
  }
  return mutateTabState((ctx) => {
    const fromKey = tabKey(fromTabId);
    const toKey = tabKey(toTabId);
    if (ctx.sessions[fromKey]) {
      ctx.sessions[toKey] = ctx.sessions[fromKey];
      delete ctx.sessions[fromKey];
    }
    if (ctx.pending[fromKey]) {
      ctx.pending[toKey] = ctx.pending[fromKey];
      delete ctx.pending[fromKey];
    }
  });
}

function deleteTabState(tabId) {
  if (tabId == null) return Promise.resolve();
  return mutateTabState((ctx) => {
    const key = tabKey(tabId);
    delete ctx.sessions[key];
    delete ctx.pending[key];
  });
}

function pruneClosedTabState() {
  return mutateTabState(async (ctx) => {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({});
    } catch {
      tabs = [];
    }
    const live = new Set((tabs || []).map((tab) => tabKey(tab.id)));
    for (const key of Object.keys(ctx.sessions)) {
      if (!live.has(key)) delete ctx.sessions[key];
    }
    for (const key of Object.keys(ctx.pending)) {
      if (!live.has(key)) delete ctx.pending[key];
    }
  });
}

async function getTab(tabId) {
  if (tabId == null) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

/**
 * Content scripts always bind to their own tab.
 * The side panel must pass tabId and it must still be a live supplier tab.
 * Never fall back to "first supplier tab" — that is what mixed up job carts.
 */
async function resolveSupplierTabId(message, sender) {
  if (senderIsSupplierTab(sender)) {
    return sender.tab.id;
  }
  const requested =
    message?.tabId != null && Number.isFinite(Number(message.tabId))
      ? Number(message.tabId)
      : null;
  if (requested == null) return null;
  const tab = await getTab(requested);
  if (tab?.id != null && isSupplierUrl(tab.url || '')) return tab.id;
  return null;
}

function requestedTabId(message, sender) {
  if (sender?.tab?.id != null) return sender.tab.id;
  if (message?.tabId != null && Number.isFinite(Number(message.tabId))) {
    return Number(message.tabId);
  }
  return null;
}

async function syncSidePanelForTab(tab) {
  if (tab?.id == null || !chrome.sidePanel?.setOptions) return;
  const enabled = isSupplierUrl(tab.url || '');
  try {
    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: 'sidepanel/index.html',
      enabled
    });
  } catch {
    // ignore
  }
}

function openSidePanelForTab(tabId) {
  if (tabId == null || !chrome.sidePanel?.open) return;
  try {
    void (async () => {
      const tab = await getTab(tabId);
      if (tab && isSupplierUrl(tab.url || '')) {
        await syncSidePanelForTab(tab);
      } else if (chrome.sidePanel.setOptions) {
        try {
          await chrome.sidePanel.setOptions({
            tabId,
            path: 'sidepanel/index.html',
            enabled: true
          });
        } catch {
          // ignore
        }
      }
      await chrome.sidePanel.open({ tabId }).catch(() => {
        // May require a user gesture; toolbar icon still opens the panel.
      });
    })();
  } catch {
    // ignore
  }
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

function notifyTab(tabId, message) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, message, () => {
    void chrome.runtime.lastError;
  });
}

try {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
} catch {
  // ignore
}

void chrome.storage.local.remove([
  STORAGE_KEYS.legacySession,
  STORAGE_KEYS.legacyPending
]);
void pruneClosedTabState();
void chrome.tabs.query({}).then((tabs) => {
  for (const tab of tabs || []) {
    void syncSidePanelForTab(tab);
  }
}).catch(() => {});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    void syncSidePanelForTab(tab || { id: tabId, url: changeInfo.url || '' });
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  void syncSidePanelForTab(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void deleteTabState(tabId);
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void moveTabState(removedTabId, addedTabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'AMI_GET_SESSION') {
    void (async () => {
      const tabId = requestedTabId(message, sender);
      const tab = await getTab(tabId);
      const isSupplierTab = Boolean(tab && isSupplierUrl(tab.url || ''));
      const session = tabId != null ? await getSessionForTab(tabId) : null;
      const result = await storageGet([STORAGE_KEYS.settings]);
      sendResponse({
        session,
        tabId,
        isSupplierTab,
        settings: result[STORAGE_KEYS.settings] || { apiBaseUrl: DEFAULT_API_BASE }
      });
    })();
    return true;
  }

  if (message.type === 'AMI_SET_SESSION') {
    const session = message.session;
    if (!session) {
      sendResponse({ ok: false, error: 'Missing session' });
      return;
    }
    void (async () => {
      // CRM CustomEvent is only a heads-up. Bind on the supplier-tab hash handshake
      // so a second job cannot overwrite the first job's window.
      if (!senderIsSupplierTab(sender)) {
        sendResponse({ ok: true, deferred: true });
        return;
      }

      const tabId = sender.tab.id;
      const result = await storageGet([STORAGE_KEYS.settings]);
      const settings = result[STORAGE_KEYS.settings] || {};
      const apiBaseUrl = settings.apiBaseUrl || DEFAULT_API_BASE;
      const incomingLines = Array.isArray(session.lines) ? session.lines : [];
      const key = tabKey(tabId);

      const next = await mutateTabState((ctx) => {
        const previous = ctx.sessions[key] || null;
        const sameSession =
          previous && previous.sessionId && previous.sessionId === session.sessionId;
        const pending = Array.isArray(ctx.pending[key]) ? ctx.pending[key] : [];
        if (!sameSession) delete ctx.pending[key];

        const lines = incomingLines.length
          ? incomingLines
          : sameSession
            ? previous.lines || []
            : pending;

        const bound = {
          ...session,
          apiBaseUrl: session.apiBaseUrl || apiBaseUrl,
          lines,
          partSuppliesEnabled: sameSession
            ? previous.partSuppliesEnabled !== false
            : true,
          transferredAt: sameSession ? previous.transferredAt || null : null,
          updatedAt: new Date().toISOString()
        };
        ctx.sessions[key] = bound;
        ctx.result = { session: bound, resetCart: !sameSession };
      });

      if (!next?.session) {
        sendResponse({ ok: false, error: 'Could not bind session to this tab' });
        return;
      }

      notifyTab(tabId, {
        type: 'AMI_SESSION_UPDATED',
        session: next.session,
        resetCart: next.resetCart
      });
      openSidePanelForTab(tabId);
      sendResponse({ ok: true, session: next.session, tabId });
    })();
    return true;
  }

  if (message.type === 'AMI_UPDATE_CART') {
    void (async () => {
      const tabId = await resolveSupplierTabId(message, sender);
      const lines = Array.isArray(message.lines) ? message.lines : [];
      const allowEmpty = message.allowEmpty === true;

      if (tabId == null) {
        sendResponse({ ok: false, error: 'No supplier tab for this cart update' });
        return;
      }

      const key = tabKey(tabId);
      const outcome = await mutateTabState((ctx) => {
        const session = ctx.sessions[key] || null;
        if (!session) {
          if (!Array.isArray(lines) || lines.length === 0) {
            delete ctx.pending[key];
          } else {
            ctx.pending[key] = lines;
          }
          ctx.result = { ok: true, pending: true, lines, tabId };
          return;
        }

        if (
          !allowEmpty &&
          lines.length === 0 &&
          Array.isArray(session.lines) &&
          session.lines.length > 0
        ) {
          ctx.result = { ok: true, session, ignoredEmpty: true, tabId };
          return;
        }

        const nextSession = {
          ...session,
          lines,
          transferredAt: lines.length > 0 ? null : session.transferredAt || null,
          updatedAt: new Date().toISOString()
        };
        ctx.sessions[key] = nextSession;
        ctx.result = { ok: true, session: nextSession, tabId };
      });
      sendResponse(outcome || { ok: false, error: 'Cart update failed', tabId });
    })();
    return true;
  }

  if (message.type === 'AMI_SET_CART_OPTION') {
    void (async () => {
      const tabId = await resolveSupplierTabId(message, sender);
      if (tabId == null) {
        sendResponse({ ok: false, error: 'No supplier tab for this option' });
        return;
      }
      const outcome = await mutateTabState((ctx) => {
        const key = tabKey(tabId);
        const session = ctx.sessions[key] || null;
        if (!session) {
          ctx.result = { ok: false, error: 'No active session for this tab' };
          return;
        }
        const nextSession = {
          ...session,
          partSuppliesEnabled: message.partSuppliesEnabled !== false,
          updatedAt: new Date().toISOString()
        };
        ctx.sessions[key] = nextSession;
        ctx.result = { ok: true, session: nextSession, tabId };
      });
      sendResponse(outcome || { ok: false, error: 'Could not update option' });
    })();
    return true;
  }

  if (message.type === 'AMI_CLEAR_SESSION') {
    void (async () => {
      const tabId = await resolveSupplierTabId(message, sender);
      if (tabId == null) {
        sendResponse({ ok: false, error: 'No supplier tab to clear' });
        return;
      }
      await deleteTabState(tabId);
      notifyTab(tabId, {
        type: 'AMI_SESSION_UPDATED',
        session: null,
        resetCart: true
      });
      sendResponse({ ok: true, tabId });
    })();
    return true;
  }

  if (message.type === 'AMI_TRANSFER') {
    void (async () => {
      const tabId = await resolveSupplierTabId(message, sender);
      if (tabId == null) {
        sendResponse({
          ok: false,
          error: "Open a NAPA, O'Reilly, WebEst, Auto Integrate, or eRepair tab first"
        });
        return;
      }

      const session = await getSessionForTab(tabId);
      const result = await storageGet([STORAGE_KEYS.settings]);
      const settings = result[STORAGE_KEYS.settings] || {};
      if (!session) {
        sendResponse({ ok: false, error: 'No active session for this tab' });
        return;
      }
      const lines = Array.isArray(message.lines)
        ? message.lines
        : session.lines || [];
      if (!lines.length) {
        sendResponse({ ok: false, error: 'Cart is empty' });
        return;
      }

      const apiBase = (
        settings.apiBaseUrl ||
        session.apiBaseUrl ||
        DEFAULT_API_BASE
      ).replace(/\/$/, '');

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
        const transferredAt = new Date().toISOString();
        const cleared = await mutateTabState((ctx) => {
          const current = ctx.sessions[tabKey(tabId)];
          if (!current || current.sessionId !== session.sessionId) {
            ctx.result = {
              ...session,
              lines: [],
              transferredAt,
              updatedAt: transferredAt
            };
            return;
          }
          const nextSession = {
            ...current,
            lines: [],
            transferredAt,
            updatedAt: transferredAt
          };
          ctx.sessions[tabKey(tabId)] = nextSession;
          ctx.result = nextSession;
        });
        sendResponse({ ok: true, payload, session: cleared, tabId });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Transfer failed'
        });
      }
    })();
    return true;
  }

  if (message.type === 'AMI_SHOW_WIDGET') {
    if (senderIsSupplierTab(sender)) {
      openSidePanelForTab(sender.tab.id);
    }
    sendResponse({ ok: true, sidePanel: true });
    return true;
  }

  if (message.type === 'AMI_FILL_VIN') {
    void (async () => {
      const tabId = await resolveSupplierTabId(message, sender);
      if (tabId == null) {
        sendResponse({
          ok: false,
          error: "Open a NAPA, O'Reilly, WebEst, Auto Integrate, or eRepair tab first"
        });
        return;
      }
      sendResponse(await sendToSupplierTab(tabId, { type: 'AMI_FILL_VIN' }));
    })();
    return true;
  }

  if (message.type === 'AMI_REMOVE_ESTIMATE_LINE') {
    void (async () => {
      const tabId = await resolveSupplierTabId(message, sender);
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
        const next = await mutateTabState((ctx) => {
          const stored = ctx.sessions[tabKey(tabId)];
          if (!stored) {
            ctx.result = null;
            return;
          }
          const updated = {
            ...stored,
            lines: result.lines,
            transferredAt:
              result.lines.length > 0 ? null : stored.transferredAt || null,
            updatedAt: new Date().toISOString()
          };
          ctx.sessions[tabKey(tabId)] = updated;
          ctx.result = updated;
        });
        if (next) {
          sendResponse({ ok: true, session: next, lines: result.lines, tabId });
          return;
        }
      }
      sendResponse(result);
    })();
    return true;
  }

  if (message.type === 'AMI_SCRAPE_NOW') {
    void (async () => {
      const tabId = await resolveSupplierTabId(message, sender);
      if (tabId == null) {
        sendResponse({
          ok: false,
          error: "Open a NAPA, O'Reilly, WebEst, Auto Integrate, or eRepair tab first"
        });
        return;
      }
      sendResponse(await sendToSupplierTab(tabId, { type: 'AMI_SCRAPE_NOW' }));
    })();
    return true;
  }
});
