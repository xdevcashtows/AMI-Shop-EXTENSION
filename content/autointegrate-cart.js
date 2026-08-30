(function () {
  const VENDOR = 'Auto Integrate';
  const ITEM_TYPE_LABOR = 2;
  const ITEM_TYPE_PART = 3;
  const Ami = globalThis.AmiChrome;

  /** @type {any[]} */
  let networkLines = [];
  /** @type {string} */
  let lastSentSignature = '';
  let dead = false;

  function markDead() {
    dead = true;
  }

  function parseMoney(value) {
    if (value == null || value === '') return undefined;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const cleaned = String(value).replace(/[^0-9.-]/g, '');
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function parseMaybeJson(body) {
    if (body && typeof body === 'object') return body;
    if (typeof body !== 'string') return null;
    const raw = body.trim();
    if (!raw || (raw[0] !== '{' && raw[0] !== '[')) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function isRepairOrderUrl(url) {
    return /\/RepairOrders\/\d+/i.test(String(url || ''));
  }

  function lineFromItem(item) {
    if (!item || item.isActive === false) return [];
    const type = Number(item.type);
    const pricing = asObject(item.pricing) || {};
    const partInfo = asObject(item.partInfo) || {};
    const description = String(
      item.description || item.serviceCodeInfo?.name || ''
    ).trim();
    if (!description) return [];

    const quantity = Number(pricing.quantity);
    const unitCost = parseMoney(pricing.unitCost);
    const total = parseMoney(pricing.total);
    const hours = parseMoney(pricing.time);
    const rate = parseMoney(pricing.rate);
    const externalId = item.id != null ? String(item.id) : undefined;

    if (type === ITEM_TYPE_LABOR) {
      const amount = total ?? unitCost ?? 0;
      return [
        {
          externalId,
          partNumber: '',
          description,
          quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
          cost: amount,
          sellPrice: amount,
          vendor: VENDOR,
          laborHours: hours && hours > 0 ? hours : undefined,
          laborRate: rate && rate > 0 ? rate : undefined,
          laborCategory: String(item.laborInfo?.correctionName || '').trim() || undefined,
          lineKind: 'labor'
        }
      ];
    }

    if (type === ITEM_TYPE_PART || type) {
      const amount = unitCost ?? total ?? 0;
      const partNumber = String(partInfo.partNumber || '').trim();
      return [
        {
          externalId,
          partNumber,
          description,
          brand: String(partInfo.manufacturer || '').trim() || undefined,
          quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
          cost: amount,
          sellPrice: amount,
          vendor: VENDOR,
          unit: 'pc.',
          lineKind: 'part'
        }
      ];
    }

    return [];
  }

  function ingestRepairOrder(payload) {
    const data = parseMaybeJson(payload);
    const result = asObject(data?.result) || asObject(data);
    const items = Array.isArray(result?.items) ? result.items : [];
    if (!result || !Array.isArray(result.items)) return false;
    const lines = [];
    for (const item of items) {
      lines.push(...lineFromItem(item));
    }
    networkLines = lines;
    void pushCartUpdate();
    return true;
  }

  function installNetworkHooks() {
    const inject = () => {
      try {
        if (!Ami?.extensionAlive()) return;
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('content/page-network-hook.js');
        script.async = false;
        script.onload = () => script.remove();
        (document.documentElement || document.head || document.body).appendChild(
          script
        );
      } catch {
        // ignore
      }
    };

    if (document.documentElement) inject();
    else document.addEventListener('DOMContentLoaded', inject, { once: true });

    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== 'ami-parts-bridge-network') return;
      if (data.kind && data.kind !== 'response') return;
      if (!isRepairOrderUrl(data.url)) return;
      ingestRepairOrder(data.body);
    });
  }

  async function pushCartUpdate(force = false) {
    if (dead) return;
    if (!Ami?.extensionAlive()) {
      markDead();
      return;
    }
    const signature = JSON.stringify(
      networkLines.map((line) => [
        line.externalId,
        line.lineKind,
        line.partNumber,
        line.description,
        line.quantity,
        line.cost,
        line.laborHours,
        line.laborRate
      ])
    );
    if (!force && signature === lastSentSignature) return;
    lastSentSignature = signature;
    const response = await Ami.sendMessage({
      type: 'AMI_UPDATE_CART',
      lines: networkLines,
      allowEmpty: true
    });
    if (response?.error && /invalidated|refresh this tab/i.test(response.error)) {
      markDead();
    }
  }

  function resetCart() {
    networkLines = [];
    lastSentSignature = '';
    void pushCartUpdate(true);
  }

  installNetworkHooks();

  window.addEventListener('ami-parts-bridge-reset-cart', resetCart);
  window.addEventListener('ami-parts-bridge-scrape-now', () => {
    void pushCartUpdate(true);
  });

  Ami?.onRuntimeMessage?.((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'AMI_SCRAPE_NOW') {
      void pushCartUpdate(true).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message.type === 'AMI_SESSION_UPDATED' && message.resetCart) {
      resetCart();
    }
  });
})();
