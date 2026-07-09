(() => {
  if (window.__amiPartsBridgeNetHooked) return;
  window.__amiPartsBridgeNetHooked = true;

  const SOURCE = 'ami-parts-bridge-network';

  function emit(url, body, kind) {
    try {
      window.postMessage(
        {
          source: SOURCE,
          url: String(url || ''),
          body,
          kind: kind || 'response'
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

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = async function (...args) {
      try {
        const input = args[0];
        const init = args[1] || {};
        const url =
          typeof input === 'string'
            ? input
            : (input && input.url) || '';
        const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
          const reqBody = bodyToText(init.body);
          if (reqBody) emit(url, reqBody, 'request');
        }
      } catch (_) {
        // ignore
      }

      const response = await origFetch.apply(this, args);
      try {
        const clone = response.clone();
        const url =
          typeof args[0] === 'string'
            ? args[0]
            : (args[0] && args[0].url) || '';
        clone
          .text()
          .then((text) => emit(url, text, 'response'))
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
    const send = OrigXHR.prototype.send;
    OrigXHR.prototype.open = function (method, url, ...rest) {
      this.__amiUrl = url;
      this.__amiMethod = method;
      return open.call(this, method, url, ...rest);
    };
    OrigXHR.prototype.send = function (...args) {
      try {
        const method = String(this.__amiMethod || 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD' && args[0] != null) {
          emit(this.__amiUrl || '', bodyToText(args[0]), 'request');
        }
      } catch (_) {
        // ignore
      }
      this.addEventListener('load', function () {
        try {
          emit(this.__amiUrl || '', this.responseText || '', 'response');
        } catch (_) {
          // ignore
        }
      });
      return send.apply(this, args);
    };
  }
})();
