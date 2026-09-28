"use strict";

// Small HTTP client that replaces the deprecated `request` package, which has
// unpatched advisories (SSRF through cross-protocol redirects, and vulnerable
// copies of form-data, tough-cookie and qs). It keeps the parts of request's
// behavior this library relies on:
//   - a tough-cookie jar applied to (and updated from) every hop,
//   - urlencoded (`form`) and multipart (`formData`) bodies, `qs` query strings,
//   - gzip/deflate decoding,
//   - following redirects for GET/HEAD only, and only to http(s) URLs,
//   - a `res.request` object (uri/method/headers/formData) that
//     utils.parseAndCheckLogin uses to retry a failed request.

var http = require("http");
var https = require("https");
var zlib = require("zlib");
var crypto = require("crypto");
var path = require("path");
var stream = require("stream");
var bluebird = require("bluebird");
var toughCookie = require("tough-cookie");

var MAX_REDIRECTS = 10;
// Upper bound on a (decompressed) response body, so a hostile or broken
// response cannot exhaust memory.
var MAX_BODY_BYTES = 64 * 1024 * 1024;
// Overall deadline for one request (all hops), on top of the idle timeout, so
// a server trickling bytes can't hold a request open forever.
var MAX_REQUEST_MS = 5 * 60 * 1000;

// request didn't reuse connections; a pooled socket the server has already
// closed fails a POST with "socket hang up", so keep that behavior.
var agents = {
  "http:": new http.Agent({ keepAlive: false }),
  "https:": new https.Agent({ keepAlive: false })
};

// Uploaded streams can only be read once, but parseAndCheckLogin retries a
// failed upload with the same form. Remember what each stream contained.
var streamContents = new WeakMap();

var MIME_TYPES = {
  ".aac": "audio/aac",
  ".avi": "video/x-msvideo",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".zip": "application/zip"
};

// Same interface as request's jar (setCookie/getCookies/getCookieString), so
// ctx.jar keeps working everywhere it is used.
function Jar() {
  this._jar = new toughCookie.CookieJar(undefined, { looseMode: true });
}

Jar.prototype.setCookie = function(cookie, url, options) {
  return this._jar.setCookieSync(cookie, url, options || {});
};

Jar.prototype.getCookies = function(url) {
  return this._jar.getCookiesSync(url);
};

Jar.prototype.getCookieString = function(url) {
  return this._jar.getCookieStringSync(url);
};

function findHeader(headers, name) {
  var lower = name.toLowerCase();
  return Object.keys(headers).filter(function(key) {
    return key.toLowerCase() === lower;
  })[0];
}

function setHeader(headers, name, value) {
  var existing = findHeader(headers, name);
  if (existing) delete headers[existing];
  headers[name] = value;
}

// RFC 3986 encoding, as the `qs` package (used by request for `form` and
// `qs`) does it.
function encode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, function(c) {
    return (
      "%" +
      c
        .charCodeAt(0)
        .toString(16)
        .toUpperCase()
    );
  });
}

// Serializes like qs.stringify's defaults: nested objects and arrays become
// `a[b]=` / `a[0]=` keys, undefined values are skipped and null becomes empty.
function encodeForm(obj) {
  var parts = [];
  function add(key, value) {
    if (value === undefined) return;
    if (value === null) {
      parts.push(encode(key) + "=");
    } else if (Array.isArray(value)) {
      value.forEach(function(item, i) {
        add(key + "[" + i + "]", item);
      });
    } else if (value instanceof Date) {
      parts.push(encode(key) + "=" + encode(value.toISOString()));
    } else if (typeof value === "object" && !Buffer.isBuffer(value)) {
      Object.keys(value).forEach(function(k) {
        add(key + "[" + k + "]", value[k]);
      });
    } else {
      parts.push(encode(key) + "=" + encode(String(value)));
    }
  }
  Object.keys(obj || {}).forEach(function(key) {
    add(key, obj[key]);
  });
  return parts.join("&");
}

function appendQuery(url, qs) {
  var query = encodeForm(qs);
  if (!query) return url;
  var target = new URL(url);
  target.search = target.search ? target.search + "&" + query : "?" + query;
  return target.href;
}

function isStream(value) {
  return value instanceof stream.Stream && typeof value.pipe === "function";
}

