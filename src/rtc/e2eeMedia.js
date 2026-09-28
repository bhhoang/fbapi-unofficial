"use strict";

// Parent-side controller for the call E2EE media stack. It spawns
// src/rtc/e2eeMediaRunner.js (a child process with
// --experimental-wasm-type-reflection, required for wasm callbacks) and speaks
// a small JSON protocol with it:
//
//   - E2eeKey messages produced by the wasm are forwarded to `onSendKey`
//     (the signaling client turns them into DATA_MESSAGEs).
//   - The server E2eeState from the JOIN response and every received E2eeKey
//     DATA_MESSAGE are forwarded to the runner.
//   - Encoded audio frames are sent to the runner for SFrame encryption /
//     decryption (one request per frame, answered in order).
//
// The runner also learns the peer identity keys carried by the server state so
// the wasm can verify the E2eeKey exchange.

var childProcess = require("child_process");
var path = require("path");
var log = require("npmlog");
var e2eeState = require("./e2eeState");
var thrift = require("./thrift");
var TType = thrift.TType;

var MAX_PENDING_FRAMES = 100;

// ---------------------------------------------------------------------------
// Server-state parsing: pull "<userId>:<deviceId>" -> identity key out of the
// E2eeState endpointInfos (E2eeServerState field 5 -> E2eeEndpointInfo field 1
// preKeyBundle, whose first top-level 33-byte 0x05-prefixed key is the
// endpoint's identity key).
// ---------------------------------------------------------------------------

function readEndpointInfo(reader) {
  var info = { deviceId: 0, preKeyBundle: null };
  for (reader.readStructBegin();;) {
    var field = reader.readFieldBegin();
    if (field.type === TType.STOP) break;
    if (field.id === 1 && field.type === TType.STRING) {
      info.preKeyBundle = Buffer.from(reader.readBinary());
    } else if (field.id === 3 && field.type === TType.I32) {
      info.deviceId = reader.readI32();
    } else {
      reader.skip(field.type);
    }
  }
  reader.readStructEnd();
  return info;
}

function identityKeyFromPreKeyBundle(bundle) {
  if (!bundle || !bundle.length) return null;
  var reader = new thrift.Reader(bundle);
  try {
    var preferred = null;
    for (reader.readStructBegin();;) {
      var field = reader.readFieldBegin();
      if (field.type === TType.STOP) break;
      if (field.type === TType.STRING) {
        var bytes = Buffer.from(reader.readBinary());
        if (bytes.length === 33 && bytes[0] === 5) {
          if (field.id === 7) return bytes;
          if (!preferred) preferred = bytes;
        }
      } else {
        reader.skip(field.type);
      }
    }
    reader.readStructEnd();
    return preferred;
  } catch (e) {
    return null;
  }
}

function parseServerStateIdentityKeys(bytes) {
  var keys = {};
  var endpoints = [];
  try {
    var reader = new thrift.Reader(bytes);
    for (reader.readStructBegin();;) {
      var field = reader.readFieldBegin();
      if (field.type === TType.STOP) break;
      if (field.id === 5 && field.type === TType.MAP) {
        var map = reader.readMapBegin();
        for (var i = 0; i < map.size; i++) {
          var endpoint = reader.readString();
          var info = readEndpointInfo(reader);
          var userId = endpoint.split(":")[0];
          var identityKey = identityKeyFromPreKeyBundle(info.preKeyBundle);
          endpoints.push({ id: endpoint, deviceId: info.deviceId });
          if (/^\d+$/.test(userId) && info.deviceId && identityKey) {
            keys[userId + ":" + info.deviceId] = identityKey.toString("base64");
          }
        }
      } else {
        reader.skip(field.type);
      }
    }
    reader.readStructEnd();
  } catch (e) {
    log.verbose("call", "Could not parse the E2eeState endpoint infos: " + e.message);
  }
  return { keys: keys, endpoints: endpoints };
}

// Identity keys this library already knows from the messaging E2EE sessions
// (DeviceStore sessions are keyed "<userId>.<deviceId>" and remember the peer's
// identity key).
function identityKeysFromDevice(device) {
  var keys = {};
  Object.keys((device && device.sessions) || {}).forEach(function(address) {
    var match = /^(\d+)\.(\d+)$/.exec(address);
    var session = device.sessions[address];
    if (!match || !session || !session.remoteIdentity) return;
    keys[match[1] + ":" + match[2]] = session.remoteIdentity;
  });
  return keys;
}

// ---------------------------------------------------------------------------

