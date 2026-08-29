(function () {
  const VENDOR = 'NAPA';
  const Ami = globalThis.AmiChrome;

  /** Live ProLink uses /users/ — /orgUsers/ getMiniCart returns 404. */
  const DEFAULT_CART_PREFIX = '/occ/v2/prolinkus/users/current/carts/';

  /** @type {any[]} */
  let networkLines = [];
  /** @type {string} */
  let lastSentSignature = '';
  /** @type {string} */
  let lastCartCode = '';
  /** @type {string} */
  let lastSponsorPk = '';
  /** @type {string} */
  let lastCartApiPrefix = DEFAULT_CART_PREFIX;
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

  /** Always normalize to /users/ — orgUsers getMiniCart 404s on ProLink. */
  function normalizeCartApiPrefix(prefix) {
    const raw = String(prefix || '').trim();
    if (!/^\/occ\/v2\/[^/]+\/(?:org)?users\/current\/carts\/$/i.test(raw)) {
      return DEFAULT_CART_PREFIX;
    }
    return raw.replace(/\/orgUsers\//i, '/users/');
  }

  function rememberCartApiFromUrl(sourceHint) {
    const hint = String(sourceHint || '');
    const match = hint.match(
      /(\/occ\/v2\/[^/]+\/)(?:org)?users(\/current\/carts\/)([^/?#]+)/i
    );
    if (!match) return;
    lastCartApiPrefix = normalizeCartApiPrefix(`${match[1]}users${match[2]}`);
    try {
      rememberCartCode(decodeURIComponent(match[3]));
    } catch {
      rememberCartCode(match[3]);
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

  function readSponsorPkFromPage() {
    try {
      const profile = window.customerProfile?.getCustomerProfile;
      const pk =
        profile?.selectedSponsor?.sponsorPk ||
        profile?.primarySponsor?.sponsorPk ||
        profile?.sponsors?.[0]?.sponsorPk;
      if (pk) lastSponsorPk = String(pk);
    } catch {
      // ignore
    }
    return lastSponsorPk;
  }

  function resolveCartCode() {
    if (lastCartCode) return lastCartCode;
    return readCartCodeFromCookie();
  }

  function resolveSponsorPk() {
    if (lastSponsorPk) return lastSponsorPk;
    rememberSponsorPk(window.location.href);
    if (lastSponsorPk) return lastSponsorPk;
    return readSponsorPkFromPage();
  }

  /**
   * Map getMiniCart cartWsDTO entries → Shop Cart lines.
   * Prefer lineAbbr_partNumber; never treat product.code "NON_NAPA" as the SKU.
   */
  function normalizeEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;

    const product =
      entry.product && typeof entry.product === 'object' ? entry.product : {};
    const partNumber = String(
      entry.partNumber ||
        product.partNumber ||
        (typeof product.code === 'string' &&
        product.code &&
        !/^NON[_-]?NAPA$/i.test(product.code) &&
        product.code.includes('_')
          ? product.code.split('_').slice(1).join('_')
          : !/^NON[_-]?NAPA$/i.test(String(product.code || ''))
            ? product.code
            : '') ||
        ''
    ).trim();

    const rawDescription = String(
      entry.partDescription || product.description || product.name || ''
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
    const usableProductCode =
      productCode && !/^NON[_-]?NAPA$/i.test(productCode) ? productCode : '';
    const externalId =
      (entry.lineAbbr && partNumber
        ? `${entry.lineAbbr}_${partNumber}`
        : '') ||
      usableProductCode ||
      partNumber ||
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
      externalId
    };
  }

  function extractMiniCartLines(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.code) rememberCartCode(data.code);
    if (!Array.isArray(data.entries)) return null;
    return data.entries.map(normalizeEntry).filter(Boolean);
  }

  function applyCartLines(quoteLines) {
    networkLines = quoteLines;
    void pushCartUpdate(true);
  }

  function applyMiniCartDto(data) {
    const lines = extractMiniCartLines(data);
    if (lines == null) return false;
    const signature = JSON.stringify(
      lines.map((l) => [l.partNumber, l.description, l.quantity, l.cost, l.externalId])
    );
    const currentSig = JSON.stringify(
      networkLines.map((l) => [
        l.partNumber,
        l.description,
        l.quantity,
        l.cost,
        l.externalId
      ])
    );
    if (signature === currentSig && signature === lastSentSignature) {
      return true;
    }
    applyCartLines(lines);
    return true;
  }

  function isNapaMiniCartUrl(sourceHint) {
    return /\/getminicart/i.test(String(sourceHint || ''));
  }

  function isNapaCartMutationUrl(sourceHint) {
    const hint = String(sourceHint || '');
    return (
      /\/entries\/multi\/atc/i.test(hint) ||
      (/\/entries\?/i.test(hint) && /sponsorpk=/i.test(hint.toLowerCase()))
    );
  }

  function requestMiniCartRefresh() {
    readCartCodeFromCookie();
    resolveSponsorPk();
    const cartCode = resolveCartCode();
    if (!cartCode) {
      void pushCartUpdate(true);
      return false;
    }
    try {
      window.postMessage(
        {
          source: 'ami-parts-bridge-fetch-napa-minicart',
          cartCode,
          sponsorPk: resolveSponsorPk(),
          cartApiPrefix: normalizeCartApiPrefix(lastCartApiPrefix)
        },
        '*'
      );
      return true;
    } catch {
      void pushCartUpdate(true);
      return false;
    }
  }

  function ingestPayload(payload, sourceHint, kind, method, meta) {
    if (payload == null) return;

    rememberSponsorPk(sourceHint);
    rememberCartApiFromUrl(sourceHint);

    if (kind === 'request') {
      // Cart mutations: refresh from getMiniCart; never trust mutation bodies.
      if (isNapaCartMutationUrl(sourceHint)) {
        window.setTimeout(() => requestMiniCartRefresh(), 400);
      }
      return;
    }

    const status = Number(meta?.status);
    if (Number.isFinite(status) && status >= 400) {
      return;
    }

    // Only getMiniCart 2xx is source of truth.
    if (!isNapaMiniCartUrl(sourceHint)) {
      if (isNapaCartMutationUrl(sourceHint)) {
        window.setTimeout(() => requestMiniCartRefresh(), 400);
      }
      return;
    }

    let data = payload;
    if (typeof payload === 'string') {
      const trimmed = payload.trim();
      if (!trimmed) return;
      if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return;
      try {
        data = JSON.parse(trimmed);
      } catch {
        return;
      }
    }

    if (data?.errors) return;
    applyMiniCartDto(data);
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
        status: data.status,
        requestStartedAt: data.requestStartedAt
      });
    });
  }

  function scrapeCartLines() {
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
  readSponsorPkFromPage();

  // Boot + light poll: getMiniCart is the only cart mirror.
  window.setTimeout(() => requestMiniCartRefresh(), 600);
  window.setTimeout(() => requestMiniCartRefresh(), 1600);
  window.setTimeout(() => requestMiniCartRefresh(), 3200);
  window.setInterval(() => {
    if (dead) return;
    requestMiniCartRefresh();
  }, 2500);

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
        window.setTimeout(() => requestMiniCartRefresh(), 700);
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
          lines: scrapeCartLines(),
          source: 'getMiniCart'
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
