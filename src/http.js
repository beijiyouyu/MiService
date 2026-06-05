const https = require("https");
const http = require("http");
const { URL } = require("url");

function buildCookieString(cookies) {
  if (!cookies || typeof cookies !== "object") return "";
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function parseCookies(setCookieHeaders) {
  const result = {};
  if (!setCookieHeaders) return result;
  const list = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : [setCookieHeaders];
  for (const item of list) {
    const parts = item.split(";")[0].split("=");
    if (parts.length >= 2) {
      result[parts[0].trim()] = parts.slice(1).join("=").trim();
    }
  }
  return result;
}

function request(method, url, options = {}) {
  return new Promise((resolve, reject) => {
    let { data, headers = {}, cookies, rejectUnauthorized = true, maxRedirects = 5 } = options;

    const cookieStr = buildCookieString(cookies);
    if (cookieStr) {
      headers["Cookie"] = cookieStr;
    }

    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === "https:";
    const mod = isHttps ? https : http;

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: { ...headers },
      rejectUnauthorized: rejectUnauthorized,
    };

    if (data && typeof data === "object" && !(data instanceof Buffer)) {
      const formStr = Object.entries(data)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
      reqOptions.headers["Content-Type"] = "application/x-www-form-urlencoded";
      reqOptions.headers["Content-Length"] = Buffer.byteLength(formStr);
      data = formStr;
    } else if (typeof data === "string") {
      reqOptions.headers["Content-Type"] = "application/x-www-form-urlencoded";
      reqOptions.headers["Content-Length"] = Buffer.byteLength(data);
    }

    const req = mod.request(reqOptions, (res) => {
      // Handle redirects - accumulate cookies across redirect chain
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        const intermediateCookies = parseCookies(res.headers["set-cookie"]);
        const accumulated = { ...(cookies || {}), ...intermediateCookies };
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith("/")) {
          redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
        }
        // Consume response to free socket
        res.resume();
        return request(method === "POST" && res.statusCode === 303 ? "GET" : method, redirectUrl, {
          ...options,
          cookies: accumulated,
          maxRedirects: maxRedirects - 1,
        }).then(resolve, reject);
      }

      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        const rawCookies = parseCookies(res.headers["set-cookie"]);
        // Merge accumulated cookies from redirects with final response cookies
        const finalCookies = { ...(cookies || {}), ...rawCookies };
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: body,
          text: () => body.toString("utf-8"),
          json: (contentType) => {
            const str = body.toString("utf-8");
            return JSON.parse(str);
          },
          cookies: finalCookies,
        });
      });
      res.on("error", reject);
    });

    req.on("error", reject);

    if (data) {
      req.write(typeof data === "string" ? data : data.toString());
    }
    req.end();
  });
}

module.exports = { request, buildCookieString, parseCookies };