function readStream(readable) {
  if (streamContents.has(readable)) {
    return Promise.resolve(streamContents.get(readable));
  }
  return new Promise(function(resolve, reject) {
    if (readable.readableEnded || readable.destroyed) {
      return reject(
        new Error("Cannot upload a stream that has already been read.")
      );
    }
    var chunks = [];
    readable.on("data", function(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    readable.on("end", function() {
      var buf = Buffer.concat(chunks);
      streamContents.set(readable, buf);
      resolve(buf);
    });
    readable.on("error", reject);
  });
}

// Field names and filenames are escaped the way browsers do it, so a value
// cannot break out of its Content-Disposition header.
function escapeHeaderParam(value) {
  return String(value)
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/"/g, "%22");
}

function guessFilename(value, options) {
  if (options.filename) return options.filename;
  if (typeof value.path === "string") return path.basename(value.path);
  if (typeof value.name === "string") return path.basename(value.name);
  // An http.IncomingMessage (e.g. a piped download).
  if (
    value.client &&
    value.client._httpMessage &&
    value.client._httpMessage.path
  ) {
    return path.basename(value.client._httpMessage.path.split("?")[0]);
  }
  return null;
}

function guessContentType(value, filename, options) {
  if (options.contentType) return options.contentType;
  var ext = filename ? path.extname(filename).toLowerCase() : "";
  if (MIME_TYPES[ext]) return MIME_TYPES[ext];
  if (value.headers && value.headers["content-type"]) {
    return value.headers["content-type"];
  }
  return "application/octet-stream";
}

// Builds a multipart/form-data body. Streams are read into memory first so
// the request carries a Content-Length (upload endpoints don't reliably accept
// chunked bodies). Values may be strings/numbers, Buffers, readable streams,
// `{value, options: {filename, contentType}}`, or arrays of those.
function buildMultipart(formData) {
  var boundary =
    "----------------------" + crypto.randomBytes(12).toString("hex");
  var fields = [];
  Object.keys(formData).forEach(function(name) {
    var values = Array.isArray(formData[name])
      ? formData[name]
      : [formData[name]];
    values.forEach(function(value) {
      if (value === undefined) return;
      fields.push({ name: name, value: value });
    });
  });

  return Promise.all(
    fields.map(function(field) {
      var value = field.value;
      var options = {};
      if (
        value &&
        typeof value === "object" &&
        !Buffer.isBuffer(value) &&
        !isStream(value) &&
        "value" in value
      ) {
        options = value.options || {};
        value = value.value;
      }

      var disposition =
        'form-data; name="' + escapeHeaderParam(field.name) + '"';
      if (
        value === null ||
        (typeof value !== "object" && typeof value !== "function")
      ) {
        return {
          headers: "Content-Disposition: " + disposition + "\r\n",
          body: Buffer.from(value === null ? "" : String(value))
        };
      }

      var filename = guessFilename(value, options);
      if (filename)
        disposition += '; filename="' + escapeHeaderParam(filename) + '"';
      var contentType = guessContentType(value, filename, options).replace(
        /[\r\n]/g,
        ""
      );
      var headers =
        "Content-Disposition: " +
        disposition +
        "\r\n" +
        "Content-Type: " +
        contentType +
        "\r\n";
      var body = isStream(value)
        ? readStream(value)
        : Promise.resolve(Buffer.from(value));
      return body.then(function(buf) {
        return { headers: headers, body: buf };
      });
    })
  ).then(function(parts) {
    if (parts.length === 0)
      return { boundary: boundary, body: Buffer.alloc(0) };
    var chunks = [];
    parts.forEach(function(part) {
      chunks.push(
        Buffer.from("--" + boundary + "\r\n" + part.headers + "\r\n")
      );
      chunks.push(part.body);
      chunks.push(Buffer.from("\r\n"));
    });
    chunks.push(Buffer.from("--" + boundary + "--\r\n"));
    return { boundary: boundary, body: Buffer.concat(chunks) };
  });
}

function decoderFor(encoding) {
  switch ((encoding || "").trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
    case "deflate":
      return zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
    case "br":
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}

function prepareBody(options, headers) {
  if (options.formData) {
    return buildMultipart(options.formData).then(function(multipart) {
      setHeader(
        headers,
        "Content-Type",
        "multipart/form-data; boundary=" + multipart.boundary
      );
      return multipart.body;
    });
  }
  if (options.form) {
    if (!findHeader(headers, "Content-Type")) {
      setHeader(headers, "Content-Type", "application/x-www-form-urlencoded");
    }
    return Promise.resolve(
      Buffer.from(
        typeof options.form === "string"
          ? options.form
          : encodeForm(options.form)
      )
    );
  }
  if (options.body !== undefined && options.body !== null) {
    return Promise.resolve(
      Buffer.isBuffer(options.body)
        ? options.body
        : Buffer.from(String(options.body))
    );
  }
  return Promise.resolve(null);
}

function storeCookies(jar, url, res) {
  if (!jar) return;
  (res.headers["set-cookie"] || []).forEach(function(cookie) {
    try {
      jar.setCookie(cookie, url, { ignoreError: true });
    } catch (_err) {
      // A cookie that isn't valid for this URL is dropped, as a browser would.
    }
  });
}

// Credentials the caller set explicitly must not follow a redirect to another
// host (the jar's cookies are scoped per hop anyway).
var CROSS_HOST_UNSAFE = ["authorization", "proxy-authorization", "cookie"];

function withoutCredentials(headers) {
  var out = {};
  Object.keys(headers).forEach(function(key) {
    if (CROSS_HOST_UNSAFE.indexOf(key.toLowerCase()) === -1)
      out[key] = headers[key];
  });
  return out;
}

function send(url, method, headers, body, options, redirectsLeft) {
  return new Promise(function(resolve, reject) {
    var target;
    try {
      target = new URL(url);
    } catch (err) {
      return reject(new Error("Invalid URL: " + url, { cause: err }));
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      return reject(
        new Error("Refusing to request a non-HTTP URL: " + target.protocol)
      );
    }

    var hopHeaders = {};
    Object.keys(headers).forEach(function(key) {
      var lower = key.toLowerCase();
      // Host is always derived from the URL of this hop, so a redirect to
      // another host can't carry the original Host header along.
      if (
        lower === "host" ||
        headers[key] === undefined ||
        headers[key] === null
      )
        return;
      hopHeaders[key] = headers[key];
    });
    if (options.jar) {
      var cookies = options.jar.getCookieString(target.href);
      if (cookies) {
        var existing = findHeader(hopHeaders, "Cookie");
        hopHeaders[existing || "Cookie"] = existing
          ? hopHeaders[existing] + "; " + cookies
          : cookies;
      }
    }
    if (options.gzip) setHeader(hopHeaders, "Accept-Encoding", "gzip, deflate");
    if (body) setHeader(hopHeaders, "Content-Length", body.length);

    var transport = target.protocol === "https:" ? https : http;
    var req = transport.request(
      target,
      {
        method: method,
        headers: hopHeaders,
        agent: agents[target.protocol],
        timeout: options.timeout || 60000
      },
      function(res) {
        storeCookies(options.jar, target.href, res);

        var location = res.headers.location;
        var isRedirect =
          [301, 302, 303, 307, 308].indexOf(res.statusCode) !== -1;
        if (isRedirect && location && options.followRedirect) {
          res.resume();
          if (redirectsLeft <= 0) {
            return reject(
              new Error(
                "Exceeded maximum redirects (" + MAX_REDIRECTS + ") for " + url
              )
            );
          }
          var next;
          try {
            next = new URL(location, target).href;
          } catch (err) {
            return reject(
              new Error("Invalid redirect location: " + location, {
                cause: err
              })
            );
          }
          var nextHeaders =
            new URL(next).host === target.host
              ? headers
              : withoutCredentials(headers);
          return send(
            next,
            method,
            nextHeaders,
            null,
            options,
            redirectsLeft - 1
          ).then(resolve, reject);
        }

        var source = res;
        var decoder =
          options.gzip && method !== "HEAD"
            ? decoderFor(res.headers["content-encoding"])
            : null;
        if (decoder) {
          source = res.pipe(decoder);
          res.on("error", function(err) {
            decoder.destroy(err);
          });
        }

        var chunks = [];
        var size = 0;
        source.on("data", function(chunk) {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy();
            source.destroy();
            return reject(
              new Error("Response body exceeded " + MAX_BODY_BYTES + " bytes.")
            );
          }
          chunks.push(chunk);
        });
        source.on("error", reject);
        source.on("end", function() {
          var buf = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            headers: res.headers,
            body:
              options.encoding === null
                ? buf
                : buf.toString(options.encoding || "utf8"),
            request: {
              uri: target,
              href: target.href,
              method: method,
              headers: headers,
              formData: options.formData || options.form
            }
          });
        });
      }
    );

    req.setTimeout(options.timeout || 60000, function() {
      var err = new Error(
        "Request timed out: " + method + " " + target.origin + target.pathname
      );
      err.code = "ETIMEDOUT";
      req.destroy(err);
    });
    req.on("error", reject);
    req.end(body || undefined);
  });
}

// options: {url, method, qs, headers, form | formData | body, jar, gzip,
// timeout, followRedirect, encoding}. Resolves with {statusCode, headers,
// body, request}. Returns a bluebird promise, like the request wrapper did.
function request(options) {
  var method = (options.method || "GET").toUpperCase();
  var headers = Object.assign({}, options.headers);
  var opts = Object.assign({}, options, {
    followRedirect:
      options.followRedirect !== undefined
        ? options.followRedirect
        : method === "GET" || method === "HEAD"
  });
  return bluebird
    .try(function() {
      return prepareBody(options, headers);
    })
    .then(function(body) {
      return send(
        appendQuery(options.url, options.qs),
        method,
        headers,
        body,
        opts,
        MAX_REDIRECTS
      );
    })
    .timeout(
      MAX_REQUEST_MS,
      "Request exceeded " +
        MAX_REQUEST_MS / 1000 +
        "s: " +
        method +
        " " +
        options.url
    );
}

module.exports = {
  request: request,
  Jar: Jar,
  encodeForm: encodeForm
};
