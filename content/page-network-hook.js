(() => {
  if (window.__amiPartsBridgeNetHooked) return;
  window.__amiPartsBridgeNetHooked = true;

  const SOURCE = 'ami-parts-bridge-network';
  const FETCH_SOURCE = 'ami-parts-bridge-fetch-miniquote';
  const NAPA_FETCH_SOURCE = 'ami-parts-bridge-fetch-napa-minicart';
  const WEBEST_GRID_SOURCE = 'ami-parts-bridge-read-webest-grid';
  const WEBEST_DELETE_SOURCE = 'ami-parts-bridge-webest-delete';
  const WEBEST_FILL_VIN_SOURCE = 'ami-parts-bridge-webest-fill-vin';
  const REPAIR_ORDER_READ_SOURCE = 'ami-parts-bridge-read-repair-order';
  const REPAIR_ORDER_CACHE_SOURCE = 'ami-parts-bridge-repair-order-cache';
  const DEFAULT_NAPA_CART_PREFIX = '/occ/v2/prolinkus/users/current/carts/';

  /** @type {string | object | null} */
  let lastRepairOrderBody = null;
  /** @type {string} */
  let lastRepairOrderUrl = '';
  /** @type {Record<string, string>} */
  let lastAutoIntegrateHeaders = {};

  /** @type {Record<string, string>} */
  let lastWebEstHeaders = {};
  /** @type {string} */
  let lastWebEstActionUrl = '';

  function stripJsonKeyArray(text, key) {
    const raw = String(text || '');
    const needle = `"${key}"`;
    const idx = raw.indexOf(needle);
    if (idx < 0) return raw;
    const colon = raw.indexOf(':', idx + needle.length);
    if (colon < 0) return raw;
    let i = colon + 1;
    while (i < raw.length && /\s/.test(raw[i])) i += 1;
    if (raw[i] !== '[') return raw;
    let depth = 0;
    const start = i;
    for (; i < raw.length; i += 1) {
      const ch = raw[i];
      if (ch === '[') depth += 1;
      else if (ch === ']') {
        depth -= 1;
        if (depth === 0) {
          return raw.slice(0, start) + '[]' + raw.slice(i + 1);
        }
      } else if (ch === '"') {
        i += 1;
        while (i < raw.length) {
          if (raw[i] === '\\') {
            i += 2;
            continue;
          }
          if (raw[i] === '"') break;
          i += 1;
        }
      }
    }
    return raw;
  }

  function slimPartRow(part) {
    if (!part || typeof part !== 'object') return part;
    const copy = {};
    const skip = {
      Images: true,
      AftermarketPartOptions: true,
      Base64Img: true,
      hotspot: true,
      image: true
    };
    Object.keys(part).forEach((key) => {
      if (skip[key]) return;
      const value = part[key];
      if (typeof value === 'string' && value.length > 20000) return;
      copy[key] = value;
    });
    return copy;
  }

  function parseMaybeJson(body) {
    if (body && typeof body === 'object') return body;
    if (typeof body !== 'string') return null;
    let raw = body.trim();
    if (!raw) return null;
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const start = raw.search(/[{\[]/);
    if (start < 0) return null;
    if (start > 0) raw = raw.slice(start);
    try {
      return JSON.parse(raw);
    } catch (_) {
      try {
        return JSON.parse(stripJsonKeyArray(raw, 'Images'));
      } catch {
        return null;
      }
    }
  }

  function slimSectionData(data, extra) {
    const parts = Array.isArray(data.Parts) ? data.Parts.map(slimPartRow) : [];
    const sectionId =
      data.SectionID ??
      data.sectionID ??
      parts.find((part) => part && part.SectionID != null)?.SectionID;
    const out = {
      Parts: parts,
      Success: data.Success !== false,
      ErrorMessage: data.ErrorMessage || '',
      SectionID: sectionId
    };
    if (data.FullEstimate || (extra && extra.FullEstimate)) {
      out.FullEstimate = true;
    }
    if (data.PreserveLabor || (extra && extra.PreserveLabor)) {
      out.PreserveLabor = true;
    }
    if (extra && typeof extra === 'object') {
      Object.keys(extra).forEach((key) => {
        if (key === 'FullEstimate' || key === 'PreserveLabor') return;
        out[key] = extra[key];
      });
    }
    return JSON.stringify(out);
  }

  function slimWebEstBody(url, body, kind) {
    if (kind !== 'response') return body;
    const u = String(url || '');
    const isSection = /GetSectionData/i.test(u);
    const isEstimateApi =
      isSection ||
      /SaveEstimateLine|DeleteEstimateLine|GetLinePreview/i.test(u);
    if (!isEstimateApi) return body;

    const data = parseMaybeJson(body);
    if (!data || typeof data !== 'object') {
      if (typeof body === 'string' && isSection) {
        return stripJsonKeyArray(body, 'Images');
      }
      return body;
    }
    if (Array.isArray(data.Parts)) return slimSectionData(data);
    const copy = { ...data };
    delete copy.Images;
    delete copy.AftermarketPartOptions;
    try {
      return JSON.stringify(copy);
    } catch (_) {
      return body;
    }
  }

  function xhrResponseBody(xhr) {
    const type = String(xhr.responseType || '');
    if (type === 'json') {
      try {
        return xhr.response;
      } catch (_) {
        return '';
      }
    }
    try {
      if (xhr.responseText) return xhr.responseText;
    } catch (_) {
      // responseType json/blob throws on responseText
    }
    try {
      return xhr.response != null ? xhr.response : '';
    } catch (_) {
      return '';
    }
  }

  function prepareEmitBody(url, body, kind) {
    return slimWebEstBody(url, body, kind);
  }

  function isWebEstEstimateUrl(url) {
    return /GetSectionData|SaveEstimateLine|DeleteEstimateLine|GetLinePreview/i.test(
      String(url || '')
    );
  }

  function isSyntheticWebEstUrl(url) {
    const value = String(url || '');
    return (
      value === '/Estimate/GetSectionData' ||
      /\/Estimate\/GetManualEntryList/i.test(value)
    );
  }

  function rememberWebEstActionUrl(url) {
    const value = String(url || '').split('?')[0];
    if (!value || isSyntheticWebEstUrl(value) || !isWebEstEstimateUrl(value)) {
      return;
    }
    lastWebEstActionUrl = value;
  }

  function estimatePathPrefix() {
    const match = window.location.pathname.match(/^(\/\d+\/estimate\/\d+)/i);
    return match ? match[1] : '';
  }

  function shopPathPrefix() {
    const match = window.location.pathname.match(/^(\/\d+)/);
    return match ? match[1] : '';
  }

  function siblingWebEstActionUrl(url, action) {
    const value = String(url || '').split('?')[0];
    if (
      !value ||
      !/GetSectionData|SaveEstimateLine|DeleteEstimateLine|GetLinePreview/i.test(
        value
      )
    ) {
      return '';
    }
    return value.replace(
      /GetSectionData|SaveEstimateLine|DeleteEstimateLine|GetLinePreview/i,
      action
    );
  }

  function deleteUrlCandidates(preferred) {
    /** @type {string[]} */
    const urls = [];
    const add = (value) => {
      const next = String(value || '').trim();
      if (!next || urls.includes(next)) return;
      urls.push(next);
    };
    add(preferred);
    add(siblingWebEstActionUrl(lastWebEstActionUrl, 'DeleteEstimateLine'));
    const estimatePrefix = estimatePathPrefix();
    if (estimatePrefix) add(`${estimatePrefix}/DeleteEstimateLine`);
    const shop = shopPathPrefix();
    if (shop) add(`${shop}/Estimate/DeleteEstimateLine`);
    add('/Estimate/DeleteEstimateLine');
    return urls;
  }

  function rowLaborScore(row) {
    if (!row || typeof row !== 'object') return 0;
    const keys = ['RRTime', 'RITime', 'PaintTime', 'LaborTime'];
    let total = 0;
    for (let i = 0; i < keys.length; i += 1) {
      const value = Number(row[keys[i]]);
      if (Number.isFinite(value) && value > 0) total += value;
    }
    return total;
  }

  function laborTextFromRowEl(tr) {
    if (!tr || !tr.querySelectorAll) return '';
    const cells = tr.querySelectorAll('td');
    let best = '';
    for (let i = 0; i < cells.length; i += 1) {
      const text = String(cells[i].innerText || cells[i].textContent || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!/\d+(?:\.\d+)?\s*hrs?\.?/i.test(text)) continue;
      if (text.length > best.length) best = text;
    }
    return best;
  }

  function collectVisibleLaborRows() {
    /** @type {any[]} */
    const rows = [];
    const jq = window.jQuery || window.$;
    if (jq && typeof jq === 'function') {
      jq('.k-grid').each(function () {
        const grid = jq(this).data('kendoGrid');
        if (!grid) return;
        jq(this)
          .find('.k-grid-content tbody tr, .k-grid-content-locked tbody tr, table tbody tr')
          .each(function () {
            const labor = laborTextFromRowEl(this);
            if (!labor) return;
            let json = {};
            try {
              const item = grid.dataItem && grid.dataItem(this);
              json = item && typeof item.toJSON === 'function' ? item.toJSON() : item || {};
            } catch (_) {
              json = {};
            }
            rows.push({
              ...json,
              LaborItems: labor,
              Labor: labor
            });
          });
      });
    }
    document.querySelectorAll('table').forEach((table) => {
      const headerEls = table.querySelectorAll('thead th, thead td');
      if (!headerEls.length) return;
      const headers = [];
      headerEls.forEach((cell) => {
        headers.push(
          String(cell.textContent || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase()
        );
      });
      const pnIdx = headers.findIndex((h) => h.includes('part number'));
      const laborIdx = headers.findIndex((h) => h === 'labor' || h.startsWith('labor'));
      const nameIdx = headers.findIndex(
        (h) => h.includes('part name') || h.includes('description')
      );
      const priceIdx = headers.findIndex((h) => h.includes('price'));
      if (pnIdx < 0 && laborIdx < 0) return;
      table.querySelectorAll('tbody tr').forEach((tr) => {
        const cells = tr.querySelectorAll('td');
        const partNumber =
          pnIdx >= 0 ? String(cells[pnIdx]?.textContent || '').trim() : '';
        const labor =
          laborIdx >= 0
            ? String(cells[laborIdx]?.innerText || cells[laborIdx]?.textContent || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
            : laborTextFromRowEl(tr);
        const description =
          nameIdx >= 0
            ? String(cells[nameIdx]?.textContent || '')
                .replace(/\s+/g, ' ')
                .trim()
            : '';
        if (!partNumber && !description) return;
        if (!labor && !partNumber) return;
        rows.push({
          PartNumber: partNumber,
          Description: description,
          Price:
            priceIdx >= 0 ? String(cells[priceIdx]?.textContent || '') : '',
          LaborItems: labor,
          Labor: labor
        });
      });
    });
    return rows;
  }

  function laborDisplayText(row) {
    if (!row || typeof row !== 'object') return '';
    const value =
      row.LaborItems ?? row.laborItems ?? row.Labor ?? row.labor ?? '';
    if (typeof value === 'string') return value.trim();
    if (value == null) return '';
    return String(value).trim();
  }

  function attachLaborDisplay(parts, estimateRows) {
    if (!Array.isArray(parts) || !Array.isArray(estimateRows) || !estimateRows.length) {
      return parts;
    }
    /** @type {Record<string, string>} */
    const byId = {};
    /** @type {Record<string, string>} */
    const byPn = {};
    estimateRows.forEach((row) => {
      const text = laborDisplayText(row);
      if (!text || !/\d+(?:\.\d+)?\s*hrs?\.?/i.test(text)) return;
      const id = Number(row.EstimateLineID ?? row.ID ?? 0);
      const pn = String(row.PartNumber || row.partNumber || '').trim();
      if (id > 0 && (!byId[String(id)] || text.length > byId[String(id)].length)) {
        byId[String(id)] = text;
      }
      if (pn && (!byPn[pn] || text.length > byPn[pn].length)) {
        byPn[pn] = text;
      }
    });
    return parts.map((part) => {
      const id = String(part.EstimateLineID ?? part.ID ?? '');
      const pn = String(part.PartNumber || part.partNumber || '').trim();
      const text = byId[id] || byPn[pn];
      if (!text) return part;
      return { ...part, LaborItems: text };
    });
  }

  function rememberWebEstHeaders(headers, url) {
    if (!headers || !isWebEstEstimateUrl(url)) return;
    try {
      /** @type {Record<string, string>} */
      const next = {};
      const keep = [
        'accept',
        'content-type',
        'requestverificationtoken',
        'x-requested-with'
      ];
      const read = (name) => {
        if (typeof headers.get === 'function') return headers.get(name);
        if (typeof headers === 'object') {
          const found = Object.keys(headers).find(
            (k) => k.toLowerCase() === name.toLowerCase()
          );
          return found ? headers[found] : null;
        }
        return null;
      };
      keep.forEach((name) => {
        const value = read(name);
        if (value) next[name] = String(value);
      });
      if (Object.keys(next).length) {
        lastWebEstHeaders = { ...lastWebEstHeaders, ...next };
      }
    } catch (_) {
      // ignore
    }
  }

  function isRepairOrderUrl(url) {
    return /\/RepairOrders\/\d+(?!\d)(?!\/)/i.test(String(url || ''));
  }

  function repairOrderIdFromUrl(url) {
    const match = String(url || '').match(/\/RepairOrders\/(\d+)(?!\d)(?!\/)/i);
    return match ? match[1] : '';
  }

  function repairOrderIdFromPage(hint) {
    const hinted = String(hint || '').trim();
    if (/^\d+$/.test(hinted)) return hinted;
    try {
      const params = new URLSearchParams(window.location.search);
      const jsId = String(params.get('jsId') || '').trim();
      if (/^\d+$/.test(jsId)) return jsId;
    } catch (_) {
      // ignore
    }
    try {
      const match = String(window.location.href).match(/[?&]jsId=(\d+)/i);
      if (match) return match[1];
    } catch (_) {
      // ignore
    }
    return repairOrderIdFromUrl(lastRepairOrderUrl);
  }

  function rememberAutoIntegrateHeaders(headers, url) {
    try {
      if (!headers || !/\/RepairOrders\//i.test(String(url || ''))) return;
      /** @type {Record<string, string>} */
      const next = {};
      const keep = [
        'accept',
        'authorization',
        'content-type',
        'x-autointegrate-correlationid',
        'x-autointegrate-enable-localization'
      ];
      const read = (name) => {
        if (typeof headers.get === 'function') return headers.get(name);
        if (typeof headers === 'object') {
          const found = Object.keys(headers).find(
            (k) => k.toLowerCase() === name.toLowerCase()
          );
          return found ? headers[found] : null;
        }
        return null;
      };
      keep.forEach((name) => {
        const value = read(name);
        if (value) next[name] = String(value);
      });
      if (Object.keys(next).length) {
        lastAutoIntegrateHeaders = { ...lastAutoIntegrateHeaders, ...next };
      }
    } catch (_) {
      // ignore
    }
  }

  function rememberRepairOrder(url, body, kind) {
    if (kind && kind !== 'response') return;
    if (!isRepairOrderUrl(url)) return;
    if (body == null || body === '') return;
    lastRepairOrderUrl = String(url || '');
    lastRepairOrderBody = body;
  }

  function postRepairOrderCache(body, url) {
    window.postMessage(
      {
        source: REPAIR_ORDER_CACHE_SOURCE,
        url: url || lastRepairOrderUrl,
        body: body != null ? body : lastRepairOrderBody
      },
      '*'
    );
  }

  function replyRepairOrderCache(hintId) {
    const pageId = repairOrderIdFromPage(hintId);
    const cachedId = repairOrderIdFromUrl(lastRepairOrderUrl);
    if (lastRepairOrderBody && cachedId && (!pageId || cachedId === pageId)) {
      postRepairOrderCache(lastRepairOrderBody, lastRepairOrderUrl);
      return;
    }
    if (!pageId || !origFetch) {
      postRepairOrderCache(lastRepairOrderBody, lastRepairOrderUrl);
      return;
    }
    const url = `https://api.autointegrate.com/RepairOrders/${pageId}`;
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      ...lastAutoIntegrateHeaders
    };
    origFetch(url, {
      method: 'GET',
      credentials: 'include',
      headers,
      cache: 'no-store'
    })
      .then((response) => response.text().then((text) => ({ response, text })))
      .then(({ response, text }) => {
        if (response.ok && text) {
          emit(response.url || url, text, 'response', 'GET', response.status);
        }
        postRepairOrderCache(lastRepairOrderBody || text, lastRepairOrderUrl || url);
      })
      .catch(() => {
        postRepairOrderCache(lastRepairOrderBody, lastRepairOrderUrl);
      });
  }

  function emit(url, body, kind, method, status, extra) {
    rememberRepairOrder(url, body, kind);
    try {
      window.postMessage(
        {
          source: SOURCE,
          url: String(url || ''),
          body: prepareEmitBody(url, body, kind),
          kind: kind || 'response',
          method: method || '',
          status: status == null ? undefined : Number(status),
          ...(extra && typeof extra === 'object' ? extra : {})
        },
        '*'
      );
    } catch (_) {
      // ignore
    }
  }

  /** ProLink getMiniCart lives under /users/ — /orgUsers/ returns 404. */
  function normalizeNapaCartPrefix(prefixRaw) {
    const raw = String(prefixRaw || '').trim();
    if (/^\/occ\/v2\/[^/]+\/(?:org)?users\/current\/carts\/$/i.test(raw)) {
      return raw.replace(/\/orgUsers\//i, '/users/');
    }
    return DEFAULT_NAPA_CART_PREFIX;
  }

  function bodyToText(body) {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    try {
      if (typeof body === 'object') return JSON.stringify(body);
    } catch (_) {
      // ignore
    }
    return '';
  }

  function csrfToken() {
    try {
      const meta = document.querySelector(
        'meta[name="csrf-token"], meta[name="_csrf"], meta[name="CSRF-TOKEN"], meta[name="csrfToken"]'
      );
      if (meta && meta.getAttribute('content')) return meta.getAttribute('content');
    } catch (_) {
      // ignore
    }
    try {
      const input = document.querySelector(
        'input[name="_csrf"], input[name="csrf"], input[name="csrfToken"]'
      );
      if (input && input.value) return input.value;
    } catch (_) {
      // ignore
    }
    try {
      const match = document.cookie.match(
        /(?:^|;\s*)(?:XSRF-TOKEN|csrfToken|CSRF-TOKEN|_csrf)=([^;]+)/i
      );
      if (match) return decodeURIComponent(match[1]);
    } catch (_) {
      // ignore
    }
    try {
      // Page-world only: FirstCall / Angular sometimes expose the token on window.
      const candidates = [
        window.csrfToken,
        window._csrf,
        window.CSRF_TOKEN,
        window.csrf,
        window.__csrfToken
      ];
      for (const value of candidates) {
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
    } catch (_) {
      // ignore
    }
    return '';
  }

  // Capture CSRF from FirstCall's own XHR/fetch headers for later refresh calls.
  let lastCsrfFromHeader = '';
  /** @type {Record<string, string>} */
  let lastNapaCartHeaders = {};
  function rememberCsrfFromHeaders(headers) {
    try {
      if (!headers) return;
      const token =
        (typeof headers.get === 'function' &&
          (headers.get('x-csrf-token') || headers.get('X-CSRF-TOKEN'))) ||
        '';
      if (token) lastCsrfFromHeader = token;
    } catch (_) {
      // ignore
    }
  }

  function rememberNapaCartHeaders(headers, url) {
    try {
      if (!headers || !/\/occ\/v2\/|graphql/i.test(String(url || ''))) return;
      /** @type {Record<string, string>} */
      const next = {};
      const keep = [
        'accept',
        'authorization',
        'content-type',
        'x-gpc-aces-user',
        'x-gpc-bu',
        'x-gpc-client-id',
        'x-gpc-customer-id',
        'x-gpc-delivery-promise',
        'x-gpc-location-id',
        'x-gpc-page',
        'x-gpc-prolinkid',
        'x-gpc-sessionid',
        'x-gpc-storeid',
        'x-gpc-sub-client-id',
        'x-gpc-useragent',
        'x-gpc-userid',
        'x-gpc-visitorid',
        'x-country-code'
      ];
      const read = (name) => {
        if (typeof headers.get === 'function') return headers.get(name);
        if (typeof headers === 'object') {
          const found = Object.keys(headers).find(
            (k) => k.toLowerCase() === name.toLowerCase()
          );
          return found ? headers[found] : null;
        }
        return null;
      };
      keep.forEach((name) => {
        const value = read(name);
        if (value) next[name] = String(value);
      });
      if (Object.keys(next).length) {
        lastNapaCartHeaders = { ...lastNapaCartHeaders, ...next };
      }
    } catch (_) {
      // ignore
    }
  }

  // Capture native fetch before patching so our own refreshes can avoid double-emit.
  const origFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;

  function isMiniCartUrl(url) {
    return /getminicart/i.test(String(url || ''));
  }

  /** Page-context fetch so FirstCall session cookies / CSRF apply. */
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data) return;

    if (data.source === REPAIR_ORDER_READ_SOURCE) {
      replyRepairOrderCache(data.jsId);
      return;
    }

    if (data.source === FETCH_SOURCE) {
      const worksheetId = String(data.worksheetId || '').trim();
      if (!/^\d+$/.test(worksheetId)) {
        emit('', JSON.stringify({ error: 'missing worksheet id' }), 'response', 'GET');
        return;
      }
      const url = `/FirstCallOnline/worksheet/rest/v2/miniquote/${worksheetId}`;
      const headers = {
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest'
      };
      const token = csrfToken() || lastCsrfFromHeader;
      if (token) headers['x-csrf-token'] = token;

      const doFetch = origFetch || fetch.bind(window);
      doFetch(url, { method: 'GET', credentials: 'include', headers, cache: 'no-store' })
        .then((response) => response.text().then((text) => ({ response, text })))
        .then(({ response, text }) => {
          emit(response.url || url, text, 'response', 'GET', response.status);
        })
        .catch(() => {
          // Do not emit an empty quote on failure — that falsely clears the cart.
        });
      return;
    }

    if (data.source === NAPA_FETCH_SOURCE) {
      const cartCode = String(data.cartCode || '').trim();
      if (!cartCode) {
        return;
      }
      const params = new URLSearchParams({ fields: 'DEFAULT' });
      const sponsorPk = String(data.sponsorPk || '').trim();
      if (sponsorPk) params.set('sponsorPK', sponsorPk);
      const prefix = normalizeNapaCartPrefix(data.cartApiPrefix);
      const url = `${prefix}${encodeURIComponent(cartCode)}/getMiniCart?${params.toString()}`;
      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...lastNapaCartHeaders
      };
      const requestStartedAt = Date.now();

      // Use origFetch so our own refresh is not re-emitted as a page cart event
      // (avoids double-ingest). Emit once with the generation token.
      const doFetch = origFetch || fetch.bind(window);
      doFetch(url, { method: 'GET', credentials: 'include', headers, cache: 'no-store' })
        .then((response) => response.text().then((text) => ({ response, text })))
        .then(({ response, text }) => {
          // Never treat 404/5xx as an empty cart — that wiped Shop Cart on remove.
          if (!response.ok) return;
          emit(response.url || url, text, 'response', 'GET', response.status, {
            requestStartedAt
          });
        })
        .catch(() => {
          // Ignore network failures; keep the last known good cart.
        });
      return;
    }

    if (data.source === WEBEST_GRID_SOURCE) {
      try {
        const jq = window.jQuery || window.$;
        const gridRows = (grid) => {
          if (!grid || !grid.dataSource || typeof grid.dataSource.data !== 'function') {
            return [];
          }
          const dataItems = grid.dataSource.data();
          const rows = [];
          for (let i = 0; i < dataItems.length; i += 1) {
            const item = dataItems[i];
            rows.push(
              item && typeof item.toJSON === 'function' ? item.toJSON() : item
            );
          }
          return rows;
        };

        const manualGrid =
          jq && typeof jq === 'function'
            ? jq('#manualentrylistitem-grid').data('kendoGrid')
            : null;
        if (
          data.refresh &&
          manualGrid &&
          manualGrid.dataSource &&
          typeof manualGrid.dataSource.read === 'function'
        ) {
          manualGrid.dataSource.read();
          return;
        }

        let bestFull = null;
        let bestMixed = null;
        if (jq && typeof jq === 'function') {
          jq('.k-grid').each(function () {
            const grid = jq(this).data('kendoGrid');
            const rows = gridRows(grid);
            if (!rows.length) return;
            const onEstimate = rows.filter(
              (row) => Number(row?.EstimateLineID ?? row?.ID ?? 0) > 0
            );
            if (!onEstimate.length) return;
            if (onEstimate.length === rows.length) {
              if (!bestFull || onEstimate.length >= bestFull.length) {
                bestFull = onEstimate;
              }
              return;
            }
            if (!bestMixed || rows.length > bestMixed.length) {
              bestMixed = rows;
            }
          });
        }

        const visibleLabor = collectVisibleLaborRows();

        if (bestMixed && bestMixed.length) {
          emit(
            '/Estimate/GetSectionData',
            slimSectionData({
              Parts: attachLaborDisplay(bestMixed, [
                ...(bestFull || []),
                ...visibleLabor
              ]),
              Success: true
            }),
            'response',
            'GET',
            200
          );
          return;
        }
        if (bestFull && bestFull.length) {
          const withLabor = attachLaborDisplay(bestFull, visibleLabor);
          const hasLabor =
            withLabor.some((row) => rowLaborScore(row) > 0) ||
            withLabor.some((row) => laborDisplayText(row));
          emit(
            '/Estimate/GetSectionData',
            slimSectionData(
              { Parts: withLabor, Success: true },
              { FullEstimate: true, PreserveLabor: !hasLabor }
            ),
            'response',
            'GET',
            200
          );
          return;
        }
        if (visibleLabor.length) {
          const usable = visibleLabor.filter(
            (row) => Number(row.EstimateLineID ?? row.ID ?? 0) > 0
          );
          if (usable.length) {
            emit(
              '/Estimate/GetSectionData',
              slimSectionData(
                { Parts: usable, Success: true },
                { FullEstimate: true }
              ),
              'response',
              'GET',
              200
            );
          }
          return;
        }

        const rows = gridRows(manualGrid);
        if (!rows.length) return;
        emit(
          '/Estimate/GetManualEntryList',
          JSON.stringify({ Data: rows, Total: rows.length }),
          'response',
          'GET',
          200
        );
      } catch (_) {
        // Keep the last known good estimate lines.
      }
      return;
    }

    if (data.source === WEBEST_DELETE_SOURCE) {
      const url = String(data.url || '');
      const body = data.body == null ? '' : String(data.body);
      const contentType = String(data.contentType || 'application/json');
      const requestId = data.requestId;
      const headers = {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': contentType,
        'X-Requested-With': 'XMLHttpRequest',
        ...lastWebEstHeaders
      };
      try {
        const tokenInput = document.querySelector(
          'input[name="__RequestVerificationToken"]'
        );
        if (
          tokenInput instanceof HTMLInputElement &&
          tokenInput.value &&
          !headers.RequestVerificationToken &&
          !headers.requestverificationtoken
        ) {
          headers.RequestVerificationToken = tokenInput.value;
        }
      } catch (_) {
        // ignore
      }
      const doFetch = origFetch || fetch.bind(window);
      const urls = deleteUrlCandidates(url);
      void (async () => {
        let lastStatus = 0;
        let lastText = '';
        let lastUrl = urls[0] || url;
        for (let i = 0; i < urls.length; i += 1) {
          const candidate = urls[i];
          try {
            const response = await doFetch(candidate, {
              method: 'POST',
              credentials: 'include',
              headers,
              body,
              cache: 'no-store'
            });
            const text = await response.text();
            lastStatus = response.status;
            lastText = text;
            lastUrl = response.url || candidate;
            if (response.status !== 404 && response.status !== 405) break;
          } catch (_) {
            lastStatus = 0;
            lastText = JSON.stringify({
              Success: false,
              ErrorMessage: 'Could not delete estimate line'
            });
            lastUrl = candidate;
          }
        }
        emit(lastUrl, lastText, 'response', 'POST', lastStatus, {
          webestDelete: true,
          requestId
        });
      })();
      return;
    }

    if (data.source === WEBEST_FILL_VIN_SOURCE) {
      const vin = String(data.vin || '').trim();
      if (!vin) return;
      try {
        const nodes = document.querySelectorAll('input, textarea');
        /** @type {HTMLInputElement | HTMLTextAreaElement | null} */
        let input = null;
        let best = -1;
        nodes.forEach((node) => {
          if (
            !(node instanceof HTMLInputElement) &&
            !(node instanceof HTMLTextAreaElement)
          ) {
            return;
          }
          if (node instanceof HTMLInputElement && node.type === 'hidden') return;
          const id = node.id ? String(node.id) : '';
          let labelText = '';
          try {
            if (id) {
              const forLabel = document.querySelector(
                `label[for="${CSS.escape(id)}"]`
              );
              if (forLabel) labelText = forLabel.textContent || '';
            }
          } catch (_) {
            // ignore
          }
          const hay = `${node.name} ${node.id} ${node.placeholder} ${
            node.getAttribute('aria-label') || ''
          } ${labelText}`
            .toLowerCase()
            .replace(/\s+/g, ' ');
          if (/\b(license|plate|tag|regist)\b/.test(hay)) return;
          let score = 0;
          if (/\bvin\b/.test(hay) || hay.includes('vehicle id')) score += 10;
          if (hay.includes('enter vin')) score += 20;
          if (score <= best) return;
          best = score;
          input = node;
        });
        if (!input || best <= 0) return;
        const proto =
          input instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        input.focus();
        if (descriptor?.set) descriptor.set.call(input, vin);
        else input.value = vin;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
        const jq = window.jQuery || window.$;
        if (jq) {
          const $el = jq(input);
          ['kendoMaskedTextBox', 'kendoTextBox', 'kendoComboBox'].forEach(
            (name) => {
              const widget = $el.data(name);
              if (widget && typeof widget.value === 'function') widget.value(vin);
            }
          );
        }
      } catch (_) {
        // ignore
      }
    }
  });

  if (typeof origFetch === 'function') {
    window.fetch = async function (...args) {
      let method = 'GET';
      let url = '';
      const requestStartedAt = Date.now();
      try {
        const input = args[0];
        const init = args[1] || {};
        url =
          typeof input === 'string'
            ? input
            : (input && input.url) || '';
        method = String(init.method || (input && input.method) || 'GET').toUpperCase();
        try {
          const hdrs = init.headers;
          if (hdrs) {
            if (typeof hdrs.get === 'function') {
              rememberCsrfFromHeaders(hdrs);
            } else if (typeof hdrs === 'object') {
              const token = hdrs['x-csrf-token'] || hdrs['X-CSRF-TOKEN'] || hdrs['X-Csrf-Token'];
              if (token) lastCsrfFromHeader = String(token);
            }
            rememberNapaCartHeaders(hdrs, url);
            rememberWebEstHeaders(hdrs, url);
            rememberWebEstActionUrl(url);
            rememberAutoIntegrateHeaders(hdrs, url);
          }
        } catch (_) {
          // ignore
        }
        if (method !== 'GET' && method !== 'HEAD') {
          const reqBody = bodyToText(init.body);
          if (reqBody) emit(url, reqBody, 'request', method);
        }
      } catch (_) {
        // ignore
      }

      const response = await origFetch.apply(this, args);
      try {
        const clone = response.clone();
        const responseUrl =
          typeof args[0] === 'string'
            ? args[0]
            : (args[0] && args[0].url) || url;
        const extra =
          isMiniCartUrl(responseUrl) || isMiniCartUrl(url)
            ? { requestStartedAt }
            : /graphql/i.test(String(responseUrl || url))
              ? { requestStartedAt }
              : undefined;
        clone
          .text()
          .then((text) =>
            emit(responseUrl, text, 'response', method, response.status, extra)
          )
          .catch(() => {});
      } catch (_) {
        // ignore
      }
      return response;
    };
  }

  const OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    const open = OrigXHR.prototype.open;
    const setRequestHeader = OrigXHR.prototype.setRequestHeader;
    const send = OrigXHR.prototype.send;
    OrigXHR.prototype.open = function (method, url, ...rest) {
      this.__amiUrl = url;
      this.__amiMethod = method;
      this.__amiStartedAt = Date.now();
      return open.call(this, method, url, ...rest);
    };
    OrigXHR.prototype.setRequestHeader = function (name, value) {
      try {
        if (String(name).toLowerCase() === 'x-csrf-token' && value) {
          lastCsrfFromHeader = String(value);
        }
        if (!this.__amiHeaders) this.__amiHeaders = {};
        this.__amiHeaders[String(name)] = String(value);
      } catch (_) {
        // ignore
      }
      return setRequestHeader.call(this, name, value);
    };
    OrigXHR.prototype.send = function (...args) {
      try {
        const method = String(this.__amiMethod || 'GET').toUpperCase();
        rememberWebEstHeaders(this.__amiHeaders, this.__amiUrl || '');
        rememberWebEstActionUrl(this.__amiUrl || '');
        rememberAutoIntegrateHeaders(this.__amiHeaders, this.__amiUrl || '');
        if (method !== 'GET' && method !== 'HEAD' && args[0] != null) {
          emit(this.__amiUrl || '', bodyToText(args[0]), 'request', method);
        }
      } catch (_) {
        // ignore
      }
      this.addEventListener('load', function () {
        try {
          const url = this.__amiUrl || '';
          const extra = isMiniCartUrl(url)
            ? { requestStartedAt: this.__amiStartedAt || Date.now() }
            : undefined;
          emit(
            url,
            xhrResponseBody(this),
            'response',
            String(this.__amiMethod || 'GET').toUpperCase(),
            this.status,
            extra
          );
        } catch (_) {
          // ignore
        }
      });
      return send.apply(this, args);
    };
  }

  function hookKendoSectionData() {
    try {
      const kendo = window.kendo;
      const proto =
        kendo &&
        kendo.data &&
        kendo.data.DataSource &&
        kendo.data.DataSource.prototype;
      if (!proto || proto.__amiPartsBridgeHooked) return Boolean(proto);
      proto.__amiPartsBridgeHooked = true;
      const origTrigger = proto.trigger;
      proto.trigger = function (eventName, eventData) {
        try {
          if (String(eventName) === 'requestEnd' && eventData && eventData.response) {
            const resp = eventData.response;
            if (resp && Array.isArray(resp.Parts)) {
              emit(
                '/Estimate/GetSectionData',
                slimSectionData(resp),
                'response',
                'GET',
                200
              );
            }
          }
        } catch (_) {
          // ignore
        }
        return origTrigger.apply(this, arguments);
      };
      return true;
    } catch (_) {
      return false;
    }
  }

  if (!hookKendoSectionData()) {
    window.addEventListener('DOMContentLoaded', hookKendoSectionData, {
      once: true
    });
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      if (hookKendoSectionData() || tries > 40) window.clearInterval(timer);
    }, 250);
  }
})();
