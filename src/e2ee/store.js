"use strict";

var fs = require("fs");
var path = require("path");
var cryptoUtils = require("./crypto");

function b64(buf) {
  return Buffer.from(buf).toString("base64");
}

function unb64(value) {
  return Buffer.from(value, "base64");
}

function randomUUID() {
  var bytes = require("crypto").randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  var hex = bytes.toString("hex");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20)
  );
}

function DeviceStore(filePath) {
  this.path = filePath || "";
  this.noiseKeyPriv = null;
  this.identityKeyPair = null;
  this.signedPreKey = null;
  this.registrationId = 0;
  this.facebookUUID = "";
  this.jidUser = "";
  this.jidDevice = 0;
  this.nextPreKeyId = 1;
  this.preKeys = {};
  this.usedPreKeys = {};
  this.usedPreKeyOrder = [];
  this.signedPreKeys = {};
  this.sessions = {};
  this.identities = {};
  this.threads = {};
  this.history = {};
  this.backup = null;
}

DeviceStore.MAX_HISTORY_PER_THREAD = 200;

DeviceStore.prototype.appendHistory = function(threadId, message) {
  var key = String(threadId);
  var list = this.history[key] || [];
  list.push(message);
  if (list.length > DeviceStore.MAX_HISTORY_PER_THREAD) {
    list = list.slice(list.length - DeviceStore.MAX_HISTORY_PER_THREAD);
  }
  this.history[key] = list;
};

DeviceStore.prototype.initialize = function() {
  this.noiseKeyPriv = require("crypto").randomBytes(32);
  this.identityKeyPair = cryptoUtils.generateKeyPair();
  this.signedPreKey = generateSignedPreKey(this.identityKeyPair.priv, 1);
  this.signedPreKeys[this.signedPreKey.id] = this.signedPreKey;
  this.registrationId = require("crypto").randomBytes(2).readUInt16BE(0) & 16383 || 1;
  this.facebookUUID = randomUUID();
  this.nextPreKeyId = 1;
  this.save();
};

function generateSignedPreKey(identityPriv, id) {
  var pair = cryptoUtils.generateKeyPair();
  var signature = cryptoUtils.xeddsaSign(identityPriv, Buffer.concat([Buffer.from([5]), pair.pub]));
  return {
    id: id,
    priv: b64(pair.priv),
    pub: b64(pair.pub),
    signature: b64(signature)
  };
}

DeviceStore.prototype.rotateSignedPreKey = function() {
  var id = (this.signedPreKey ? this.signedPreKey.id : 0) + 1;
  this.signedPreKey = generateSignedPreKey(this.identityKeyPair.priv, id);
  this.signedPreKeys[id] = this.signedPreKey;
  return this.signedPreKey;
};

DeviceStore.prototype.getSignedPreKeyById = function(id) {
  return this.signedPreKeys[id] || (this.signedPreKey && this.signedPreKey.id === id ? this.signedPreKey : null);
};

DeviceStore.prototype.takePreKey = function(id) {
  var key = this.preKeys[id];
  if (key) {
    delete this.preKeys[id];
    // Keep recently used one-time prekeys: a message revoke re-uses the
    // envelope of the message it revokes, including its one-time prekey.
    this.usedPreKeys[id] = key;
    this.usedPreKeyOrder.push(id);
    while (this.usedPreKeyOrder.length > 100) {
      delete this.usedPreKeys[this.usedPreKeyOrder.shift()];
    }
  }
  return key || null;
};

DeviceStore.prototype.getUsedPreKey = function(id) {
  return this.usedPreKeys[id] || null;
};

DeviceStore.prototype.generatePreKeys = function(count) {
  var result = [];
  for (var i = 0; i < count; i++) {
    var id = this.nextPreKeyId++;
    var pair = cryptoUtils.generateKeyPair();
    this.preKeys[id] = { priv: b64(pair.priv), pub: b64(pair.pub) };
    result.push({ id: id, pub: pair.pub, priv: pair.priv });
  }
  this.save();
  return result;
};

DeviceStore.prototype.signedPreKeyPublic = function() {
  return Buffer.concat([Buffer.from([5]), unb64(this.signedPreKey.pub)]);
};

DeviceStore.prototype.identityPublic = function() {
  return this.identityKeyPair.pub;
};

DeviceStore.prototype.save = function() {
  if (!this.path) return;
  var dir = path.dirname(this.path);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) { /* ignore */ }
  var data = {
    version: 1,
    noise_key_priv: b64(this.noiseKeyPriv),
    identity_key_priv: b64(this.identityKeyPair.priv),
    identity_key_pub: b64(this.identityKeyPair.pub),
    signed_pre_key: this.signedPreKey,
    signed_pre_keys: this.signedPreKeys,
    registration_id: this.registrationId,
    facebook_uuid: this.facebookUUID,
    jid_user: this.jidUser,
    jid_device: this.jidDevice,
    next_pre_key_id: this.nextPreKeyId,
    pre_keys: this.preKeys,
    used_pre_keys: this.usedPreKeys,
    used_pre_key_order: this.usedPreKeyOrder,
    sessions: this.sessions,
    identities: this.identities,
    e2ee_threads: this.threads,
    e2ee_history: this.history,
    backup: this.backup
  };
  fs.writeFileSync(this.path, JSON.stringify(data, null, 2), { mode: 384 });
};

DeviceStore.prototype.load = function(data) {
  this.noiseKeyPriv = unb64(data.noise_key_priv);
  this.identityKeyPair = {
    priv: unb64(data.identity_key_priv),
    pub: unb64(data.identity_key_pub)
  };
  this.signedPreKey = data.signed_pre_key;
  this.signedPreKeys = data.signed_pre_keys || {};
  if (this.signedPreKey && this.signedPreKey.id != null && !this.signedPreKeys[this.signedPreKey.id]) {
    this.signedPreKeys[this.signedPreKey.id] = this.signedPreKey;
  }
  this.registrationId = data.registration_id;
  this.facebookUUID = data.facebook_uuid;
  this.jidUser = data.jid_user || "";
  this.jidDevice = data.jid_device || 0;
  this.nextPreKeyId = data.next_pre_key_id || 1;
  this.preKeys = data.pre_keys || {};
  this.usedPreKeys = data.used_pre_keys || {};
  this.usedPreKeyOrder = data.used_pre_key_order || [];
  this.sessions = data.sessions || {};
  this.identities = data.identities || {};
  this.threads = data.e2ee_threads || {};
  this.history = data.e2ee_history || {};
  this.backup = data.backup || null;
};

DeviceStore.fromFile = function(filePath) {
  var store = new DeviceStore(filePath);
  var data = null;
  if (filePath && fs.existsSync(filePath)) {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  }
  if (data) {
    store.load(data);
    if (!store.identityKeyPair || !store.identityKeyPair.priv) store.initialize();
  } else {
    store.initialize();
  }
  return store;
};

module.exports = {
  DeviceStore: DeviceStore,
  randomUUID: randomUUID
};
