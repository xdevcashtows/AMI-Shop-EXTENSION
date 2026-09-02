(function () {
  const VENDOR = 'eRepair';
  const Ami = globalThis.AmiChrome;

  /** @type {any[]} */
  let networkLines = [];
  /** @type {string} */
  let lastSentSignature = '';
  let dead = false;

  function markDead() {
    dead = true;
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseMoney(value) {
    if (value == null || value === '') return undefined;
    const raw = normalizeText(value);
    if (!raw || /^n\/?c$/i.test(raw) || /^no charge$/i.test(raw)) return 0;
    if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(raw)) return undefined;
    if (/[()]/.test(raw) && raw.replace(/\D/g, '').length >= 10) return undefined;
    const cleaned = raw.replace(/[^0-9.-]/g, '');
    if (!cleaned || cleaned === '-' || cleaned === '.') return undefined;
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed) || Math.abs(parsed) > 100000) return undefined;
    return parsed;
  }

  function ownRows(table) {
    return Array.from(
      table.querySelectorAll(':scope > tbody > tr, :scope > thead > tr, :scope > tr')
    );
  }

  function ownCells(row) {
    return Array.from(row.querySelectorAll(':scope > th, :scope > td'));
  }

  function findItemsTable(root) {
    return (
      root.querySelector('table.itemsTable') ||
      Array.from(root.querySelectorAll('table')).find((table) => {
        const titles = Array.from(table.querySelectorAll('td.listTitle, th.listTitle'))
          .map((cell) => normalizeText(cell.textContent).toLowerCase());
        return (
          titles.includes('product description') &&
          titles.includes('product code') &&
          titles.some((title) => title.includes('labor'))
        );
      }) ||
      null
    );
  }

  function isHeaderRow(row) {
    const cells = ownCells(row);
    if (!cells.length) return false;
    if (cells.some((cell) => cell.classList.contains('listTitle'))) {
      const text = normalizeText(row.textContent).toLowerCase();
      return text.includes('product description') && text.includes('product code');
    }
    return false;
  }

  function isCategoryRow(row) {
    const header = row.querySelector('td.listTextHeader, th.listTextHeader');
    return Boolean(header);
  }

  function isTotalsRow(row) {
    const text = normalizeText(row.textContent).toLowerCase();
    return /^(order total|tax total|grand total|note:)/.test(text) ||
      text.includes('order total') ||
      text.includes('tax total') ||
      text.includes('grand total') ||
      text.includes('n/c (no charge)');
  }

  function linesFromItemRow(row, index, category) {
    const cells = ownCells(row);
    if (cells.length < 7) return [];

    const description = normalizeText(cells[0]?.textContent);
    const productCode = normalizeText(cells[1]?.textContent);
    const stock = normalizeText(cells[3]?.textContent);
    const qty = Number(normalizeText(cells[4]?.textContent)) || 1;
    const unit = normalizeText(cells[5]?.textContent) || 'Each';
    const partsAmount = parseMoney(cells[6]?.textContent);
    const laborAmount = parseMoney(cells[7]?.textContent);
    if (!description || !/^\d{3,8}$/.test(productCode)) return [];
    if (!(partsAmount > 0) && !(laborAmount > 0)) return [];

    /** @type {any[]} */
    const lines = [];
    if (partsAmount > 0) {
      lines.push({
        externalId: `erepair-${index}-part`,
        partNumber: productCode,
        description,
        brand: category || undefined,
        quantity: qty > 0 ? qty : 1,
        cost: partsAmount,
        sellPrice: partsAmount,
        vendor: VENDOR,
        storeName: stock || undefined,
        unit,
        group: category || undefined,
        lineKind: 'part'
      });
    }
    if (laborAmount > 0) {
      lines.push({
        externalId: `erepair-${index}-labor`,
        partNumber: '',
        description,
        brand: category || undefined,
        quantity: 1,
        cost: laborAmount,
        sellPrice: laborAmount,
        vendor: VENDOR,
        laborCategory: category || 'Labor',
        group: category || undefined,
        lineKind: 'labor'
      });
    }
    return lines;
  }

  function parseOrderDetailRoot(root) {
    const table = findItemsTable(root);
    if (!table) return null;
    const rows = ownRows(table);
    /** @type {any[]} */
    const lines = [];
    let category = '';
    rows.forEach((row, index) => {
      if (isHeaderRow(row) || isTotalsRow(row)) return;
      if (isCategoryRow(row)) {
        category = normalizeText(
          row.querySelector('td.listTextHeader, th.listTextHeader')?.textContent
        );
        return;
      }
      lines.push(...linesFromItemRow(row, index, category));
    });
    return lines;
  }

  function ingestOrderDetailHtml(html) {
    if (typeof html !== 'string' || !/product description/i.test(html)) {
      return false;
    }
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const lines = parseOrderDetailRoot(doc);
      if (!lines) return false;
      networkLines = lines;
      return true;
    } catch {
      return false;
    }
  }

  function scrapeDom() {
    const lines = parseOrderDetailRoot(document);
    if (!lines) return false;
    networkLines = lines;
    return true;
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function extractNow() {
    scrapeDom();
    if (!networkLines.length) {
      await wait(600);
      scrapeDom();
    }
    if (networkLines.length) {
      await pushCartUpdate(true);
    }
    return networkLines;
  }

  function isViewDetailUrl(url) {
    return /\/order\/viewDetail\.lp/i.test(String(url || ''));
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
      if (!isViewDetailUrl(data.url)) return;
      ingestOrderDetailHtml(typeof data.body === 'string' ? data.body : '');
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
        line.cost
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
  window.setTimeout(() => scrapeDom(), 800);
  window.setTimeout(() => scrapeDom(), 2000);
  window.setInterval(() => scrapeDom(), 4000);

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
