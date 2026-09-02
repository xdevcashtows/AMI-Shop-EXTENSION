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
    return /\/RepairOrders\/\d+(?!\d)(?!\/)/i.test(String(url || ''));
  }

  function pageRepairOrderId() {
    try {
      const jsId = new URLSearchParams(window.location.search).get('jsId');
      if (jsId && /^\d+$/.test(jsId)) return jsId;
    } catch {
      // ignore
    }
    const match = String(window.location.href).match(/[?&]jsId=(\d+)/i);
    return match ? match[1] : '';
  }

  function lineFromItem(item) {
    if (!item || item.isActive === false) return [];
    const type = Number(item.type);
    const pricing = asObject(item.pricing) || {};
    const partInfo = asObject(item.partInfo) || {};
    const serviceName = String(item.serviceCodeInfo?.name || '').trim();
    const correction = String(
      item.laborInfo?.correctionName || item.description || ''
    ).trim();
    const partDescription = String(item.description || serviceName || '').trim();
    const quantity = Number(pricing.quantity);
    const unitCost = parseMoney(pricing.unitCost);
    const total = parseMoney(pricing.total);
    const hours = parseMoney(pricing.time);
    const rate = parseMoney(pricing.rate);
    const externalId = item.id != null ? String(item.id) : undefined;

    if (type === ITEM_TYPE_LABOR) {
      const description =
        serviceName && correction && serviceName !== correction
          ? `${serviceName} — ${correction}`
          : correction || serviceName;
      if (!description) return [];
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
          laborCategory: correction || serviceName || undefined,
          lineKind: 'labor'
        }
      ];
    }

    if (type === ITEM_TYPE_PART || type) {
      if (!partDescription) return [];
      const amount = unitCost ?? total ?? 0;
      const partNumber = String(partInfo.partNumber || '').trim();
      return [
        {
          externalId,
          partNumber,
          description: partDescription,
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
    return true;
  }

  function requestCachedRepairOrder() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        resolve(networkLines.length > 0);
      };
      function onMessage(event) {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== 'ami-parts-bridge-repair-order-cache') {
          return;
        }
        if (data.body) ingestRepairOrder(data.body);
        finish();
      }
      window.addEventListener('message', onMessage);
      window.postMessage(
        {
          source: 'ami-parts-bridge-read-repair-order',
          jsId: pageRepairOrderId()
        },
        '*'
      );
      window.setTimeout(finish, 5000);
    });
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function ownText(el) {
    if (!el) return '';
    return Array.from(el.childNodes)
      .filter((node) => node.nodeType === 3)
      .map((node) => normalizeText(node.textContent))
      .filter(Boolean)
      .join(' ');
  }

  function leafText(el) {
    const own = ownText(el);
    if (own) return own;
    if (el && el.children && el.children.length === 0) {
      return normalizeText(el.textContent);
    }
    return '';
  }

  function findItemCards() {
    const headings = Array.from(
      document.querySelectorAll('h1, h2, h3, h4, h5, h6, div, span, p, strong, label')
    ).filter((el) => {
      const text = leafText(el) || normalizeText(el.textContent);
      return (
        /^(LABOR|PART)\b/i.test(text) &&
        text.length < 140 &&
        (el.children.length === 0 || leafText(el))
      );
    });
    const cards = [];
    const seen = new Set();
    headings.forEach((heading) => {
      let node = heading;
      for (let i = 0; i < 8 && node; i += 1) {
        const text = normalizeText(node.textContent);
        const looksLikeCard =
          /unit cost/i.test(text) ||
          (/\bedit\b/i.test(text) && /\bremove\b/i.test(text));
        if (looksLikeCard && node.innerText && node.innerText.length < 4000) {
          if (!seen.has(node)) {
            seen.add(node);
            cards.push({ heading, root: node });
          }
          return;
        }
        node = node.parentElement;
      }
    });
    return cards;
  }

  function readLabeledFields(root) {
    /** @type {Record<string, string>} */
    const fields = {};
    const labels = Array.from(root.querySelectorAll('*')).filter((el) => {
      const text = leafText(el);
      return /^(correction|cause|hrs|\$\/hr|unit cost|description|part number|manufacturer|qty|authorization status)$/i.test(
        text
      );
    });
    labels.forEach((label) => {
      const key = leafText(label);
      let value = '';
      const next = label.nextElementSibling;
      if (next) value = normalizeText(next.textContent);
      if (!value && label.parentElement) {
        const siblings = Array.from(label.parentElement.children);
        const index = siblings.indexOf(label);
        if (index >= 0 && siblings[index + 1]) {
          value = normalizeText(siblings[index + 1].textContent);
        }
      }
      if (value && value !== key) fields[key.toLowerCase()] = value;
    });
    return fields;
  }

  function scrapeDom() {
    const cards = findItemCards();
    /** @type {any[]} */
    const lines = [];
    cards.forEach((card, index) => {
      const title = leafText(card.heading) || normalizeText(card.heading.textContent);
      const kind = /^LABOR\b/i.test(title)
        ? 'labor'
        : /^PART\b/i.test(title)
          ? 'part'
          : '';
      if (!kind) return;
      const fields = readLabeledFields(card.root);
      const headingName = title.replace(/^(LABOR|PART)\s*[-–:]\s*/i, '').trim();
      if (kind === 'labor') {
        const correction = fields.correction || '';
        const hours = parseMoney(fields.hrs);
        const rate = parseMoney(fields['$/hr']);
        const cost =
          parseMoney(fields['unit cost']) ??
          (hours && rate ? hours * rate : undefined);
        const description =
          headingName && correction && headingName !== correction
            ? `${headingName} — ${correction}`
            : headingName || correction;
        if (!description || (!(cost > 0) && !(hours > 0))) return;
        lines.push({
          externalId: `autointegrate-dom-${index}-labor`,
          partNumber: '',
          description,
          quantity: 1,
          cost: cost ?? 0,
          sellPrice: cost ?? 0,
          vendor: VENDOR,
          laborHours: hours && hours > 0 ? hours : undefined,
          laborRate: rate && rate > 0 ? rate : undefined,
          laborCategory: correction || headingName || undefined,
          lineKind: 'labor'
        });
        return;
      }
      const partNumber = String(fields['part number'] || '').trim();
      const description = fields.description || headingName;
      const quantity = Number(fields.qty);
      const cost = parseMoney(fields['unit cost']);
      if (!description || (!(cost > 0) && !partNumber)) return;
      lines.push({
        externalId: `autointegrate-dom-${index}-part`,
        partNumber,
        description,
        brand: fields.manufacturer || undefined,
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
        cost: cost ?? 0,
        sellPrice: cost ?? 0,
        vendor: VENDOR,
        unit: 'pc.',
        lineKind: 'part'
      });
    });
    if (!lines.length) return false;
    networkLines = lines;
    return true;
  }

  async function extractNow() {
    await requestCachedRepairOrder();
    if (!networkLines.length) {
      await wait(600);
      await requestCachedRepairOrder();
    }
    if (!networkLines.length) {
      scrapeDom();
    }
    if (networkLines.length) {
      await pushCartUpdate(true);
    }
    return networkLines;
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
    void extractNow();
  });

  Ami?.onRuntimeMessage?.((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'AMI_SCRAPE_NOW') {
      void extractNow().then((lines) =>
        sendResponse({
          ok: true,
          count: lines.length,
          lines
        })
      );
      return true;
    }
    if (message.type === 'AMI_SESSION_UPDATED' && message.resetCart) {
      resetCart();
    }
  });
})();
