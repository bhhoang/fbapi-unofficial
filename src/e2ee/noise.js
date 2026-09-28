"use strict";

/* global BigInt */

var events = require("events");
var util = require("util");
var websocket = require("../websocket");
var cryptoUtils = require("./crypto");
var binary = require("./binary");

var NOISE_PATTERN = Buffer.from("Noise_XX_25519_AESGCM_SHA256\0\0\0\0", "binary");
var WA_HEADER = Buffer.from([87, 65, 6, 3]);

function encVarint(value) {
  var bytes = [];
  var v = value >>> 0;
  while (v > 127) {
    bytes.push((v & 127) | 128);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function encLenDelim(field, data) {
  var buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  return Buffer.concat([encVarint((field << 3) | 2), encVarint(buf.length), buf]);
}

function decodeLenDelim(data, targetField) {
  var pos = 0;
  while (pos < data.length) {
    var tag = data[pos++];
    var field = tag >> 3;
    var wire = tag & 7;
    if (wire === 2) {
      var len = 0;
      var shift = 0;
      var b;
      do {
        b = data[pos++];
        len |= (b & 127) << shift;
        shift += 7;
      } while (b & 128);
      var value = data.subarray(pos, pos + len);
      pos += len;
      if (field === targetField) return Buffer.from(value);
    } else if (wire === 0) {
      while (pos < data.length && data[pos] & 128) pos++;
      pos++;
    } else {
      break;
    }
  }
  throw new Error("Field " + targetField + " not found in handshake message");
}

function encodeHandshakeMessage(msg) {
  var chunks = [];
  if (msg.clientHello) {
    chunks.push(encLenDelim(2, encLenDelim(1, msg.clientHello.ephemeral)));
  }
  if (msg.clientFinish) {
    var finish = Buffer.concat([
      encLenDelim(1, msg.clientFinish.static),
      encLenDelim(2, msg.clientFinish.payload)
    ]);
    chunks.push(encLenDelim(4, finish));
  }
  return Buffer.concat(chunks);
}

function decodeServerHello(data) {
  var raw = decodeLenDelim(data, 3);
  return {
    ephemeral: decodeLenDelim(raw, 1),
    static: decodeLenDelim(raw, 2),
    payload: decodeLenDelim(raw, 3)
  };
}

function prependLength(data) {
  var header = Buffer.alloc(3);
  header.writeUIntBE(data.length, 0, 3);
  return Buffer.concat([header, data]);
}

function NoiseHandshakeState() {
  this.h = Buffer.from(NOISE_PATTERN);
  this.ck = Buffer.from(NOISE_PATTERN);
  this.k = null;
  this.n = 0;
  this.mixHash(WA_HEADER);
}

NoiseHandshakeState.prototype.mixHash = function(data) {
  this.h = cryptoUtils.sha256(Buffer.concat([this.h, data]));
};

NoiseHandshakeState.prototype.mixKey = function(input) {
  var expanded = cryptoUtils.hkdf(input, this.ck, Buffer.alloc(0), 64);
  this.ck = expanded.subarray(0, 32);
  this.k = expanded.subarray(32, 64);
  this.n = 0;
};

NoiseHandshakeState.prototype.mixSharedSecret = function(priv, pub) {
  this.mixKey(cryptoUtils.dh(priv, pub));
};

NoiseHandshakeState.prototype.buildNonce = function(counter) {
  var nonce = Buffer.alloc(12);
  nonce.writeUInt32BE(counter, 8);
  return nonce;
};

NoiseHandshakeState.prototype.encrypt = function(plaintext) {
  var nonce = this.buildNonce(this.n++);
  var out = cryptoUtils.aesGcmEncrypt(this.k, nonce, plaintext, this.h);
  this.mixHash(out);
  return out;
};

NoiseHandshakeState.prototype.decrypt = function(ciphertext) {
  var nonce = this.buildNonce(this.n++);
  var out = cryptoUtils.aesGcmDecrypt(this.k, nonce, ciphertext, this.h);
  this.mixHash(ciphertext);
  return out;
};

NoiseHandshakeState.prototype.finish = function() {
  var expanded = cryptoUtils.hkdf(Buffer.alloc(0), this.ck, Buffer.alloc(0), 64);
  return {
    sendKey: expanded.subarray(0, 32),
    recvKey: expanded.subarray(32, 64)
  };
};

function RawSocket(url, options) {
  events.EventEmitter.call(this);
  var self = this;
  this.stream = websocket(url, options);
  this.chunks = [];
  this.length = 0;
  this.waiters = [];
  this.closed = false;
  this.error = null;
  this.stream.on("data", function(chunk) {
    self.chunks.push(Buffer.from(chunk));
    self.length += chunk.length;
    self.pump();
  });
  this.stream.on("error", function(err) {
    self.error = err;
    self.fail(err);
    self.emit("error", err);
  });
  this.stream.on("close", function() {
    self.closed = true;
    self.fail(new Error("WebSocket closed"));
    self.emit("close");
  });
}

util.inherits(RawSocket, events.EventEmitter);

RawSocket.prototype.pump = function() {
  while (this.waiters.length && this.length >= this.waiters[0].len) {
    var waiter = this.waiters.shift();
    waiter.resolve(this.take(waiter.len));
  }
};

RawSocket.prototype.take = function(len) {
  var out = Buffer.alloc(len);
  var offset = 0;
  while (offset < len && this.chunks.length) {
    var first = this.chunks[0];
    var remaining = len - offset;
    if (first.length <= remaining) {
      first.copy(out, offset);
      offset += first.length;
      this.chunks.shift();
    } else {
      first.copy(out, offset, 0, remaining);
      this.chunks[0] = first.subarray(remaining);
      offset += remaining;
    }
  }
  this.length -= len;
  return out;
};

RawSocket.prototype.fail = function(err) {
  var waiters = this.waiters;
  this.waiters = [];
  waiters.forEach(function(waiter) {
    waiter.reject(err);
  });
};

RawSocket.prototype.readRaw = function(len) {
  var self = this;
  if (this.length >= len) return Promise.resolve(this.take(len));
  if (this.closed) return Promise.reject(this.error || new Error("WebSocket closed"));
  return new Promise(function(resolve, reject) {
    self.waiters.push({ len: len, resolve: resolve, reject: reject });
  });
};

RawSocket.prototype.write = function(data) {
  this.stream.write(data);
};

RawSocket.prototype.end = function() {
  try {
    this.stream.end();
  } catch (e) { /* ignore */ }
};

function EncryptedFrameSocket(rawSocket, sendKey, recvKey) {
  this.rawSocket = rawSocket;
  this.sendKey = sendKey;
  this.recvKey = recvKey;
  this.sendCounter = 0;
  this.recvCounter = 0;
}

EncryptedFrameSocket.prototype.buildNonce = function(counter) {
  var nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(counter), 4);
  return nonce;
};

EncryptedFrameSocket.prototype.encryptFrame = function(plaintext) {
  var nonce = this.buildNonce(this.sendCounter++);
  var encrypted = cryptoUtils.aesGcmEncrypt(this.sendKey, nonce, plaintext, Buffer.alloc(0));
  var header = Buffer.alloc(3);
  header.writeUIntBE(encrypted.length, 0, 3);
  return Buffer.concat([header, encrypted]);
};

EncryptedFrameSocket.prototype.decryptFrame = function(data) {
  if (data.length <= 16) return Buffer.alloc(0);
  var nonce = this.buildNonce(this.recvCounter++);
  return cryptoUtils.aesGcmDecrypt(this.recvKey, nonce, data, Buffer.alloc(0));
};

EncryptedFrameSocket.prototype.sendFrame = function(data) {
  this.rawSocket.write(this.encryptFrame(data));
};

EncryptedFrameSocket.prototype.readFrame = function() {
  var self = this;
  return this.rawSocket.readRaw(3).then(function(header) {
    var len = header.readUIntBE(0, 3);
    if (len === 0) return Buffer.alloc(0);
    return self.rawSocket.readRaw(len).then(function(payload) {
      return self.decryptFrame(payload);
    });
  });
};

EncryptedFrameSocket.prototype.end = function() {
  this.rawSocket.end();
};

function doHandshake(rawSocket, noiseKeyPriv, clientPayload) {
  var state = new NoiseHandshakeState();
  var ephemeral = cryptoUtils.generateKeyPair();

  state.mixHash(ephemeral.pub);
  var clientHello = encodeHandshakeMessage({ clientHello: { ephemeral: ephemeral.pub } });
  rawSocket.write(Buffer.concat([WA_HEADER, prependLength(clientHello)]));

  return rawSocket
    .readRaw(3)
    .then(function(header) {
      return rawSocket.readRaw(header.readUIntBE(0, 3));
    })
    .then(function(serverHelloRaw) {
      var serverHello = decodeServerHello(serverHelloRaw);
      state.mixHash(serverHello.ephemeral);
      state.mixSharedSecret(ephemeral.priv, serverHello.ephemeral);
      var serverStaticPub = state.decrypt(serverHello.static);
      state.mixSharedSecret(ephemeral.priv, serverStaticPub);
      state.decrypt(serverHello.payload);

      var noisePub = cryptoUtils.publicFromPrivate(noiseKeyPriv);
      var encNoisePub = state.encrypt(noisePub);
      state.mixSharedSecret(noiseKeyPriv, serverHello.ephemeral);
      var encPayload = state.encrypt(clientPayload);
      var clientFinish = encodeHandshakeMessage({
        clientFinish: { static: encNoisePub, payload: encPayload }
      });
      rawSocket.write(prependLength(clientFinish));
      var keys = state.finish();
      return new EncryptedFrameSocket(rawSocket, keys.sendKey, keys.recvKey);
    });
}

function connectNoiseSocket(url, options, noiseKeyPriv, clientPayload) {
  return new Promise(function(resolve, reject) {
    var rawSocket = new RawSocket(url, options);
    var settled = false;
    rawSocket.once("error", function(err) {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    rawSocket.once("close", function() {
      if (!settled) {
        settled = true;
        reject(new Error("WebSocket closed during handshake"));
      }
    });
    setTimeout(function() {
      if (!settled) {
        settled = true;
        reject(new Error("E2EE handshake timed out"));
      }
    }, 15000);
    doHandshake(rawSocket, noiseKeyPriv, clientPayload).then(
      function(socket) {
        if (settled) return;
        settled = true;
        resolve(socket);
      },
      function(err) {
        if (settled) return;
        settled = true;
        reject(err);
      }
    );
  });
}

module.exports = {
  connectNoiseSocket: connectNoiseSocket,
  EncryptedFrameSocket: EncryptedFrameSocket,
  marshal: binary.marshal,
  unmarshal: binary.unmarshal
};
