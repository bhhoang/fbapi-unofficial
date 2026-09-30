"use strict";

// Offline tests for the evicted-device recovery: Meta rejects a device the
// account no longer lists with "<failure reason=\"415\">"; the client should
// re-register that identity under a fresh device id (once per process).

var assert = require("assert");

var clientModule = require("../../src/e2ee/client");

function makeClient(store) {
  var client = Object.create(clientModule.E2EEClient.prototype);
  client.store = store;
  client.ctx = { userID: "1" };
  client._connectCalls = 0;
  client._connect = function() {
    client._connectCalls++;
    return Promise.resolve("connected");
  };
  return client;
}

describe("src/e2ee/client evicted-device recovery", function() {
  it("re-registers the identity and drops stale sessions when the device is rejected with 415", function() {
    var store = {
      jidDevice: 106,
      sessions: { "100035400259877.190@msgr": { rootKey: "x" } },
      saved: 0,
      save: function() { this.saved++; }
    };
    var client = makeClient(store);
    return client.recoverEvictedDevice(new Error("E2EE login failure: 415")).then(function(result) {
      assert.strictEqual(result, "connected");
      assert.strictEqual(store.jidDevice, null);
      assert.deepStrictEqual(store.sessions, {});
      assert.strictEqual(store.saved, 1);
      assert.strictEqual(client._connectCalls, 1);
      assert.strictEqual(client._deviceRecovered, true);
    });
  });

  it("leaves other failures untouched", function() {
    var store = { jidDevice: 106, save: function() {} };
    var client = makeClient(store);
    return client.recoverEvictedDevice(new Error("E2EE login failure: 401")).then(
      function() { throw new Error("should not recover"); },
      function(err) {
        assert.strictEqual(err.message, "E2EE login failure: 401");
        assert.strictEqual(store.jidDevice, 106);
        assert.strictEqual(client._connectCalls, 0);
      }
    );
  });

  it("does not recover a device that was just registered", function() {
    var store = { jidDevice: null, save: function() {} };
    var client = makeClient(store);
    return client.recoverEvictedDevice(new Error("E2EE login failure: 415")).then(
      function() { throw new Error("should not recover"); },
      function() {
        assert.strictEqual(client._connectCalls, 0);
      }
    );
  });

  it("recovers at most once per process", function() {
    var store = { jidDevice: 106, save: function() {} };
    var client = makeClient(store);
    client._deviceRecovered = true;
    return client.recoverEvictedDevice(new Error("E2EE login failure: 415")).then(
      function() { throw new Error("should not recover"); },
      function() {
        assert.strictEqual(client._connectCalls, 0);
      }
    );
  });
});
