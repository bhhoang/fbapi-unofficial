"use strict";

/* global BigInt */

var crypto = require("crypto");

var SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
var PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");

var B = BigInt;
var ZERO = B(0);
var ONE = B(1);
var TWO = B(2);
var EIGHT = B(8);

var P = B("57896044618658097711785492504343953926634992332820282019728792003956564819949");
var Q = B("7237005577332262213973186563042994240857116359379907606001950938285454250989");
var D = B("37095705934669439343138083508754565189542113879843219016388785533085940283555");
var BASE_Y = B("46316835694926478169428394003475163141307993866256225615783033603165251855960");
var SQRT_M1 = B("19681161376707505956807079304988542015446066515923890162744021073123829784752");
var MASK_255 = (ONE << B(255)) - ONE;

function mod(a, m) {
  var r = a % (m || P);
  return r < ZERO ? r + (m || P) : r;
}

function modPow(base, exp, m) {
  var result = ONE;
  var b = mod(base, m);
  var e = exp;
  while (e > ZERO) {
    if (e & ONE) result = (result * b) % m;
    b = (b * b) % m;
    e >>= ONE;
  }
  return result;
}

function inv(a) {
  return modPow(a, P - TWO, P);
}

function bytesToBigIntLE(buf) {
  var out = ZERO;
  for (var i = buf.length - 1; i >= 0; i--) out = (out << EIGHT) | B(buf[i]);
  return out;
}

function bigIntToBytesLE(value, len) {
  var out = Buffer.alloc(len);
  var v = value;
  for (var i = 0; i < len; i++) {
    out[i] = Number(v & B(0xff));
    v >>= EIGHT;
  }
  return out;
}

function sqrtRatio(a) {
  var x = modPow(a, (P + B(3)) >> B(3), P);
  if (mod(x * x) !== mod(a)) x = mod(x * SQRT_M1);
  return x;
}

function basePoint() {
  var x2 = mod((BASE_Y * BASE_Y - ONE) * inv(D * BASE_Y * BASE_Y + ONE));
  var x = sqrtRatio(x2);
  if (x & ONE) x = P - x;
  return { x: x, y: BASE_Y };
}

var BASE = basePoint();

function pointAdd(a, b) {
  if (!a) return b;
  if (!b) return a;
  var dyx = D * a.x * b.x * a.y * b.y;
  var x = mod((a.x * b.y + a.y * b.x) * inv(mod(ONE + dyx)));
  var y = mod((a.y * b.y + a.x * b.x) * inv(mod(ONE - dyx)));
  return { x: x, y: y };
}

function pointNeg(a) {
  return { x: mod(-a.x), y: a.y };
}

function scalarMult(k, point) {
  var result = null;
  var addend = point;
  var n = k;
  while (n > ZERO) {
    if (n & ONE) result = pointAdd(result, addend);
    addend = pointAdd(addend, addend);
    n >>= ONE;
  }
  return result;
}

function encodePoint(point) {
  var out = bigIntToBytesLE(point.y, 32);
  if (point.x & ONE) out[31] |= 0x80;
  return out;
}

function decodePoint(buf) {
  if (buf.length !== 32) return null;
  var y = bytesToBigIntLE(buf) & MASK_255;
  if (y >= P) return null;
  var x2 = mod((y * y - ONE) * inv(D * y * y + ONE));
  var x = sqrtRatio(x2);
  if (mod(x * x) !== x2) return null;
  if (Boolean(x & ONE) !== Boolean(buf[31] & 0x80)) x = P - x;
  return { x: x, y: y };
}

function clampScalar(priv) {
  var out = Buffer.from(priv);
  out[0] &= 0xf8;
  out[31] &= 0x7f;
  out[31] |= 0x40;
  return out;
}

function montgomeryToEdwards(uBuf) {
  var u = bytesToBigIntLE(uBuf) & MASK_255;
  var y = mod((u - ONE) * inv(u + ONE));
  var x2 = mod((y * y - ONE) * inv(D * y * y + ONE));
  var x = sqrtRatio(x2);
  if (x & ONE) x = P - x;
  return { x: x, y: y };
}

function deriveEdwardsKey(priv) {
  var scalar = bytesToBigIntLE(clampScalar(priv));
  var point = scalarMult(scalar, BASE);
  if (point.x & ONE) {
    scalar = Q - scalar;
    point = pointNeg(point);
  }
  return { scalar: scalar, point: point };
}

function hashToScalar(data) {
  return mod(bytesToBigIntLE(sha512(data)), Q);
}

function xeddsaSign(priv, message) {
  var key = deriveEdwardsKey(priv);
  var prefix = Buffer.alloc(32, 0xff);
  prefix[0] = 0xfe;
  var nonce = hashToScalar(Buffer.concat([prefix, priv, message, crypto.randomBytes(64)]));
  var rPoint = scalarMult(nonce, BASE);
  var aEncoded = encodePoint(key.point);
  var h = hashToScalar(Buffer.concat([encodePoint(rPoint), aEncoded, message]));
  var s = mod(nonce + h * key.scalar, Q);
  return Buffer.concat([encodePoint(rPoint), bigIntToBytesLE(s, 32)]);
}

function xeddsaVerify(pub, message, signature) {
  if (signature.length !== 64 || pub.length !== 32) return false;
  var sig = Buffer.from(signature);
  var aEncoded = encodePoint(montgomeryToEdwards(pub));
  aEncoded[31] |= sig[63] & 0x80;
  sig[63] &= 0x7f;
  var aPoint = decodePoint(aEncoded);
  if (!aPoint) return false;
  var rPoint = decodePoint(sig.subarray(0, 32));
  if (!rPoint) return false;
  var s = bytesToBigIntLE(sig.subarray(32, 64));
  if (s >= Q) return false;
  var h = hashToScalar(Buffer.concat([sig.subarray(0, 32), aEncoded, message]));
  var lhs = scalarMult(s, BASE);
  var rhs = pointAdd(rPoint, scalarMult(h, aPoint));
  if (!lhs || !rhs) return false;
  return lhs.x === rhs.x && lhs.y === rhs.y;
}

