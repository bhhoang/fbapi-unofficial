"use strict";

// Offline tests for the recently-used one-time prekey retention (message
// revokes re-use the envelope of the message they revoke, including its
// one-time prekey).

var assert = require("assert");
var DeviceStore = require("../../src/e2ee/store").DeviceStore;

describe("src/e2ee/store prekeys", function() {
  function storeWithPreKeys(count) {
    var store = Object.create(DeviceStore.prototype);
    store.preKeys = {};
    store.usedPreKeys = {};
    store.usedPreKeyOrder = [];
    for (var i = 1; i <= count; i++) {
      store.preKeys[i] = { priv: "priv" + i, pub: "pub" + i };
    }
    return store;
  }

  it("keeps a used one-time prekey for envelope re-use", function() {
    var store = storeWithPreKeys(2);
    var key = store.takePreKey(1);
    assert.strictEqual(key.priv, "priv1");
    assert.strictEqual(store.preKeys[1], undefined);
    assert.strictEqual(store.getUsedPreKey(1).priv, "priv1");
    assert.strictEqual(store.getUsedPreKey(2), null);
  });

  it("bounds the number of retained prekeys", function() {
    var store = storeWithPreKeys(150);
    for (var i = 1; i <= 150; i++) store.takePreKey(i);
    assert.strictEqual(store.usedPreKeyOrder.length, 100);
    assert.strictEqual(store.getUsedPreKey(50), null);
    assert.strictEqual(store.getUsedPreKey(51).priv, "priv51");
    assert.strictEqual(store.getUsedPreKey(150).priv, "priv150");
  });
});
