(function () {
  const VENDOR = "O'Reilly";
  const POLL_MS = 2000;
  const Ami = globalThis.AmiChrome;

  /** @type {any[]} */
  let networkLines = [];
  /** @type {string} */
  let lastSentSignature = '';
  /** @type {string} */
  let lastWorksheetId = '';
  let dead = false;

  function markDead() {
    dead = true;
  }

  function parseMoney(text) {
    if (text == null || text === '') return undefined;
    if (typeof text === 'number' && Number.isFinite(text)) return text;
    const cleaned = String(text).replace(/[^0-9.-]/g, '');
    const value = Number(cleaned);
    return Number.isFinite(value) ? value : undefined;
  }

  function textOf(el) {
    return (el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function findVinInputs() {
    const selectors = [
      'input[name*="vin" i]',
      'input[id*="vin" i]',
      'input[placeholder*="vin" i]',
      'input[aria-label*="vin" i]',
      'input[name*="VIN"]',
      'input[id*="VIN"]'
    ];
    /** @type {HTMLInputElement[]} */
    const inputs = [];
    for (const selector of selectors) {
      try {
        document.querySelectorAll(selector).forEach((node) => {
          if (node instanceof HTMLInputElement) inputs.push(node);
        });
      } catch {
        // some browsers reject "i" flag in selectors
      }
    }
    if (!inputs.length) {
      document.querySelectorAll('input').forEach((node) => {
        if (!(node instanceof HTMLInputElement)) return;
        const hay = `${node.name} ${node.id} ${node.placeholder} ${node.getAttribute('aria-label') || ''}`.toLowerCase();
        if (hay.includes('vin')) inputs.push(node);
      });
    }
    return inputs;
  }

  function tryFillVin(vin) {
    if (!vin) return { ok: false, reason: 'No VIN in session' };
    const inputs = findVinInputs();
    if (!inputs.length) {
      return { ok: false, reason: 'VIN field not found on this page' };
    }
    const input = inputs[0];
    input.focus();
    input.value = vin;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
    return { ok: true };
  }

  function looksLikePartRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;

    // Require a real quote/cart line — not a bare productKey stub from the add request.
    const hasIdentity =
      record.itemNumber ||
      record.partNumber ||
      record.partNumberDisplay ||
      record.displayItemNumber ||
      (record.productKey && typeof record.productKey === 'object');
    const hasTitle =
      record.itemDescription ||
      record.displayName ||
      record.productTitle ||
      record.description ||
      record.partDescription ||
      record.shortDescription ||
      record.name;
    const hasMoney =
      record.itemCost != null ||
      record.customerPrice != null ||
      record.listPrice != null ||
      record.cost != null;

    if (hasIdentity && (hasTitle || hasMoney)) return true;

    const keys = Object.keys(record).join(' ').toLowerCase();
    return (
      ('partnumber' in record ||
        'part_number' in record ||
        'partNumber' in record ||
        'itemnumber' in record ||
        'sku' in record) &&
      (keys.includes('desc') ||
        keys.includes('name') ||
        keys.includes('qty') ||
        keys.includes('quantity') ||
        keys.includes('price') ||
        keys.includes('cost'))
    );
  }

  function extractProductKey(record) {
    const key = record.productKey;
    if (key && typeof key === 'object') {
      return {
        groupId: String(key.groupId || key.line || key.lineCode || '').trim(),
        itemId: String(key.itemId || key.itemNumber || key.partNumber || '').trim(),
        formatted: String(key.formattedProductKey || '').trim()
      };
    }
    return {
      groupId: '',
      itemId: '',
      formatted: ''
    };
  }

  function normalizeRecord(record) {
    const productKey = extractProductKey(record);
    const legacyKey = extractProductKey({ productKey: record.legacyKey });
    const catalogKeyRaw = String(record.catalogKey || record.miniQuoteKey || '');
    const catalogPart =
      catalogKeyRaw.includes('_') ? catalogKeyRaw.split('_')[0] : catalogKeyRaw;

    const partNumber = String(
      record.partNumber ||
        record.partNumberDisplay ||
        record.displayItemNumber ||
        record.part_number ||
        record.partNo ||
        record.part ||
        record.sku ||
        record.itemNumber ||
        record.itemId ||
        record.itemNo ||
        record.mfrPartNumber ||
        record.manufacturerPartNumber ||
        productKey.itemId ||
        legacyKey.itemId ||
        catalogPart ||
        (productKey.formatted.includes('|')
          ? productKey.formatted.split('|').pop()
          : productKey.formatted) ||
        ''
    ).trim();

    const rawDescription = String(
      record.itemDescription ||
        record.displayName ||
        record.productTitle ||
        record.description ||
        record.partDescription ||
        record.shortDescription ||
        record.desc ||
        record.name ||
        record.title ||
        record.productName ||
        record.partName ||
        record.productDescription ||
        ''
    ).trim();

    // Never treat the part number itself as a description.
    const description =
      rawDescription &&
      rawDescription.toUpperCase() !== partNumber.toUpperCase()
        ? rawDescription
        : '';

    if (!partNumber && !description) return null;
    // Reject incomplete stubs (add-request bodies with only productKey).
    if (!description && record.itemCost == null && record.customerPrice == null && record.listPrice == null && record.cost == null) {
      return null;
    }

    const quantity = Math.max(
      1,
      Number(
        record.itemQuantity ??
          record.quantity ??
          record.qty ??
          record.orderedQty ??
          record.quoteQty ??
          record.userSpecifiedQuantity ??
          1
      ) || 1
    );

    // FirstCall: itemCost = shop cost (only cost is transferred; list/sell ignored)
    const cost = parseMoney(
      record.itemCost ??
        record.cost ??
        record.yourPrice ??
        record.yourCost ??
        record.unitCost ??
        record.salePrice ??
        record.netPrice ??
        record.unitPrice
    );

    const brand = String(
      record.brandName ||
        record.brand ||
        record.manufacturerName ||
        record.manufacturer ||
        record.manufacturerAndBrandDisplayName ||
        record.lineCode ||
        record.line ||
        record.mfr ||
        productKey.groupId ||
        legacyKey.groupId ||
        ''
    ).trim();

    const storeName = String(
      record.storeName ||
        record.location ||
        (record.storeNumber != null ? `Store ${record.storeNumber}` : '') ||
        ''
    ).trim();

    return {
      partNumber,
      description: description || partNumber,
      brand: brand || undefined,
      quantity,
      cost,
      vendor: VENDOR,
      unit: 'pc.',
      storeName: storeName || undefined,
      externalId:
        productKey.formatted ||
        legacyKey.formatted ||
        (partNumber && brand ? `${brand}|${partNumber}` : undefined),
      _hasRealDescription: Boolean(description)
    };
  }

  /** Parse FirstCall addProducts / miniquote worksheet payloads into cart lines. */
  function extractFirstCallQuoteLines(data) {
    /** @type {Map<string, any>} */
    const map = new Map();

    function push(raw) {
      const line = normalizeRecord(raw);
      if (!line) return;
      const key = (line.partNumber || line.externalId || '').toUpperCase();
      if (!key) return;
      const prev = map.get(key);
      if (!prev) {
        map.set(key, line);
        return;
      }
      // Prefer the richer quote line (real title + cost).
      if (
        (line._hasRealDescription && !prev._hasRealDescription) ||
        (line.cost != null && prev.cost == null)
      ) {
        map.set(key, { ...prev, ...line });
      }
    }

    // Prefer miniquote summary when present (clean line list, including empty = cleared).
    if (Array.isArray(data?.quoteDetails)) {
      data.quoteDetails.forEach((detail) => push(detail));
      return Array.from(map.values());
    }

    // addProducts: quoteData.vehicleList[].worksheetDetailSIDs[]
    const vehicles = data?.quoteData?.vehicleList;
    if (Array.isArray(vehicles)) {
      vehicles.forEach((vehicle) => {
        const details = vehicle?.worksheetDetailSIDs;
        if (!Array.isArray(details)) return;
        details.forEach((detail) => {
          if (String(detail.itemType || 'PART').toUpperCase() !== 'PART') return;
          push({
            itemNumber: detail.itemNumber,
            itemDescription: detail.itemDescription,
            itemQuantity: detail.itemQuantity,
            itemCost: detail.itemCost,
            customerPrice: detail.customerPrice,
            line: detail.line,
            brandName: detail.line,
            productKey: detail.oppSourcing?.productKey
          });
        });
      });
    }

    // addProducts fallback: completeProducts[]
    if (!map.size && Array.isArray(data?.completeProducts)) {
      data.completeProducts.forEach((entry) => {
        const product = entry?.product || {};
        const price = entry?.partPriceAvailabilityResponse?.price || {};
        push({
          itemNumber:
            entry.displayItemNumber ||
            product.partNumberDisplay ||
            product.legacyKey?.itemId,
          itemDescription:
            entry.itemDescription ||
            entry.displayName ||
            product.productTitle ||
            product.name ||
            product.shortDescription,
          itemQuantity: entry.userSpecifiedQuantity || 1,
          itemCost: entry.itemCost ?? price.itemCost,
          customerPrice: entry.listPrice ?? price.listPrice ?? entry.customerPrice,
          brandName: entry.manufacturerAndBrandDisplayName || product.brandName,
          line: entry.lineCode || product.legacyKey?.groupId,
          legacyKey: product.legacyKey,
          productKey: product.legacyKey
        });
      });
    }

    return Array.from(map.values());
  }

  function mergeLines(existing, incoming) {
    const map = new Map();

    function upsert(line) {
      if (!line) return;
      const key = (line.partNumber || line.externalId || line.description || '')
        .toUpperCase()
        .trim();
      if (!key) return;
      const prev = map.get(key);
      if (!prev) {
        map.set(key, { ...line });
        return;
      }
      map.set(key, {
        ...prev,
        ...line,
        partNumber: line.partNumber || prev.partNumber,
        description:
          line.description && line.description !== line.partNumber
            ? line.description
            : prev.description && prev.description !== prev.partNumber
              ? prev.description
              : line.description || prev.description,
        brand: line.brand || prev.brand,
        quantity: line.quantity || prev.quantity,
        cost: line.cost ?? prev.cost,
        storeName: line.storeName || prev.storeName,
        externalId: line.externalId || prev.externalId,
        vendor: line.vendor || prev.vendor || VENDOR,
        unit: line.unit || prev.unit || 'pc.'
      });
    }

    existing.forEach(upsert);
    incoming.forEach(upsert);
    return Array.from(map.values());
  }

  function enrichDescriptionFromDom(lines) {
    return lines.map((line) => {
      if (!line.partNumber) return line;
      if (line.description && line.description !== line.partNumber) return line;

      const needle = line.partNumber.toUpperCase();
      /** @type {Element[]} */
      const candidates = [];
      try {
        document.querySelectorAll('tr, [class*="product" i], [class*="part" i], li').forEach((el) => {
          if (el.closest('#ami-parts-bridge-root')) return;
          const text = textOf(el).toUpperCase();
          if (text.includes(needle)) candidates.push(el);
        });
      } catch {
        // ignore
      }

      for (const el of candidates) {
        const text = textOf(el);
        // Prefer a longer product title near the part number.
        const cleaned = text
          .replace(new RegExp(line.partNumber, 'ig'), ' ')
          .replace(/\$[\d,]+(?:\.\d{2})?/g, ' ')
          .replace(/\bqty\b|\bquantity\b|\badd to quote\b|\bin stock\b/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (cleaned.length >= 8 && cleaned.length <= 160) {
          return { ...line, description: cleaned };
        }
      }
      return line;
    });
  }

  function collectFromUnknown(value, lines, seen, depth = 0) {
    if (dead || depth > 8 || value == null) return;
    if (Array.isArray(value)) {
      value.forEach((item) => collectFromUnknown(item, lines, seen, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;

    const record = /** @type {Record<string, unknown>} */ (value);

    // FirstCall tracking envelope
    if (Array.isArray(record.productTrackingContexts)) {
      collectFromUnknown(record.productTrackingContexts, lines, seen, depth + 1);
    }

    if (looksLikePartRecord(record)) {
      const line = normalizeRecord(record);
      if (line && line._hasRealDescription) {
        const key = `${line.partNumber}|${line.description}|${line.quantity}|${line.cost ?? ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          lines.push(line);
        }
      }
    }

    for (const [key, child] of Object.entries(record)) {
      if (
        /quote|cart|order|line|item|part|product|result|tracking|context/i.test(key) ||
        depth < 4
      ) {
        collectFromUnknown(child, lines, seen, depth + 1);
      }
    }
  }

  function rememberWorksheetId(sourceHint) {
    const hint = String(sourceHint || '');
    const match =
      hint.match(/\/worksheet\/rest\/(?:v2\/miniquote|enterprise)\/(\d+)/i) ||
      hint.match(/\/worksheet\/(\d+)(?:\/|\.html|\?|#|$)/i);
    if (match?.[1]) lastWorksheetId = match[1];
  }

  function resolveWorksheetId() {
    if (lastWorksheetId) return lastWorksheetId;
    rememberWorksheetId(window.location.href);
    if (lastWorksheetId) return lastWorksheetId;
    try {
      // Quote page links / breadcrumbs sometimes expose the worksheet id.
      const anchors = document.querySelectorAll('a[href*="/worksheet/"]');
      for (const anchor of anchors) {
        rememberWorksheetId(anchor.getAttribute('href') || '');
        if (lastWorksheetId) return lastWorksheetId;
      }
    } catch {
      // ignore
    }
    return lastWorksheetId;
  }

  function readCsrfToken() {
    try {
      const meta = document.querySelector(
        'meta[name="csrf-token"], meta[name="_csrf"], meta[name="CSRF-TOKEN"], meta[name="csrfToken"]'
      );
      const content = meta?.getAttribute('content');
      if (content) return content;
    } catch {
      // ignore
    }
    try {
      const input = document.querySelector(
        'input[name="_csrf"], input[name="csrf"], input[name="csrfToken"]'
      );
      if (input instanceof HTMLInputElement && input.value) return input.value;
    } catch {
      // ignore
    }
    try {
      const match = document.cookie.match(
        /(?:^|;\s*)(?:XSRF-TOKEN|csrfToken|CSRF-TOKEN|_csrf)=([^;]+)/i
      );
      if (match) return decodeURIComponent(match[1]);
    } catch {
      // ignore
    }
    return '';
  }

  function isFirstCallQuoteUrl(sourceHint) {
    const hint = String(sourceHint || '').toLowerCase();
    return (
      /\/worksheet\/rest\/.*\/addproducts\//i.test(hint) ||
      /\/worksheet\/rest\/.*\/miniquote\//i.test(hint) ||
      /\/worksheet\/rest\/enterprise\/\d+\/products\//i.test(hint) ||
      /\/worksheet\/rest\/.*\/(update|remove|delete).*product/i.test(hint)
    );
  }

  function isFirstCallProductDeleteUrl(sourceHint) {
    return /\/worksheet\/rest\/enterprise\/\d+\/products\/\d+/i.test(
      String(sourceHint || '')
    );
  }

  function isCartMutationPayload(data, sourceHint, kind, method) {
    const hint = `${String(sourceHint || '')} ${kind || ''}`.toLowerCase();
    const httpMethod = String(method || '').toUpperCase();

    // Ignore analytics / session noise
    if (/google-analytics|fullstory|signals\/interactions|g\/collect/i.test(hint)) {
      return false;
    }

    // Primary FirstCall quote APIs (responses only — request bodies are stubs)
    if (isFirstCallQuoteUrl(hint)) {
      return kind !== 'request';
    }

    // DELETE /products/:id responses update totals but may omit quoteDetails —
    // still treat as a cart mutation so we can clear / re-fetch.
    if (httpMethod === 'DELETE' && isFirstCallProductDeleteUrl(hint)) {
      return kind !== 'request';
    }

    if (data && typeof data === 'object') {
      if (Array.isArray(data.quoteDetails)) return true;
      if (data.quoteData?.vehicleList) return true;
      if (Array.isArray(data.completeProducts) && data.addResults) return true;
    }

    return false;
  }

  function applyQuoteLines(quoteLines) {
    networkLines = quoteLines.map((line) => {
      const { _hasRealDescription, ...rest } = line;
      return rest;
    });
    if (networkLines.length) {
      networkLines = enrichDescriptionFromDom(networkLines);
    }
    void pushCartUpdate(true);
  }

  async function fetchMiniquote(worksheetId) {
    const url = `/FirstCallOnline/worksheet/rest/v2/miniquote/${worksheetId}`;
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest'
    };
    const token = readCsrfToken();
    if (token) headers['x-csrf-token'] = token;

    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers,
      cache: 'no-store'
    });
    const text = await response.text();
    ingestPayload(text, response.url || url, 'response', 'GET');
    return response.ok;
  }

  function requestMiniquoteRefresh() {
    const worksheetId = resolveWorksheetId();
    if (!worksheetId) {
      // No worksheet yet — push whatever we already have (often empty).
      void pushCartUpdate(true);
      return false;
    }

    // Prefer same-origin fetch from the content script (cookies apply).
    void fetchMiniquote(worksheetId).catch(() => {
      // Fallback: ask the page-world hook (can see page JS CSRF vars).
      try {
        window.postMessage(
          {
            source: 'ami-parts-bridge-fetch-miniquote',
            worksheetId
          },
          '*'
        );
      } catch {
        void pushCartUpdate(true);
      }
    });
    return true;
  }

  function ingestPayload(payload, sourceHint, kind, method) {
    if (payload == null) return;
    // Never build the cart from add-request stubs (productKey + qty only).
    if (kind === 'request') return;

    rememberWorksheetId(sourceHint);

    let data = payload;
    if (typeof payload === 'string') {
      const trimmed = payload.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          data = JSON.parse(trimmed);
        } catch {
          return;
        }
      } else {
        return;
      }
    }

    if (!isCartMutationPayload(data, sourceHint, kind, method)) {
      return;
    }

    const httpMethod = String(method || '').toUpperCase();
    const hasQuoteDetailsArray = Array.isArray(data?.quoteDetails);

    // FirstCall miniquote (or any payload with quoteDetails): replace cart, including empty.
    if (hasQuoteDetailsArray) {
      applyQuoteLines(extractFirstCallQuoteLines(data));
      return;
    }

    // DELETE product: response is worksheet totals without quoteDetails — clear then re-fetch.
    if (httpMethod === 'DELETE' && isFirstCallProductDeleteUrl(sourceHint)) {
      networkLines = [];
      void pushCartUpdate(true);
      requestMiniquoteRefresh();
      return;
    }

    // FirstCall quote APIs: replace shop cart from worksheet lines when present.
    const quoteLines = extractFirstCallQuoteLines(data);
    if (quoteLines.length) {
      applyQuoteLines(quoteLines);
      return;
    }

    // Non-FirstCall fallback (future suppliers) — only lines with real titles.
    if (isFirstCallQuoteUrl(sourceHint)) return;

    const lines = [];
    const seen = new Set();
    collectFromUnknown(data, lines, seen);
    if (!lines.length) return;

    networkLines = enrichDescriptionFromDom(
      mergeLines(
        networkLines,
        lines.map((line) => {
          const { _hasRealDescription, ...rest } = line;
          return rest;
        })
      )
    );
    void pushCartUpdate(true);
  }

  function installNetworkHooks() {
    const inject = () => {
      try {
        if (!Ami?.extensionAlive()) return;
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('content/page-network-hook.js');
        script.async = false;
        script.onload = () => script.remove();
        (document.documentElement || document.head || document.body).appendChild(script);
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
      ingestPayload(data.body, data.url, data.kind, data.method);
    });
  }

  function scrapeStorageLines() {
    const lines = [];
    const seen = new Set();
    const stores = [window.sessionStorage, window.localStorage];
    for (const store of stores) {
      try {
        for (let i = 0; i < store.length; i += 1) {
          const key = store.key(i) || '';
          if (!/quote|cart|basket|order|part/i.test(key)) continue;
          const raw = store.getItem(key);
          if (!raw) continue;
          collectFromUnknown(raw, lines, seen);
          try {
            collectFromUnknown(JSON.parse(raw), lines, seen);
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    }
    return lines;
  }

  function scrapeDomLines() {
    const lines = [];
    const seen = new Set();

    const rowSelectors = [
      '[class*="quote" i] tr',
      '[id*="quote" i] tr',
      '[class*="cart" i] tr',
      '[id*="cart" i] tr',
      '[class*="basket" i] tr',
      'table tr',
      '[class*="line-item" i]',
      '[class*="lineItem" i]',
      '[class*="cart-item" i]',
      '[class*="CartItem" i]',
      '[class*="quoteItem" i]',
      '[class*="QuoteItem" i]',
      '[data-part-number]',
      '[data-partnumber]'
    ];

    /** @type {Element[]} */
    const rows = [];
    for (const selector of rowSelectors) {
      try {
        document.querySelectorAll(selector).forEach((node) => rows.push(node));
      } catch {
        // ignore invalid selector
      }
    }

    for (const row of rows) {
      if (!(row instanceof HTMLElement)) continue;
      if (row.closest('#ami-parts-bridge-root')) continue;
      if (row.querySelector('th')) continue;

      const fullText = textOf(row);
      if (!fullText || fullText.length < 6) continue;
      if (/subtotal|order total|sign in|log in|password|username|search parts/i.test(fullText) && fullText.length < 40) {
        continue;
      }

      const partNumber =
        textOf(
          row.querySelector(
            '[class*="part-number" i], [class*="partNumber" i], [data-part-number], [data-partnumber], [class*="sku" i]'
          )
        ) ||
        (fullText.match(/\b([A-Z]{0,4}\d{2,}[A-Z0-9-]{0,12})\b/) || [])[1] ||
        '';

      let description = textOf(
        row.querySelector(
          '[class*="description" i], [class*="product-name" i], [class*="title" i], [class*="part-name" i]'
        )
      );
      if (!description) {
        description = fullText.slice(0, 140);
      }

      const qtyInput = row.querySelector('input[type="number"], input[name*="qty" i], input[id*="qty" i]');
      const qtyText =
        (qtyInput instanceof HTMLInputElement && qtyInput.value) ||
        textOf(row.querySelector('[class*="qty" i], [class*="quantity" i]')) ||
        '1';
      const quantity = Math.max(1, Number(String(qtyText).replace(/[^0-9.]/g, '')) || 1);

      const moneyMatches = fullText.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
      const amounts = moneyMatches.map(parseMoney).filter((n) => n != null);
      const cost = amounts.length ? amounts[0] : undefined;
      const brand = textOf(row.querySelector('[class*="brand" i], [class*="manufacturer" i], [class*="line" i]'));

      if (!partNumber && !/\$/.test(fullText)) continue;
      if (!partNumber && description.length < 8) continue;

      const key = `${partNumber}|${description}|${quantity}|${cost ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      lines.push({
        partNumber,
        description: description || partNumber || 'Part',
        brand: brand || undefined,
        quantity,
        cost,
        vendor: VENDOR,
        unit: 'pc.'
      });
    }

    return lines;
  }

  function scrapeCartLines() {
    // Shop cart is driven by explicit add-to-quote/cart network events only.
    if (networkLines.length) {
      networkLines = enrichDescriptionFromDom(networkLines);
    }
    return networkLines;
  }

  function resetCart() {
    networkLines = [];
    lastSentSignature = '';
    void pushCartUpdate(true);
  }

  async function pushCartUpdate(force = false) {
    if (dead) return;
    if (!Ami?.extensionAlive()) {
      markDead();
      return;
    }

    const lines = scrapeCartLines();
    const signature = JSON.stringify(
      lines.map((l) => [l.partNumber, l.description, l.quantity, l.cost])
    );
    if (!force && signature === lastSentSignature) return;

    lastSentSignature = signature;
    // Network / quote sync is authoritative — empty carts must clear the widget.
    const response = await Ami.sendMessage({
      type: 'AMI_UPDATE_CART',
      lines,
      allowEmpty: true
    });
    if (response?.error && /invalidated|refresh this tab/i.test(response.error)) {
      markDead();
    }
  }

  installNetworkHooks();
  rememberWorksheetId(window.location.href);

  window.__amiTryFillVin = tryFillVin;

  window.addEventListener('ami-parts-bridge-fill-vin', () => {
    void (async () => {
      const response = await Ami.sendMessage({ type: 'AMI_GET_SESSION' });
      const vin = response?.session?.vehicle?.vin;
      const result = tryFillVin(vin);
      window.dispatchEvent(
        new CustomEvent('ami-parts-bridge-fill-vin-result', { detail: result })
      );
    })();
  });

  window.addEventListener('ami-parts-bridge-reset-cart', () => {
    resetCart();
  });

  window.addEventListener('ami-parts-bridge-scrape-now', () => {
    // Re-fetch FirstCall miniquote so removals / qty changes sync into the shop cart.
    if (!requestMiniquoteRefresh()) {
      void pushCartUpdate(true);
    }
  });

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const label = `${target.textContent || ''} ${target.getAttribute('aria-label') || ''} ${target.getAttribute('title') || ''}`.toLowerCase();
      if (/add.*quote|add.*cart|update.*quote|update.*cart/.test(label)) {
        window.setTimeout(() => void pushCartUpdate(true), 900);
      }
      // FirstCall remove controls — re-fetch after the DELETE + miniquote settle.
      let looksLikeRemove = /remove|delete|trash/.test(label);
      if (!looksLikeRemove) {
        try {
          looksLikeRemove = Boolean(
            target.closest(
              '[class*="remove" i], [class*="delete" i], [aria-label*="remove" i], [title*="remove" i]'
            )
          );
        } catch {
          looksLikeRemove = Boolean(
            target.closest('[class*="remove"], [class*="delete"], [aria-label*="remove"], [title*="remove"]')
          );
        }
      }
      if (looksLikeRemove) {
        window.setTimeout(() => requestMiniquoteRefresh(), 400);
        window.setTimeout(() => requestMiniquoteRefresh(), 1200);
      }
    },
    true
  );

  Ami?.onRuntimeMessage((message, _sender, sendResponse) => {
    if (message?.type === 'AMI_TRY_FILL_VIN') {
      void Ami.sendMessage({ type: 'AMI_GET_SESSION' }).then((response) => {
        const vin = response?.session?.vehicle?.vin;
        sendResponse(tryFillVin(vin));
      });
      return true;
    }
    if (message?.type === 'AMI_SCRAPE_NOW') {
      const started = requestMiniquoteRefresh();
      window.setTimeout(() => {
        sendResponse({
          ok: true,
          started,
          worksheetId: resolveWorksheetId() || null,
          lines: scrapeCartLines()
        });
      }, 900);
      return true;
    }
    if (message?.type === 'AMI_SESSION_UPDATED' && message.resetCart) {
      resetCart();
      sendResponse({ ok: true });
      return;
    }
  });

})();