function generateKeyPair() {
  var pair = crypto.generateKeyPairSync("x25519");
  var privDer = pair.privateKey.export({ type: "pkcs8", format: "der" });
  var pubDer = pair.publicKey.export({ type: "spki", format: "der" });
  return {
    priv: Buffer.from(privDer.subarray(privDer.length - 32)),
    pub: Buffer.from(pubDer.subarray(pubDer.length - 32))
  };
}

function publicFromPrivate(priv) {
  var key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_X25519, priv]),
    format: "der",
    type: "pkcs8"
  });
  var pubDer = crypto.createPublicKey(key).export({ type: "spki", format: "der" });
  return Buffer.from(pubDer.subarray(pubDer.length - 32));
}

function dh(priv, pub) {
  var privateKey = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_X25519, priv]),
    format: "der",
    type: "pkcs8"
  });
  var publicKey = crypto.createPublicKey({
    key: Buffer.concat([SPKI_X25519, pub]),
    format: "der",
    type: "spki"
  });
  return crypto.diffieHellman({ privateKey: privateKey, publicKey: publicKey });
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest();
}

function sha512(data) {
  return crypto.createHash("sha512").update(data).digest();
}

function hmacSha256(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

// HChaCha20 (RFC draft-irtf-cfrg-xchacha), used by Meta's encrypted-backup
// symmetric records to derive the AES-256-GCM key from a message key and the
// first half of the record nonce.
function rotateLeft(value, bits) {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function hchaCha20(key, nonce16) {
  var constants = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];
  var state = constants.slice();
  for (var i = 0; i < 8; i++) state.push(key.readUInt32LE(i * 4));
  for (var j = 0; j < 4; j++) state.push(nonce16.readUInt32LE(j * 4));
  var working = state.slice();

  function quarterRound(a, b, c, d) {
    working[a] = (working[a] + working[b]) >>> 0;
    working[d] = rotateLeft(working[d] ^ working[a], 16);
    working[c] = (working[c] + working[d]) >>> 0;
    working[b] = rotateLeft(working[b] ^ working[c], 12);
    working[a] = (working[a] + working[b]) >>> 0;
    working[d] = rotateLeft(working[d] ^ working[a], 8);
    working[c] = (working[c] + working[d]) >>> 0;
    working[b] = rotateLeft(working[b] ^ working[c], 7);
  }

  for (var round = 0; round < 10; round++) {
    quarterRound(0, 4, 8, 12);
    quarterRound(1, 5, 9, 13);
    quarterRound(2, 6, 10, 14);
    quarterRound(3, 7, 11, 15);
    quarterRound(0, 5, 10, 15);
    quarterRound(1, 6, 11, 12);
    quarterRound(2, 7, 8, 13);
    quarterRound(3, 4, 9, 14);
  }

  var out = Buffer.alloc(32);
  [0, 1, 2, 3, 12, 13, 14, 15].forEach(function(index, position) {
    out.writeUInt32LE(working[index] >>> 0, position * 4);
  });
  return out;
}

function stripEbPadding(data) {
  if (data.length < 4) return Buffer.alloc(0);
  var length = data.readUInt32BE(0);
  if (length > data.length - 4) return Buffer.alloc(0);
  return Buffer.from(data.subarray(4, 4 + length));
}

// Meta encrypted-backup symmetric record:
//   ciphertext = hchachaNonce(16) || iv(12) || AES-256-GCM(data, aad)
//   key        = HChaCha20(messageKey, hchachaNonce)
//   plaintext  = 4-byte big-endian length || data || padding
function ebSymmetricDecrypt(key, aad, ciphertext) {
  var data = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext, "base64");
  if (data.length < 28 + 16) throw new Error("EB ciphertext is too short");
  var nonce = data.subarray(0, 28);
  var body = data.subarray(28);
  var subkey = hchaCha20(key, nonce.subarray(0, 16));
  var plaintext = aesGcmDecrypt(subkey, nonce.subarray(16, 28), body, Buffer.from(aad, "utf8"));
  return stripEbPadding(plaintext);
}

function hkdf(ikm, salt, info, length) {
  return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, length));
}

function aesCbcEncrypt(key, iv, plaintext) {
  var cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesCbcDecrypt(key, iv, ciphertext) {
  var decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function aesGcmEncrypt(key, iv, plaintext, aad) {
  var cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  if (aad && aad.length) cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function aesGcmDecrypt(key, iv, ciphertext, aad) {
  var tag = ciphertext.subarray(ciphertext.length - 16);
  var body = ciphertext.subarray(0, ciphertext.length - 16);
  var decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  if (aad && aad.length) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

module.exports = {
  generateKeyPair: generateKeyPair,
  publicFromPrivate: publicFromPrivate,
  dh: dh,
  xeddsaSign: xeddsaSign,
  xeddsaVerify: xeddsaVerify,
  sha256: sha256,
  sha512: sha512,
  hmacSha256: hmacSha256,
  hkdf: hkdf,
  hchaCha20: hchaCha20,
  ebSymmetricDecrypt: ebSymmetricDecrypt,
  aesCbcEncrypt: aesCbcEncrypt,
  aesCbcDecrypt: aesCbcDecrypt,
  aesGcmEncrypt: aesGcmEncrypt,
  aesGcmDecrypt: aesGcmDecrypt
};
