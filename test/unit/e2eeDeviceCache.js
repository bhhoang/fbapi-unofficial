"use strict";

// Offline tests for the optional E2EE device-list cache
// (globalOptions.e2eeDeviceListCacheMs), with the server request stubbed.

var assert = require("assert");
var E2EEClient = require("../../src/e2ee/client").E2EEClient;

var DEVICES = {
  "100@msgr": ["100.0@msgr", "100.3@msgr"],
  "200@msgr": ["200.0@msgr", "200.7@msgr"]
};

function makeClient(cacheMs) {
  var client = new E2EEClient({ userID: "200", globalOptions: { e2eeDeviceListCacheMs: cacheMs } }, {});
  client.fetches = [];
  client.getDeviceList = function(userJids) {
    client.fetches.push(userJids.slice());
    return Promise.resolve(userJids.reduce(function(all, jid) {
      return all.concat(DEVICES[jid] || []);
    }, []));
  };
  client.sendAck = function() {};
  return client;
}

describe("src/e2ee/client device-list cache", function() {
  it("always asks the server when the option is off (default)", function() {
    var client = makeClient(undefined);
    return client.getDeviceListCached(["100@msgr", "200@msgr"])
      .then(function() { return client.getDeviceListCached(["100@msgr", "200@msgr"]); })
      .then(function(devices) {
        assert.strictEqual(client.fetches.length, 2);
        assert.deepStrictEqual(devices.sort(), ["100.0@msgr", "100.3@msgr", "200.0@msgr", "200.7@msgr"]);
      });
  });

  it("reuses a fresh list and only fetches users it doesn't have", function() {
    var client = makeClient(60000);
    return client.getDeviceListCached(["100@msgr"])
      .then(function() { return client.getDeviceListCached(["100@msgr", "200@msgr"]); })
      .then(function(devices) {
        assert.deepStrictEqual(client.fetches, [["100@msgr"], ["200@msgr"]]);
        assert.deepStrictEqual(devices.sort(), ["100.0@msgr", "100.3@msgr", "200.0@msgr", "200.7@msgr"]);
        return client.getDeviceListCached(["100@msgr", "200@msgr"]);
      })
      .then(function(devices) {
        assert.strictEqual(client.fetches.length, 2);
        assert.strictEqual(devices.length, 4);
      });
  });

  it("fetches again once the entry is older than the option", function() {
    var client = makeClient(50);
    return client.getDeviceListCached(["100@msgr"])
      .then(function() { return new Promise(function(resolve) { setTimeout(resolve, 80); }); })
      .then(function() { return client.getDeviceListCached(["100@msgr"]); })
      .then(function() { assert.strictEqual(client.fetches.length, 2); });
  });

  it("drops a user's list on a devices notification", function() {
    var client = makeClient(60000);
    return client.getDeviceListCached(["100@msgr"])
      .then(function() {
        client.handleNotification({ tag: "notification", attrs: { type: "devices", from: "100@msgr" }, content: [] });
        return client.getDeviceListCached(["100@msgr"]);
      })
      .then(function() { assert.strictEqual(client.fetches.length, 2); });
  });

  it("drops a user's list with forgetDeviceList", function() {
    var client = makeClient(60000);
    return client.getDeviceListCached(["100@msgr", "200@msgr"])
      .then(function() {
        client.forgetDeviceList("100.3@msgr");
        return client.getDeviceListCached(["100@msgr", "200@msgr"]);
      })
      .then(function() { assert.deepStrictEqual(client.fetches[1], ["100@msgr"]); });
  });
});
