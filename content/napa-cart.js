(function () {
  const VENDOR = 'NAPA';
  const Ami = globalThis.AmiChrome;

  /** @type {any[]} */
  let networkLines = [];
  /** @type {string} */
  let lastSentSignature = '';
  /** @type {string} */
  let lastCartCode = '';
  /** @type {string} */
  let lastSponsorPk = '';
  /**
   * OCC cart path prefix from the page's own getMiniCart URL
   * (e.g. /occ/v2/prolinkus/users/current/carts/ or .../orgUsers/...).
   * Must match what ProLink uses or refreshes can hit a different/stale cart.
   */
  let lastCartApiPrefix = '/occ/v2/prolinkus/users/current/carts/';
  /** Timestamp of last successful ATC merge. */
  let lastAtcAt = 0;
  /** Timestamp of last remove/clear intent (allows mini-cart to shrink). */
  let lastRemoveAt = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let pendingRefreshTimer = null;
  let refreshInFlight = false;
  let refreshQueuedAgain = false;
  /** Monotonic id so late/stale mini-cart responses can be ignored. */
  let miniCartGeneration = 0;
  let dead = false;

  function markDead() {
    dead = true;
  }

  function parseMoney(text) {
    if (text == null || text === '') return undefined;
    if (typeof text === 'number' && Number.isFinite(text)) return text;
    if (typeof text === 'object' && text !== null && 'value' in text) {
      return parseMoney(/** @type {{ value?: unknown }} */ (text).value);
    }
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

  function rememberCartCode(value) {
    const code = String(value || '').trim();
    if (!code) return;
    // Cookie form: NPPLK-000056Z870_#_200457466
    const cleaned = code.split('_#_')[0].split('#')[0].trim();
    if (/^NPPLK-/i.test(cleaned) || /^[A-Z0-9-]{8,}$/i.test(cleaned)) {
      lastCartCode = cleaned;
    }
  }

  function rememberSponsorPk(sourceHint) {
    const hint = String(sourceHint || '');
    const match = hint.match(/[?&]sponsorPK=([^&]+)/i);
    if (match?.[1]) {
      lastSponsorPk = decodeURIComponent(match[1]);
    }
  }

  /** Learn cart code + API path from any intercepted carts/... URL. */
  function rememberCartApiFromUrl(sourceHint) {
    const hint = String(sourceHint || '');
    const match = hint.match(
      /(\/occ\/v2\/[^/]+\/(?:org)?users\/current\/carts\/)([^/?#]+)/i
    );
    if (!match) return;
    lastCartApiPrefix = match[1];
    try {
      rememberCartCode(decodeURIComponent(match[2]));
    } catch {
      rememberCartCode(match[2]);
    }
  }

  function readCartCodeFromCookie() {
    try {
      const match = document.cookie.match(/(?:^|;\s*)plk_sessionCartId=([^;]+)/i);
      if (match?.[1]) {
        rememberCartCode(decodeURIComponent(match[1]));
      }
    } catch {
      // ignore
    }
    return lastCartCode;
  }

  function resolveCartCode() {
    if (lastCartCode) return lastCartCode;
    return readCartCodeFromCookie();
  }

  function resolveSponsorPk() {
    if (lastSponsorPk) return lastSponsorPk;
    rememberSponsorPk(window.location.href);
    return lastSponsorPk;
  }

  function normalizeEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;

    const product =
      entry.product && typeof entry.product === 'object' ? entry.product : {};
    const partNumber = String(
      entry.partNumber ||
        product.partNumber ||
        (typeof product.code === 'string' && product.code.includes('_')
          ? product.code.split('_').slice(1).join('_')
          : product.code) ||
        ''
    ).trim();

    const rawDescription = String(
      entry.partDescription ||
        product.description ||
        product.name ||
        ''
    ).trim();

    const description =
      rawDescription &&
      rawDescription.toUpperCase() !== partNumber.toUpperCase()
        ? rawDescription
        : '';

    if (!partNumber && !description) return null;

    const quantity = Math.max(1, Number(entry.quantity) || 1);
    const unitCost =
      parseMoney(entry.basePrice) ??
      (parseMoney(entry.totalPrice) != null
        ? Number(
            (
              /** @type {number} */ (parseMoney(entry.totalPrice)) / quantity
            ).toFixed(2)
          )
        : undefined);

    const brand = String(
      entry.brand || entry.lineAbbr || product.lineAbbr || ''
    ).trim();

    const productCode = String(product.code || '').trim();
    const externalId =
      productCode ||
      (entry.lineAbbr && partNumber
        ? `${entry.lineAbbr}_${partNumber}`
        : partNumber) ||
      undefined;

    return {
      partNumber: partNumber || description,
      description: description || partNumber || 'Part',
      brand: brand || undefined,
      quantity,
      cost: unitCost,
      listPrice: parseMoney(entry.listPrice),
      vendor: VENDOR,
      unit: 'pc.',
      externalId,
      _hasRealDescription: Boolean(description)
    };
  }

  /** Parse ProLink ATC / getMiniCart payloads into cart lines. */
  function extractNapaCartLines(data) {
    /** @type {Map<string, any>} */
    const map = new Map();

    function push(raw) {
      const line = normalizeEntry(raw);
      if (!line) return;
      const key = (
        line.externalId ||
        line.partNumber ||
        line.description ||
        ''
      ).toUpperCase();
      if (!key) return;
      const prev = map.get(key);
      if (!prev) {
        map.set(key, line);
        return;
      }
      if (
        (line._hasRealDescription && !prev._hasRealDescription) ||
        (line.cost != null && prev.cost == null)
      ) {
        map.set(key, { ...prev, ...line });
      }
    }

    if (data?.code) rememberCartCode(data.code);

    // Nested full cart on some ATC / mutation payloads.
    const nestedCart =
      data?.cart && typeof data.cart === 'object' ? data.cart : null;
    if (nestedCart?.code) rememberCartCode(nestedCart.code);

    // ATC responses expose cartModifications; prefer those so a partial
    // `entries` array on the same payload cannot hide the added line.
    if (Array.isArray(data?.cartModifications) && data.cartModifications.length) {
      data.cartModifications.forEach((mod) => {
        if (mod?.entry) push(mod.entry);
      });
      const entries =
        (Array.isArray(data?.entries) && data.entries) ||
        (Array.isArray(nestedCart?.entries) && nestedCart.entries) ||
        null;
      if (entries && entries.length > map.size) {
        map.clear();
        entries.forEach((entry) => push(entry));
      }
      return Array.from(map.values());
    }

    // Mini-cart / full cart snapshot.
    const entries =
      (Array.isArray(data?.entries) && data.entries) ||
      (Array.isArray(nestedCart?.entries) && nestedCart.entries) ||
      null;
    if (entries) {
      entries.forEach((entry) => push(entry));
      return Array.from(map.values());
    }

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
        document
          .querySelectorAll('tr, [class*="product" i], [class*="part" i], li')
          .forEach((el) => {
            if (el.closest('#ami-parts-bridge-root')) return;
            const text = textOf(el).toUpperCase();
            if (text.includes(needle)) candidates.push(el);
          });
      } catch {
        // ignore
      }

      for (const el of candidates) {
        const text = textOf(el);
        const cleaned = text
          .replace(new RegExp(line.partNumber, 'ig'), ' ')
          .replace(/\$[\d,]+(?:\.\d{2})?/g, ' ')
          .replace(/\bqty\b|\bquantity\b|\badd to cart\b|\bin stock\b/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (cleaned.length >= 8 && cleaned.length <= 160) {
          return { ...line, description: cleaned };
        }
      }
      return line;
    });
  }

  function isNapaCartUrl(sourceHint) {
    const hint = String(sourceHint || '').toLowerCase();
    return (
      /\/occ\/v2\/[^/]+\/(?:org)?users\/current\/carts\//i.test(hint) ||
      /\/carts\/[^/]+\/getminicart/i.test(hint) ||
      /\/entries\/multi\/atc/i.test(hint) ||
      (/\/entries\?/i.test(hint) && /sponsorpk=/i.test(hint))
    );
  }

  function isNapaMiniCartUrl(sourceHint) {
    return /\/getminicart/i.test(String(sourceHint || ''));
  }

  function isNapaAtcUrl(sourceHint) {
    return /\/entries\/multi\/atc/i.test(String(sourceHint || ''));
  }

  function isNapaEntriesMutationUrl(sourceHint) {
    const hint = String(sourceHint || '');
    return (
      /\/entries\?/i.test(hint) &&
      /sponsorpk=/i.test(hint.toLowerCase()) &&
      !isNapaAtcUrl(hint)
    );
  }

  function isCartMutationPayload(data, sourceHint, kind) {
    const hint = `${String(sourceHint || '')} ${kind || ''}`.toLowerCase();

    if (/linkedin|adobe|google-analytics|fullstory|g\/collect|cls_report/i.test(hint)) {
      return false;
    }

    if (isNapaCartUrl(hint)) {
      return kind !== 'request';
    }

    if (data && typeof data === 'object') {
      if (Array.isArray(data.entries) && data.code) return true;
      if (Array.isArray(data.cartModifications) && data.code) return true;
    }

    return false;
  }

  function applyCartLines(quoteLines, { replace = true } = {}) {
    const cleaned = quoteLines.map((line) => {
      const { _hasRealDescription, ...rest } = line;
      return rest;
    });

    if (replace) {
      networkLines = cleaned;
    } else if (cleaned.length) {
      const map = new Map(
        networkLines.map((line) => [
          (line.externalId || line.partNumber || '').toUpperCase(),
          line
        ])
      );
      cleaned.forEach((line) => {
        const key = (line.externalId || line.partNumber || '').toUpperCase();
        if (!key) return;
        map.set(key, { ...(map.get(key) || {}), ...line });
      });
      networkLines = Array.from(map.values());
    }

    if (networkLines.length) {
      networkLines = enrichDescriptionFromDom(networkLines);
    }
    void pushCartUpdate(true);
  }

  async function fetchMiniCart(cartCode) {
    // Prefer page-world fetch only (session + same OCC path as ProLink).
    // Content-script fetch races with the page and can return a smaller/stale
    // cart that then overwrites the extension Shop Cart.
    const code = cartCode || resolveCartCode();
    if (!code) {
      void pushCartUpdate(true);
      return false;
    }

    try {
      window.postMessage(
        {
          source: 'ami-parts-bridge-fetch-napa-minicart',
          cartCode: code,
          sponsorPk: resolveSponsorPk(),
          cartApiPrefix: lastCartApiPrefix,
          generation: miniCartGeneration
        },
        '*'
      );
      return true;
    } catch {
      void pushCartUpdate(true);
      return false;
    }
  }

  function requestMiniCartRefresh() {
    const cartCode = resolveCartCode();
    if (!cartCode) {
      void pushCartUpdate(true);
      return false;
    }

    // Coalesce the refresh storm (ATC + click + page + retries) into one call.
    if (pendingRefreshTimer) window.clearTimeout(pendingRefreshTimer);
    pendingRefreshTimer = window.setTimeout(() => {
      pendingRefreshTimer = null;
      if (refreshInFlight) {
        refreshQueuedAgain = true;
        return;
      }
      refreshInFlight = true;
      refreshQueuedAgain = false;
      miniCartGeneration += 1;
      void fetchMiniCart(resolveCartCode()).finally(() => {
        window.setTimeout(() => {
          refreshInFlight = false;
          if (refreshQueuedAgain) {
            refreshQueuedAgain = false;
            requestMiniCartRefresh();
          }
        }, 700);
      });
    }, 400);
    return true;
  }

  function entryCountHint(data, lines) {
    const totalHint =
      Number(data?.totalItems) ||
      Number(data?.totalUnitCount) ||
      Number(data?.deliveryItemsQuantity) ||
      0;
    if (totalHint > 0) return Math.max(lines.length, totalHint);
    return lines.length;
  }

  function shouldAllowMiniCartShrink(lines, data) {
    const isEmpty =
      lines.length === 0 &&
      (Number(data?.totalItems) === 0 ||
        Number(data?.totalUnitCount) === 0 ||
        (Array.isArray(data?.entries) && data.entries.length === 0));
    if (isEmpty) return true;
    if (Date.now() - lastRemoveAt < 4000) return true;
    return false;
  }

  function ingestPayload(payload, sourceHint, kind, method, meta) {
    if (payload == null) return;
    if (kind === 'request') {
      rememberSponsorPk(sourceHint);
      rememberCartApiFromUrl(sourceHint);
      return;
    }

    rememberSponsorPk(sourceHint);
    rememberCartApiFromUrl(sourceHint);

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

    if (!isCartMutationPayload(data, sourceHint, kind)) {
      return;
    }

    if (data?.code) rememberCartCode(data.code);

    // Ignore stale page-world refresh responses when a newer refresh was queued.
    const responseGen = Number(meta?.generation);
    if (
      Number.isFinite(responseGen) &&
      responseGen > 0 &&
      responseGen < miniCartGeneration
    ) {
      return;
    }

    // getMiniCart is the only authoritative full-cart replace (incl. empty after removals).
    // Do NOT treat every payload with `entries` as a full snapshot — ProLink ATC /
    // entry-mutation responses often include a partial `entries` array, which used
    // to wipe the extension cart down to a single line.
    if (isNapaMiniCartUrl(sourceHint)) {
      const lines = extractNapaCartLines(data);
      const shrinks =
        lines.length > 0 && lines.length < networkLines.length;
      if (shrinks && !shouldAllowMiniCartShrink(lines, data)) {
        // Stale/wrong-cart snapshot (network log showed 2.3KB vs 2.8KB races).
        // Keep the fuller cart; optionally retry once after ATC.
        if (Date.now() - lastAtcAt < 5000) {
          window.setTimeout(() => requestMiniCartRefresh(), 600);
        }
        return;
      }
      applyCartLines(lines, { replace: true });
      return;
    }

    // ATC: merge added lines, then refresh mini-cart for full snapshot.
    if (isNapaAtcUrl(sourceHint) || Array.isArray(data?.cartModifications)) {
      const lines = extractNapaCartLines(data);
      if (lines.length) {
        applyCartLines(lines, { replace: false });
        lastAtcAt = Date.now();
      }
      window.setTimeout(() => requestMiniCartRefresh(), 250);
      return;
    }

    // Quantity update / remove (product=…&quantity=0) — refresh mini-cart.
    // Do not apply partial `entries` from these responses as a full replace.
    if (isNapaEntriesMutationUrl(sourceHint)) {
      if (/[?&]quantity=0(?:&|$)/i.test(String(sourceHint || ''))) {
        lastRemoveAt = Date.now();
      }
      window.setTimeout(() => requestMiniCartRefresh(), 250);
      return;
    }

    // Other cart payloads with entries (e.g. non-miniCart cart GETs):
    // only replace when the snapshot is at least as complete as what we have;
    // otherwise merge and refresh so partial responses cannot shrink the cart.
    if (Array.isArray(data?.entries) || Array.isArray(data?.cart?.entries)) {
      const lines = extractNapaCartLines(data);
      const totalHint = entryCountHint(data, lines);
      const looksComplete =
        lines.length >= networkLines.length ||
        (totalHint > 0 && lines.length >= totalHint) ||
        (lines.length === 0 && totalHint === 0);

      if (looksComplete) {
        applyCartLines(lines, { replace: true });
      } else if (lines.length) {
        applyCartLines(lines, { replace: false });
      }
      window.setTimeout(() => requestMiniCartRefresh(), 250);
    }
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
      ingestPayload(data.body, data.url, data.kind, data.method, {
        generation: data.generation
      });
    });
  }

  function scrapeCartLines() {
    if (networkLines.length) {
      networkLines = enrichDescriptionFromDom(networkLines);
    }
    return networkLines;
  }

  function resetCart() {
    networkLines = [];
    lastSentSignature = '';
    lastRemoveAt = Date.now();
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
  rememberSponsorPk(window.location.href);
  readCartCodeFromCookie();

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
    if (!requestMiniCartRefresh()) {
      void pushCartUpdate(true);
    }
  });

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const label = `${target.textContent || ''} ${target.getAttribute('aria-label') || ''} ${target.getAttribute('title') || ''}`.toLowerCase();
      if (/add.*cart|update.*cart|add to cart/.test(label)) {
        window.setTimeout(() => requestMiniCartRefresh(), 900);
      }
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
            target.closest(
              '[class*="remove"], [class*="delete"], [aria-label*="remove"], [title*="remove"]'
            )
          );
        }
      }
      if (looksLikeRemove) {
        lastRemoveAt = Date.now();
        window.setTimeout(() => requestMiniCartRefresh(), 500);
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
      const started = requestMiniCartRefresh();
      window.setTimeout(() => {
        sendResponse({
          ok: true,
          started,
          cartCode: resolveCartCode() || null,
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

  Ami?.onStorageChanged((changes, area) => {
    if (area !== 'local' || !changes.amiPartsBridgeSession) return;
    const next = changes.amiPartsBridgeSession.newValue;
    if (!next) {
      networkLines = [];
      lastSentSignature = '';
      return;
    }
    const nextLines = Array.isArray(next.lines) ? next.lines : [];
    const nextSig = JSON.stringify(
      nextLines.map((l) => [l.partNumber, l.description, l.quantity, l.cost])
    );
    if (nextSig === lastSentSignature) return;

    // Ignore out-of-order storage writes that shrink the cart (stale push race).
    if (
      nextLines.length > 0 &&
      nextLines.length < networkLines.length &&
      Date.now() - lastRemoveAt >= 4000
    ) {
      void pushCartUpdate(true);
      return;
    }

    networkLines = nextLines.map((line) => ({ ...line }));
    lastSentSignature = nextSig;
  });
})();
