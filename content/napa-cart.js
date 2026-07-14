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
   * OCC cart path prefix from the page's own cart URL.
   * ProLink uses orgUsers (not users) — wrong prefix causes getMiniCart 404s.
   */
  let lastCartApiPrefix = '/occ/v2/prolinkus/orgUsers/current/carts/';
  /** @type {{ data: any, status: number } | null} */
  let pendingMiniCart = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let pendingMiniCartTimer = null;
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

  /** Parse ATC cartModifications (partial — one added line). */
  function extractAtcLines(data) {
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
      map.set(key, line);
    }

    if (data?.code) rememberCartCode(data.code);
    if (Array.isArray(data?.cartModifications)) {
      data.cartModifications.forEach((mod) => {
        if (mod?.entry) push(mod.entry);
      });
    }
    return Array.from(map.values());
  }

  /**
   * Parse getMiniCart / full cart snapshots from `entries` only.
   * Never use cartModifications here — those are partial ATC leftovers and
   * were collapsing a 3-line mini-cart down to 1 line.
   */
  function extractMiniCartLines(data) {
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
    const nestedCart =
      data?.cart && typeof data.cart === 'object' ? data.cart : null;
    if (nestedCart?.code) rememberCartCode(nestedCart.code);

    const entries =
      (Array.isArray(data?.entries) && data.entries) ||
      (Array.isArray(nestedCart?.entries) && nestedCart.entries) ||
      null;
    if (!entries) return null;
    entries.forEach((entry) => push(entry));
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

  function requestMiniCartRefresh() {
    // ProLink already calls getMiniCart after ATC/remove. Our own refreshes
    // often 404 — only rely on intercepted page traffic.
    void pushCartUpdate(true);
    return Boolean(resolveCartCode());
  }

  function lineMatchesProductKey(line, productKey) {
    const key = String(productKey || '').toUpperCase();
    if (!key || !line) return false;
    const partFromKey = key.includes('_') ? key.split('_').slice(1).join('_') : key;
    const externalId = String(line.externalId || '').toUpperCase();
    const partNumber = String(line.partNumber || '').toUpperCase();
    if (externalId && externalId === key) return true;
    if (partFromKey && partNumber === partFromKey) return true;
    if (partFromKey && externalId === partFromKey) return true;
    if (partFromKey && externalId.endsWith(`_${partFromKey}`)) return true;
    return false;
  }

  function productKeyFromUrl(sourceHint) {
    const match = String(sourceHint || '').match(/[?&]product=([^&]+)/i);
    if (!match?.[1]) return '';
    try {
      return decodeURIComponent(match[1]).toUpperCase();
    } catch {
      return match[1].toUpperCase();
    }
  }

  function removeLocalLineByProductKey(productKey) {
    if (!productKey) return false;
    const before = networkLines.length;
    networkLines = networkLines.filter(
      (line) => !lineMatchesProductKey(line, productKey)
    );
    if (networkLines.length !== before) {
      void pushCartUpdate(true);
      return true;
    }
    return false;
  }

  /** Authoritative sync: whatever getMiniCart says is the Shop Cart. */
  function applyMiniCartSnapshot(data, status) {
    if (Number.isFinite(status) && status >= 400) return;
    if (!data || typeof data !== 'object') return;
    if (data.error || Array.isArray(data.errors)) return;

    const lines = extractMiniCartLines(data);
    if (lines == null) return;
    applyCartLines(lines, { replace: true });
  }

  /**
   * Coalesce burst getMiniCart responses; apply only the latest after a short
   * delay so an older smaller snapshot cannot win a race.
   */
  function queueMiniCartSnapshot(data, status) {
    pendingMiniCart = { data, status: Number(status) || 200 };
    if (pendingMiniCartTimer) window.clearTimeout(pendingMiniCartTimer);
    pendingMiniCartTimer = window.setTimeout(() => {
      pendingMiniCartTimer = null;
      const snap = pendingMiniCart;
      pendingMiniCart = null;
      if (snap) applyMiniCartSnapshot(snap.data, snap.status);
    }, 120);
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

    const status = Number(meta?.status);
    if (Number.isFinite(status) && status >= 400) {
      return;
    }

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

    // getMiniCart = source of truth. Always full-replace from `entries`.
    if (isNapaMiniCartUrl(sourceHint)) {
      queueMiniCartSnapshot(data, status);
      return;
    }

    // Remove: optimistic local drop; getMiniCart will confirm full state.
    if (isNapaEntriesMutationUrl(sourceHint)) {
      const isRemove =
        /[?&]quantity=0(?:&|$)/i.test(String(sourceHint || '')) ||
        Number(data?.quantity) === 0 ||
        Number(data?.quantityAdded) < 0;

      if (isRemove) {
        const productKey =
          productKeyFromUrl(sourceHint) ||
          String(data?.entry?.product?.code || data?.entry?.partNumber || '').toUpperCase();
        removeLocalLineByProductKey(productKey);
        return;
      }

      // Qty change: optimistic merge of the changed line only.
      if (data?.entry) {
        const line = normalizeEntry(data.entry);
        if (line) applyCartLines([line], { replace: false });
      }
      return;
    }

    // ATC: optimistic merge of the newly added line(s) only.
    if (
      isNapaAtcUrl(sourceHint) ||
      (Array.isArray(data?.cartModifications) && data.cartModifications.length)
    ) {
      const lines = extractAtcLines(data);
      if (lines.length) applyCartLines(lines, { replace: false });
      return;
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
        generation: data.generation,
        status: data.status
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

    // NAPA tab owns cart sync via getMiniCart. Ignore stale storage echoes
    // (including older fuller carts that would undo a delete).
    void pushCartUpdate(true);
  });
})();
