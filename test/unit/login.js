"use strict";

// Offline tests for the appState login token fetch, with src/http stubbed so
// no request reaches Facebook.

var assert = require("assert");
var http = require("../../src/http");
var login = require("../../index");

var DTSG = "https://www.facebook.com/ajax/dtsg/?__a=1";
var HOME_HTML =
  '<html>["DTSGInitialData",[],{"token":"home-dtsg"}] ["LSD",[],{"token":"home-lsd"}] "revision":1234,</html>';
var OK_BODY = 'for (;;);{"payload":{}}';

function appState() {
  return [
    { key: "c_user", value: "100000000000001", domain: "facebook.com", path: "/" },
    { key: "xs", value: "x", domain: "facebook.com", path: "/" }
  ];
}

// Replaces src/http's request. `routes` maps a URL without its query string to
// a reply ({status, body, setCookie}) or a function returning one (or a
// promise of one). Other URLs get an empty successful payload.
function stub(routes) {
  var calls = [];
  var original = http.request;
  http.request = function(op) {
    var url = String(op.url || op.uri);
    calls.push({ url: url, method: op.method || "GET", form: op.form, headers: op.headers || {} });
    var route = routes[url.split("?")[0]] || { body: OK_BODY };
    return Promise.resolve(typeof route === "function" ? route(op) : route).then(function(r) {
      return {
        statusCode: r.status || 200,
        headers: r.setCookie ? { "set-cookie": r.setCookie } : {},
        body: r.body,
        request: { uri: { href: url }, headers: {}, method: op.method || "GET" }
      };
    });
  };
  return { calls: calls, restore: function() { http.request = original; } };
}

// Assertions inside library callbacks would be swallowed by its promise
// chains, so failures are passed to done() explicitly.
function guard(done, fn) {
  return function() {
    try {
      fn.apply(this, arguments);
    } catch (err) {
      done(err);
    }
  };
}

function dtsgReply(token) {
  return { body: 'for (;;);{"__ar":1,"payload":{"token":"' + token + '","valid_for":86400,"expire":1}}' };
}

// Runs api.markAsReadAll (a POST through the default request helpers) and
// hands the request it made to `check`.
function firstPostAfter(s, api, done, check) {
  var before = s.calls.length;
  api.markAsReadAll(guard(done, function() {
    var post = s.calls.slice(before).filter(function(c) { return c.method === "POST"; })[0];
    assert(post, "no POST was made");
    check(post);
    done();
  }));
}

describe("login (appState)", function() {
  var s;
  afterEach(function() {
    if (s) s.restore();
    s = null;
  });

  it("gets fb_dtsg from the small token endpoint instead of waiting for the homepage", function(done) {
    var homeRequested = false;
    s = stub({
      "https://www.facebook.com/ajax/dtsg/": dtsgReply("fast-dtsg"),
      "https://www.facebook.com/": function() {
        homeRequested = true;
        return new Promise(function() {}); // never answers
      }
    });
    login({ appState: appState() }, { logLevel: "silent" }, guard(done, function(err, api) {
      if (err) return done(err);
      assert.strictEqual(api.getCurrentUserID(), "100000000000001");
      assert.strictEqual(s.calls[0].url, DTSG);
      assert.strictEqual(homeRequested, true, "the homepage should still be fetched, in the background");
      firstPostAfter(s, api, done, function(post) {
        assert.strictEqual(post.form.fb_dtsg, "fast-dtsg");
      });
    }));
  });

  it("fills in LSD and revision from the homepage in the background", function(done) {
    s = stub({
      "https://www.facebook.com/ajax/dtsg/": dtsgReply("fast-dtsg"),
      "https://www.facebook.com/": { body: HOME_HTML }
    });
    login({ appState: appState() }, { logLevel: "silent" }, guard(done, function(err, api) {
      if (err) return done(err);
      setTimeout(function() {
        firstPostAfter(s, api, done, function(post) {
          assert.strictEqual(post.headers["x-fb-lsd"], "home-lsd");
          assert.strictEqual(String(post.form.__rev), "1234");
          assert.strictEqual(post.form.fb_dtsg, "fast-dtsg");
        });
      }, 20);
    }));
  });

  it("falls back to the homepage when the token endpoint doesn't answer as expected", function(done) {
    s = stub({
      "https://www.facebook.com/ajax/dtsg/": { status: 500, body: "oops" },
      "https://www.facebook.com/": { body: HOME_HTML }
    });
    login({ appState: appState() }, { logLevel: "silent" }, guard(done, function(err, api) {
      if (err) return done(err);
      firstPostAfter(s, api, done, function(post) {
        assert.strictEqual(post.form.fb_dtsg, "home-dtsg");
        assert.strictEqual(post.headers["x-fb-lsd"], "home-lsd");
        assert.strictEqual(String(post.form.__rev), "1234");
      });
    }));
  });

  it("reports an empty sequence-ID reply from listenMqtt clearly", function(done) {
    s = stub({
      "https://www.facebook.com/ajax/dtsg/": dtsgReply("fast-dtsg"),
      "https://www.facebook.com/": { body: HOME_HTML },
      // What Facebook answered for a session it had started limiting.
      "https://www.facebook.com/api/graphqlbatch/": { body: 'for (;;);{"__ar":1,"payload":{}}' }
    });
    login({ appState: appState() }, { logLevel: "silent" }, guard(done, function(err, api) {
      if (err) return done(err);
      api.listenMqtt(guard(done, function(listenErr) {
        assert(listenErr, "listenMqtt should report an error");
        assert(!(listenErr instanceof TypeError), "got a TypeError: " + listenErr.message);
        assert(/empty response/i.test(listenErr.error), String(listenErr.error));
        done();
      }));
    }));
  });

  it("fails when Facebook clears the session cookies", function(done) {
    var reply = dtsgReply("logged-out");
    reply.setCookie = [
      "c_user=deleted; expires=Thu, 01 Jan 1970 00:00:01 GMT; path=/; domain=.facebook.com",
      "xs=deleted; expires=Thu, 01 Jan 1970 00:00:01 GMT; path=/; domain=.facebook.com"
    ];
    s = stub({
      "https://www.facebook.com/ajax/dtsg/": reply,
      "https://www.facebook.com/": { body: HOME_HTML }
    });
    login({ appState: appState() }, { logLevel: "silent" }, guard(done, function(err) {
      assert(err, "login should fail");
      assert(/userID/.test(err.error), String(err.error));
      done();
    }));
  });
});
