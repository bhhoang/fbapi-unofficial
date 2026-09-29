"use strict";

// Offline tests for the XEdDSA signatures in src/e2ee/crypto.js, checked
// against Node's own (OpenSSL) Ed25519 so the two implementations can't agree
// on the same mistake.

var assert = require("assert");
var nodeCrypto = require("crypto");
var cryptoUtils = require("../../src/e2ee/crypto");

var P = (BigInt(1) << BigInt(255)) - BigInt(19);

function modPow(b, e, m) {
  var r = BigInt(1);
  b %= m;
  while (e > BigInt(0)) {
    if (e & BigInt(1)) r = (r * b) % m;
    b = (b * b) % m;
    e >>= BigInt(1);
  }
  return r;
}

function leToBigInt(buf) {
  var out = BigInt(0);
  for (var i = buf.length - 1; i >= 0; i--) out = (out << BigInt(8)) | BigInt(buf[i]);
  return out;
}

function bigIntToLe(v, len) {
  var out = Buffer.alloc(len);
  for (var i = 0; i < len; i++) {
    out[i] = Number(v & BigInt(0xff));
    v >>= BigInt(8);
  }
  return out;
}

// An Ed25519 key made by OpenSSL, as the Montgomery (X25519-style) public key
// XEdDSA uses plus the sign bit that XEdDSA carries in the signature.
function nativeEd25519() {
  var pair = nodeCrypto.generateKeyPairSync("ed25519");
  var edPub = Buffer.from(pair.publicKey.export({ format: "jwk" }).x, "base64url");
  var signBit = edPub[31] & 0x80;
  var y = leToBigInt(edPub) & ((BigInt(1) << BigInt(255)) - BigInt(1));
  // u = (1 + y) / (1 - y)
  var u = (((BigInt(1) + y) % P) * modPow((BigInt(1) - y + P) % P, P - BigInt(2), P)) % P;
  return { privateKey: pair.privateKey, montgomery: bigIntToLe(u, 32), signBit: signBit };
}

describe("src/e2ee/crypto XEdDSA", function() {
  this.timeout(20000);

  it("accepts Ed25519 signatures made by OpenSSL", function() {
    for (var i = 0; i < 16; i++) {
      var key = nativeEd25519();
      var message = nodeCrypto.randomBytes(33 + i);
      var sig = nodeCrypto.sign(null, message, key.privateKey);
      sig[63] |= key.signBit;
      assert.strictEqual(cryptoUtils.xeddsaVerify(key.montgomery, message, sig), true, "iteration " + i);
    }
  });

  it("verifies its own signatures and rejects tampering", function() {
    for (var i = 0; i < 8; i++) {
      var pair = cryptoUtils.generateKeyPair();
      var other = cryptoUtils.generateKeyPair();
      var message = nodeCrypto.randomBytes(33);
      var sig = cryptoUtils.xeddsaSign(pair.priv, message);
      assert.strictEqual(cryptoUtils.xeddsaVerify(pair.pub, message, sig), true);

      var badMessage = Buffer.from(message);
      badMessage[0] ^= 1;
      assert.strictEqual(cryptoUtils.xeddsaVerify(pair.pub, badMessage, sig), false);

      var badSig = Buffer.from(sig);
      badSig[10] ^= 1;
      assert.strictEqual(cryptoUtils.xeddsaVerify(pair.pub, message, badSig), false);

      var flippedSign = Buffer.from(sig);
      flippedSign[63] ^= 0x80;
      assert.strictEqual(cryptoUtils.xeddsaVerify(pair.pub, message, flippedSign), false);

      assert.strictEqual(cryptoUtils.xeddsaVerify(other.pub, message, sig), false);
    }
  });

  it("rejects malformed input", function() {
    var pair = cryptoUtils.generateKeyPair();
    var message = Buffer.from("x");
    var sig = cryptoUtils.xeddsaSign(pair.priv, message);
    assert.strictEqual(cryptoUtils.xeddsaVerify(pair.pub, message, sig.subarray(0, 63)), false);
    assert.strictEqual(cryptoUtils.xeddsaVerify(pair.pub.subarray(0, 31), message, sig), false);
  });

  it("signs and verifies fast enough for session setup", function() {
    var pair = cryptoUtils.generateKeyPair();
    var message = nodeCrypto.randomBytes(33);
    var t = Date.now();
    var sig;
    for (var i = 0; i < 5; i++) sig = cryptoUtils.xeddsaSign(pair.priv, message);
    var signMs = (Date.now() - t) / 5;
    t = Date.now();
    for (var j = 0; j < 20; j++) cryptoUtils.xeddsaVerify(pair.pub, message, sig);
    var verifyMs = (Date.now() - t) / 20;
    // Previously ~1900 ms per signature and ~1100 ms per verification.
    assert(signMs < 250, "xeddsaSign took " + signMs + " ms");
    assert(verifyMs < 20, "xeddsaVerify took " + verifyMs + " ms");
  });
});