function E2eeMediaSession(options) {
  options = options || {};
  this.options = options;
  this.child = null;
  this.ready = false;
  this.closed = false;
  this.startCallbacks = [];
  this.nextFrameId = 1;
  this.pendingFrames = {};
  this.pendingCount = 0;
  this.droppedFrames = 0;
  this.encryptionEnabled = false;
  // Set by the signaling client: function (recipientUserId, dataBuffer) {}
  this.onSendKey = null;
}

E2eeMediaSession.prototype.start = function(callback) {
  var self = this;
  if (this.child) {
    if (this.ready) return callback();
    this.startCallbacks.push(callback);
    return;
  }
  var device = e2eeState.loadDevice(this.options.e2eeDevicePath);
  if (!device || !device.identity_key_pub || !device.identity_key_priv) {
    return callback(new Error("no E2EE device with identity keys is available"));
  }

  var remoteKeys = identityKeysFromDevice(device);
  var input = {
    wasmPath: this.options.wasmPath,
    userId: String(this.options.userId || device.jid_user || ""),
    deviceId: Number(device.jid_device) || 0,
    identityKeyPub: device.identity_key_pub,
    identityKeyPriv: device.identity_key_priv,
    remoteKeys: remoteKeys,
    mandated: this.options.mandated !== false
  };

  var runnerPath = path.join(__dirname, "e2eeMediaRunner.js");
  try {
    this.child = childProcess.fork(runnerPath, [JSON.stringify(input)], {
      execArgv: ["--experimental-wasm-type-reflection"],
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
  } catch (e) {
    return callback(e);
  }
  this.startCallbacks.push(callback);

  this.child.stdout.on("data", function(chunk) {
    log.verbose("call", "E2EE media: " + chunk.toString().trim());
  });
  this.child.stderr.on("data", function(chunk) {
    log.verbose("call", "E2EE media: " + chunk.toString().trim());
  });
  this.child.on("message", function(message) {
    self.handleChildMessage(message);
  });
  this.child.on("error", function(err) {
    log.warn("call", "E2EE media runner error: " + (err && err.message ? err.message : err));
  });
  this.child.on("exit", function(code) {
    self.closed = true;
    self.ready = false;
    if (self.pendingCount) {
      log.warn("call", "E2EE media runner exited with " + self.pendingCount + " frames pending");
    }
    self.pendingFrames = {};
    self.pendingCount = 0;
    if (!self.exitNotified && code !== 0) {
      log.warn("call", "E2EE media runner exited with code " + code);
    }
    self.exitNotified = true;
  });
};

E2eeMediaSession.prototype.handleChildMessage = function(message) {
  if (!message || !message.t) return;
  switch (message.t) {
    case "ready":
      this.ready = true;
      log.info("call", "E2EE media: frame encryption stack ready");
      this.startCallbacks.splice(0).forEach(function(cb) { cb(); });
      break;

    case "sendE2eeKey":
      if (typeof this.onSendKey === "function") {
        try {
          this.onSendKey(message.to, Buffer.from(message.data, "base64"));
        } catch (e) {
          log.warn("call", "Could not send an E2eeKey message: " + e.message);
        }
      }
      break;

    case "frame": {
      var pending = this.pendingFrames[message.id];
      if (!pending) return;
      delete this.pendingFrames[message.id];
      this.pendingCount--;
      pending(null, message.errorCode, message.data ? Buffer.from(message.data, "base64") : null);
      break;
    }

    case "serverUpdate":
      this.encryptionEnabled = message.result.errorCode === 0;
      log.info("call", "E2EE media: server state processed (errorCode " + message.result.errorCode +
        ", encryption " + (this.encryptionEnabled ? "enabled" : "disabled") + ")");
      if (!this.encryptionEnabled) {
        log.warn("call", "E2EE media: the server did not negotiate E2EE (errorCode " +
          message.result.errorCode + "); frames stay unencrypted");
      }
      break;

    case "messageResult":
      log.verbose("call", "E2EE media: E2eeKey processed (status " + message.result.statusCode + ")");
      break;

    case "remoteIdentityKey":
      log.verbose("call", "E2EE media: learned identity key for " + message.userId + "." + message.deviceId);
      break;

    case "stateSyncNotify":
      log.verbose("call", "E2EE media: state-sync notify for " + message.to +
        " (topic " + message.topic + ", version " + message.version + ", " +
        (message.data ? message.data.length : 0) + " base64 chars)");
      if (typeof this.onStateSyncNotify === "function") {
        this.onStateSyncNotify(message.to, message.topic, message.version,
          message.data ? Buffer.from(message.data, "base64") : Buffer.alloc(0));
      }
      break;

    case "stateSyncSnapshot":
      log.verbose("call", "E2EE media: state-sync snapshot requested");
      if (typeof this.onStateSyncSnapshot === "function") this.onStateSyncSnapshot();
      break;

    case "clientState":
      if (typeof this.onClientState === "function") {
        this.onClientState(Buffer.from(message.data, "base64"));
      }
      break;

    case "log":
      log.verbose("call", "E2EE media: " + message.message);
      break;

    case "error":
      log.warn("call", "E2EE media: " + message.message);
      break;
  }
};

E2eeMediaSession.prototype.sendToChild = function(message) {
  if (!this.child || this.closed) return false;
  try {
    this.child.send(message);
    return true;
  } catch (e) {
    return false;
  }
};

E2eeMediaSession.prototype.processServerState = function(bytes) {
  if (!bytes || !bytes.length) return;
  if (process.env.E2EE_DUMP_STATE) {
    try {
      require("fs").writeFileSync(process.env.E2EE_DUMP_STATE, Buffer.from(bytes));
    } catch (e) { /* debug only */ }
  }
  var parsed = parseServerStateIdentityKeys(Buffer.from(bytes));
  if (Object.keys(parsed.keys).length) {
    this.sendToChild({ t: "remoteKeys", keys: parsed.keys });
  }
  // The peer's media identity (used to bind the frame decryptor) is the full
  // "<userId>:<cname>" string from the endpoint list - the same string the
  // peer uses in its E2eeKey messages. The SFU's SDP carries no cname. The
  // empty join-response state has no endpoints, so the fallback is only used
  // until a populated state arrives.
  var self = this;
  var applied = false;
  parsed.endpoints.forEach(function(endpoint) {
    var userId = endpoint.id.split(":")[0];
    if (String(userId) === String(self.options.userId)) return;
    self.setRemoteE2eeId(endpoint.id);
    applied = true;
  });
  if (!applied && !this.remoteE2eeId) this.setRemoteE2eeId("negotiationOffStreamId");
  this.sendToChild({ t: "serverState", data: Buffer.from(bytes).toString("base64") });
};

E2eeMediaSession.prototype.processE2eeMessage = function(bytes) {
  if (!bytes || !bytes.length) return;
  this.sendToChild({ t: "e2eeMessage", data: Buffer.from(bytes).toString("base64") });
};

E2eeMediaSession.prototype.setLocalE2eeId = function(id) {
  if (!id) return;
  this.sendToChild({ t: "setLocalE2eeId", id: id });
};

E2eeMediaSession.prototype.setRemoteE2eeId = function(id) {
  if (!id || id === this.remoteE2eeId) return;
  this.remoteE2eeId = id;
  log.info("call", "E2EE media: remote media identity " + id);
  this.sendToChild({ t: "setRemoteE2eeId", id: id });
};

// One encrypted frame in flight per direction is enough for audio; when the
// runner falls behind, frames are dropped instead of queued without bound.
E2eeMediaSession.prototype.requestFrame = function(dir, data, callback) {
  if (!this.ready || this.closed) return callback(new Error("not ready"), -1, null);
  if (this.pendingCount >= MAX_PENDING_FRAMES) {
    this.droppedFrames++;
    if (this.droppedFrames === 1 || this.droppedFrames % 100 === 0) {
      log.warn("call", "E2EE media: dropping frames (runner is behind, " +
        this.droppedFrames + " dropped)");
    }
    return callback(new Error("backpressure"), -1, null);
  }
  var id = this.nextFrameId++;
  this.pendingFrames[id] = callback;
  this.pendingCount++;
  if (!this.sendToChild({ t: dir, id: id, data: data.toString("base64") })) {
    delete this.pendingFrames[id];
    this.pendingCount--;
    return callback(new Error("runner gone"), -1, null);
  }
};

// callback(err, errorCode, encryptedBuffer)
E2eeMediaSession.prototype.encrypt = function(data, callback) {
  if (!this.encryptionEnabled) return callback(null, 0, data);
  this.requestFrame("encrypt", data, callback);
};

// callback(err, errorCode, plainBuffer)
E2eeMediaSession.prototype.decrypt = function(data, callback) {
  this.requestFrame("decrypt", data, callback);
};

E2eeMediaSession.prototype.close = function() {
  if (this.closed) return;
  this.closed = true;
  if (this.child) {
    this.sendToChild({ t: "close" });
    var child = this.child;
    setTimeout(function() {
      try { child.kill(); } catch (e) { /* already gone */ }
    }, 1000).unref();
  }
};

module.exports = {
  E2eeMediaSession: E2eeMediaSession,
  parseServerStateIdentityKeys: parseServerStateIdentityKeys
};
