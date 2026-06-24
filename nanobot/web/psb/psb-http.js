(function () {
  'use strict';

  function apiUrl(path) {
    return new URL(path, window.location.origin).toString();
  }

  function authHeaders(token) {
    var headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  }

  function responseContentType(res) {
    if (!res || !res.headers || typeof res.headers.get !== 'function') return '';
    return String(res.headers.get('content-type') || '').toLowerCase();
  }

  function errorMessageFromBody(body, fallback) {
    if (body && typeof body === 'object') {
      return body.message || body.error || fallback;
    }
    if (typeof body === 'string' && body.trim()) return body.trim();
    return fallback;
  }

  async function readResponseBody(res) {
    var contentType = responseContentType(res);
    if (contentType.indexOf('application/json') !== -1) {
      return res.json();
    }
    if (typeof res.text === 'function') {
      return res.text();
    }
    return null;
  }

  async function fetchJson(path, token) {
    var res = await fetch(apiUrl(path), { headers: authHeaders(token) });
    var body = await readResponseBody(res);
    if (!res.ok) {
      throw new Error(errorMessageFromBody(body, 'HTTP ' + res.status));
    }
    if (body && typeof body === 'object') return body;
    if (typeof body === 'string' && body.trim()) {
      try {
        return JSON.parse(body);
      } catch (_err) {
        throw new Error('response must be JSON');
      }
    }
    return {};
  }

  window.PsbHttp = {
    fetchJson: fetchJson,
  };
})();
