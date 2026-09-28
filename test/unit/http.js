"use strict";

// Offline tests for src/http.js (the replacement for `request`), run against a
// local server. Run with `npm run test:unit`.

var assert = require("assert");
var http = require("http");
var zlib = require("zlib");
var fs = require("fs");
var path = require("path");
var client = require("../../src/http");
var utils = require("../../utils");

describe("src/http", function() {
  var server;
  var base;
  var last;

  before(function(done) {
    server = http.createServer(function(req, res) {
      var chunks = [];
      req.on("data", function(c) {
        chunks.push(c);
      });
      req.on("end", function() {
        last = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
        switch (req.url.split("?")[0]) {
          case "/set":
            res.setHeader("Set-Cookie", ["a=1; Path=/", "b=2; Path=/; HttpOnly"]);
            return res.end("ok");
          case "/redirect":
            res.writeHead(302, { Location: "/final", "Set-Cookie": "hop=yes; Path=/" });
            return res.end();
          case "/loop":
            res.writeHead(302, { Location: "/loop" });
            return res.end();
          case "/to-file":
            res.writeHead(302, { Location: "file:///etc/passwd" });
            return res.end();
          case "/gzip":
            res.writeHead(200, { "Content-Encoding": "gzip" });
            return res.end(zlib.gzipSync("compressed body"));
          case "/slow":
            return setTimeout(function() {
              res.end("late");
            }, 500);
          default:
            res.setHeader("Content-Type", "application/json");
            return res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie || null }));
        }
      });
    });
    server.listen(0, "127.0.0.1", function() {
      base = "http://127.0.0.1:" + server.address().port;
      done();
    });
  });

  after(function(done) {
    server.close(done);
  });

  it("stores Set-Cookie in the jar and sends it back", function() {
    var jar = utils.getJar();
    return client
      .request({ url: base + "/set", jar: jar })
      .then(function() {
        return client.request({ url: base + "/echo", jar: jar });
      })
      .then(function(res) {
        assert.strictEqual(JSON.parse(res.body).cookie, "a=1; b=2");
      });
  });

  it("follows GET redirects, keeping cookies from every hop", function() {
    var jar = utils.getJar();
    return client.request({ url: base + "/redirect", jar: jar }).then(function(res) {
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(JSON.parse(res.body).path, "/final");
      assert.strictEqual(JSON.parse(res.body).cookie, "hop=yes");
      assert.strictEqual(res.request.uri.pathname, "/final");
    });
  });

  it("does not follow redirects for POST", function() {
    return client.request({ method: "POST", url: base + "/redirect", form: { a: 1 } }).then(function(res) {
      assert.strictEqual(res.statusCode, 302);
      assert.strictEqual(res.headers.location, "/final");
    });
  });

  it("refuses redirects to non-HTTP URLs", function() {
    return client.request({ url: base + "/to-file" }).then(
      function() {
        throw new Error("should have failed");
      },
      function(err) {
        assert(/non-HTTP/.test(err.message));
      }
    );
  });

  it("stops after too many redirects", function() {
    return client.request({ url: base + "/loop" }).then(
      function() {
        throw new Error("should have failed");
      },
      function(err) {
        assert(/maximum redirects/.test(err.message));
      }
    );
  });

  it("decodes gzip bodies", function() {
    return client.request({ url: base + "/gzip", gzip: true }).then(function(res) {
      assert.strictEqual(res.body, "compressed body");
    });
  });

  it("encodes forms and query strings like request/qs", function() {
    return client
      .request({
        method: "POST",
        url: base + "/form",
        qs: { q: "a b", list: [1, 2] },
        form: { text: "hi & bye!", nested: { x: 1 }, ids: ["7", "8"], skip: undefined, empty: null }
      })
      .then(function() {
        assert.strictEqual(last.url, "/form?q=a%20b&list%5B0%5D=1&list%5B1%5D=2");
        assert.strictEqual(
          last.body.toString(),
          "text=hi%20%26%20bye%21&nested%5Bx%5D=1&ids%5B0%5D=7&ids%5B1%5D=8&empty="
        );
        assert.strictEqual(last.headers["content-type"], "application/x-www-form-urlencoded");
      });
  });

  it("sends multipart bodies with streams, buffers and escaped names", function() {
    var file = path.join(__dirname, "..", "data", "shareAttach.js");
    return client
      .request({
        method: "POST",
        url: base + "/upload",
        formData: {
          field: "value",
          upload: fs.createReadStream(file),
          'bad"\r\nname': { value: Buffer.from("x"), options: { filename: 'a"\r\n.png' } }
        }
      })
      .then(function(res) {
        var type = last.headers["content-type"];
        assert(/^multipart\/form-data; boundary=-+[0-9a-f]{24}$/.test(type), type);
        assert.strictEqual(Number(last.headers["content-length"]), last.body.length);
        var body = last.body.toString();
        assert(body.indexOf('name="field"\r\n\r\nvalue\r\n') !== -1);
        assert(body.indexOf('filename="shareAttach.js"') !== -1);
        assert(body.indexOf(fs.readFileSync(file, "utf8")) !== -1);
        assert(body.indexOf('name="bad%22%0D%0Aname"; filename="a%22%0D%0A.png"') !== -1);
        assert(body.indexOf("Content-Type: image/png") !== -1);
        assert.strictEqual(res.request.headers["Content-Type"].split(";")[0], "multipart/form-data");
      });
  });

  it("can re-send a multipart form whose stream was already uploaded", function() {
    var file = path.join(__dirname, "..", "data", "shareAttach.js");
    var form = { upload: fs.createReadStream(file) };
    return client
      .request({ method: "POST", url: base + "/upload", formData: form })
      .then(function(res) {
        return client.request({ method: "POST", url: base + "/upload", formData: res.request.formData });
      })
      .then(function() {
        assert(last.body.toString().indexOf(fs.readFileSync(file, "utf8")) !== -1);
      });
  });

  it("sends an empty body for an empty multipart form", function() {
    return client.request({ method: "POST", url: base + "/upload", formData: {} }).then(function() {
      assert.strictEqual(last.body.length, 0);
    });
  });

  it("rejects instead of throwing on a bad form value", function() {
    var p = client.request({ method: "POST", url: base + "/upload", formData: { bad: {} } });
    return p.then(
      function() {
        throw new Error("should have failed");
      },
      function(err) {
        assert(err instanceof Error);
      }
    );
  });

  it("puts the query string before a URL fragment", function() {
    return client.request({ url: base + "/echo#frag", qs: { a: 1 } }).then(function() {
      assert.strictEqual(last.url, "/echo?a=1");
    });
  });

  it("drops caller credentials on a redirect to another host", function() {
    // 127.0.0.1 and localhost are different hosts to the client.
    var other = base.replace("127.0.0.1", "localhost");
    var seen = [];
    var redirector = http.createServer(function(req, res) {
      seen.push(req.headers);
      if (req.url === "/start") {
        res.writeHead(302, { Location: other + "/landing" });
        return res.end();
      }
      res.end("ok");
    });
    return new Promise(function(resolve) {
      redirector.listen(0, "127.0.0.1", resolve);
    })
      .then(function() {
        return client.request({
          url: "http://127.0.0.1:" + redirector.address().port + "/start",
          headers: { Authorization: "secret", Cookie: "manual=1", "X-Keep": "yes" }
        });
      })
      .then(function() {
        assert.strictEqual(seen[0].authorization, "secret");
        assert.strictEqual(last.url, "/landing");
        assert.strictEqual(last.headers.authorization, undefined);
        assert.strictEqual(last.headers.cookie, undefined);
        assert.strictEqual(last.headers["x-keep"], "yes");
      })
      .finally(function() {
        redirector.close();
      });
  });

  it("times out", function() {
    return client.request({ url: base + "/slow", timeout: 100 }).then(
      function() {
        throw new Error("should have failed");
      },
      function(err) {
        assert.strictEqual(err.code, "ETIMEDOUT");
      }
    );
  });

  it("utils.get/post keep the old call signatures and return bluebird promises", function() {
    var jar = utils.getJar();
    var p = utils.get(base + "/echo", jar, { obj: { a: 1 } }, { userAgent: "ua" });
    assert.strictEqual(typeof p.spread, "function");
    return p
      .then(function(res) {
        assert.strictEqual(last.headers["user-agent"], "ua");
        assert.strictEqual(last.url, "/echo?obj=%7B%22a%22%3A1%7D");
        assert.strictEqual(res.request.method, "GET");
        return utils.post(base + "/echo", jar, { a: "b" }, {});
      })
      .then(function() {
        assert.strictEqual(last.body.toString(), "a=b");
        assert.strictEqual(last.headers.host, "127.0.0.1:" + server.address().port);
      });
  });
});

describe("cookie jar", function() {
  it("accepts appState-style cookies and exposes request's Cookie API", function() {
    var jar = utils.getJar();
    jar.setCookie("c_user=123; expires=undefined; domain=.facebook.com; path=/;", "http://.facebook.com");
    jar.setCookie("xs=abc; domain=.facebook.com; path=/; secure", "https://www.facebook.com");
    var cookies = jar.getCookies("https://www.facebook.com");
    var names = cookies.map(function(c) {
      return c.key;
    });
    assert.deepStrictEqual(names.sort(), ["c_user", "xs"]);
    assert.strictEqual(cookies[0].cookieString().split("=")[0], cookies[0].key);
    var state = JSON.parse(JSON.stringify(utils.getAppState(jar)));
    assert(state.every(function(c) {
      return c.key && c.value && c.domain;
    }));
  });
});
