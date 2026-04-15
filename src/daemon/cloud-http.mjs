/**
 * Thin HTTP JSON helper for optional cloud API calls.
 * Keeps network behavior isolated from daemon lifecycle logic.
 */
export async function httpJson(method, urlStr, body = null, extraHeaders = {}) {
  const parsedUrl = new URL(urlStr);
  const isHttps = parsedUrl.protocol === 'https:';
  const httpMod = isHttps ? (await import('node:https')).default : (await import('node:http')).default;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
    };

    const req = httpMod.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const status = res.statusCode || 0;
        // Non-2xx must reject so callers see a real error instead of a
        // silently-destructured HTML body (breaks cloud-auth with undefineds).
        if (status < 200 || status >= 300) {
          const preview = (data || '').slice(0, 200);
          return reject(new Error(`HTTP ${status} ${urlStr} — ${preview}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          // 2xx but non-JSON body (e.g. empty 204 or plain text) — return the raw string.
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });

    if (body !== null) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}
