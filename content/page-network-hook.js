(() => {
  if (window.__amiPartsBridgeNetHooked) return;
  window.__amiPartsBridgeNetHooked = true;

  const SOURCE = 'ami-parts-bridge-network';
  const FETCH_SOURCE = 'ami-parts-bridge-fetch-miniquote';
  const NAPA_FETCH_SOURCE = 'ami-parts-bridge-fetch-napa-minicart';

  function emit(url, body, kind, method, status, extra) {
    try {
      window.postMessage(
        {
          source: SOURCE,
          url: String(url || ''),
          body,
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
      const prefixRaw = String(data.cartApiPrefix || '').trim();
      const prefix = /^\/occ\/v2\/[^/]+\/(?:org)?users\/current\/carts\/$/i.test(
        prefixRaw
      )
        ? prefixRaw
        : '/occ/v2/prolinkus/orgUsers/current/carts/';
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
      } catch (_) {
        // ignore
      }
      return setRequestHeader.call(this, name, value);
    };
    OrigXHR.prototype.send = function (...args) {
      try {
        const method = String(this.__amiMethod || 'GET').toUpperCase();
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
            this.responseText || '',
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
})();
