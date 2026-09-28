"use strict";
/* global BigInt */

// Builds the "E2eeState" state-sync value an end-to-end encrypted call has to
// carry in its JOIN request. Without it Facebook answers
// "Failed deserializing E2eeClientState, JOIN is mandated".
//
// The value is an Apache Thrift compact-serialized `E2eeClientState`
// (reverse-engineered from a real web-client join, byte-exact): a Signal
// prekey announcement (identity key, signed prekey with its XEdDSA signature
// and one one-time prekey) plus constant capability fields. It is not
// encrypted and not signed as a whole, so it can be built from this library's
// own E2EE device (src/e2ee), which already stores those keys.

var fs = require("fs");
var log = require("npmlog");
var cryptoUtils = require("../e2ee/crypto");
var thrift = require("./thrift");
var TType = thrift.TType;

// The call layer stores and ships the blob opaquely; these outer fields are
// constants observed in the web client (client capabilities/version info).
var OUTER_LIST = [2];
var OUTER_STRUCT_LIST = [{ a: 4, b: 7 }];

function toBuffer(base64, what) {
  if (!base64) throw new Error("E2EE device is missing " + what);
  return Buffer.from(base64, "base64");
}

// Signal public keys are 33 bytes: 0x05 prefix plus the Montgomery u.
function signalPublicKey(buffer, what) {
  if (buffer.length === 32) return Buffer.concat([Buffer.from([5]), buffer]);
  if (buffer.length === 33 && buffer[0] === 5) return buffer;
  throw new Error(what + " has an unexpected format (length " + buffer.length + ")");
}

function writeInnerState(writer, device) {
  var identityPub = signalPublicKey(
    toBuffer(device.identity_key_pub, "identity_key_pub"),
    "identity_key_pub"
  );

  var signedPreKey = device.signed_pre_key;
  if (!signedPreKey || !signedPreKey.pub) {
    throw new Error("E2EE device is missing signed_pre_key");
  }
  var signedPreKeyPub = signalPublicKey(
    toBuffer(signedPreKey.pub, "signed_pre_key.pub"),
    "signed_pre_key.pub"
  );
  var signedPreKeySignature = toBuffer(
    signedPreKey.signature,
    "signed_pre_key.signature"
  );
  if (!cryptoUtils.xeddsaVerify(identityPub.subarray(1), signedPreKeyPub, signedPreKeySignature)) {
    log.warn("call", "Stored signed prekey signature does not verify; re-signing it.");
    signedPreKeySignature = cryptoUtils.xeddsaSign(
      toBuffer(device.identity_key_priv, "identity_key_priv"),
      signedPreKeyPub
    );
  }

  var preKeyId = pickPreKeyId(device);
  var preKey = device.pre_keys && device.pre_keys[String(preKeyId)];
  if (!preKey || !preKey.pub) {
    throw new Error("E2EE device has no one-time prekey to advertise");
  }
  var preKeyPub = signalPublicKey(toBuffer(preKey.pub, "pre_keys[].pub"), "pre_keys[].pub");

  function emptyRegistration(w) {
    w.writeStructField(2, TType.STRUCT, function() {
      w.writeStructBegin();
      w.writeStructField(2, TType.I64, function() { w.writeI64(BigInt(0)); });
      w.writeStructField(3, TType.STRING, function() { w.writeBinary(Buffer.alloc(0)); });
      w.writeFieldStop();
      w.writeStructEnd();
    });
  }

  function signedPreKeyStruct(w, pub, keyId, signature) {
    w.writeStructField(5, TType.STRUCT, function() {
      w.writeStructBegin();
      w.writeStructField(2, TType.STRUCT, function() {
        w.writeStructBegin();
        w.writeStructField(2, TType.STRING, function() { w.writeBinary(pub); });
        w.writeStructField(3, TType.I32, function() { w.writeI32(keyId); });
        w.writeFieldStop();
        w.writeStructEnd();
      });
      w.writeStructField(3, TType.STRING, function() { w.writeBinary(signature); });
      w.writeFieldStop();
      w.writeStructEnd();
    });
  }

  function preKeyStruct(w, pub, keyId) {
    w.writeStructField(6, TType.STRUCT, function() {
      w.writeStructBegin();
      w.writeStructField(2, TType.STRING, function() { w.writeBinary(pub); });
      w.writeStructField(3, TType.I32, function() { w.writeI32(keyId); });
      w.writeFieldStop();
      w.writeStructEnd();
    });
  }

  // Real registration/session block: zeros in every observed client state.
  emptyRegistration(writer);
  writer.writeStructField(3, TType.STRING, function() { writer.writeBinary(Buffer.alloc(0)); });
  writer.writeStructField(4, TType.STRING, function() { writer.writeBinary(identityPub); });
  signedPreKeyStruct(writer, signedPreKeyPub, signedPreKey.id, signedPreKeySignature);
  preKeyStruct(writer, preKeyPub, preKeyId);

  // Field 12 is a zeroed mirror of fields 2..6 in the observed state.
  writer.writeStructField(12, TType.STRUCT, function() {
    writer.writeStructBegin();
    emptyRegistration(writer);
    writer.writeStructField(3, TType.STRING, function() { writer.writeBinary(Buffer.alloc(0)); });
    writer.writeStructField(4, TType.STRING, function() { writer.writeBinary(Buffer.alloc(0)); });
    writer.writeStructField(5, TType.STRUCT, function() {
      writer.writeStructBegin();
      writer.writeStructField(2, TType.STRUCT, function() {
        writer.writeStructBegin();
        writer.writeStructField(2, TType.STRING, function() { writer.writeBinary(Buffer.alloc(0)); });
        writer.writeStructField(3, TType.I32, function() { writer.writeI32(0); });
        writer.writeFieldStop();
        writer.writeStructEnd();
      });
      writer.writeStructField(3, TType.STRING, function() { writer.writeBinary(Buffer.alloc(0)); });
      writer.writeFieldStop();
      writer.writeStructEnd();
    });
    writer.writeStructField(6, TType.STRUCT, function() {
      writer.writeStructBegin();
      writer.writeStructField(2, TType.STRING, function() { writer.writeBinary(Buffer.alloc(0)); });
      writer.writeStructField(3, TType.I32, function() { writer.writeI32(0); });
      writer.writeFieldStop();
      writer.writeStructEnd();
    });
    writer.writeFieldStop();
    writer.writeStructEnd();
  });
}

function pickPreKeyId(device) {
  var ids = Object.keys(device.pre_keys || {})
    .map(Number)
    .filter(function(id) { return !isNaN(id); })
    .sort(function(a, b) { return a - b; });
  if (!ids.length) {
    throw new Error("E2EE device has no pre keys; run api.connectE2EE() first");
  }
  return ids[0];
}

// device: parsed e2ee_device.json. Returns the State.data buffer for the
// E2eeState topic (put it in syncPayload.stateStore.E2eeState = {version: 1, data}).
function buildE2eeClientState(device) {
  if (!device || !device.identity_key_pub) {
    throw new Error("E2EE device is not set up");
  }

  // Field 6 of E2eeClientState is this client's E2EE device id (jid_device).
  // The call key exchange addresses key messages to that device, so it has to
  // match the identity store the frame_encryption wasm uses (getLocalDeviceId).
  var deviceId = Number(device.jid_device) || 0;

  var inner = new thrift.Writer();
  inner.writeStructBegin();
  writeInnerState(inner, device);
  inner.writeFieldStop();
  inner.writeStructEnd();
  var innerBytes = inner.toBuffer();

  var writer = new thrift.Writer();
  writer.writeStructBegin();
  writer.writeStructField(1, TType.STRING, function() { writer.writeBinary(innerBytes); });
  writer.writeStructField(2, TType.LIST, function() {
    writer.writeListBegin(OUTER_LIST.length, TType.I16);
    OUTER_LIST.forEach(function(value) { writer.writeI16(value); });
  });
  writer.writeStructField(3, TType.STRUCT, function() {
    writer.writeStructBegin();
    writer.writeStructField(1, TType.LIST, function() {
      writer.writeListBegin(OUTER_STRUCT_LIST.length, TType.STRUCT);
      OUTER_STRUCT_LIST.forEach(function(item) {
        writer.writeStructBegin();
        writer.writeStructField(1, TType.I16, function() { writer.writeI16(item.a); });
        writer.writeStructField(2, TType.I16, function() { writer.writeI16(item.b); });
        writer.writeFieldStop();
        writer.writeStructEnd();
      });
    });
    writer.writeFieldStop();
    writer.writeStructEnd();
  });
  writer.writeStructField(4, TType.STRUCT, function() {
    writer.writeStructBegin();
    writer.writeStructField(1, TType.I16, function() { writer.writeI16(0); });
    writer.writeStructField(3, TType.BOOL, function() { writer.writeBool(true); });
    writer.writeFieldStop();
    writer.writeStructEnd();
  });
  writer.writeStructField(5, TType.STRUCT, function() {
    writer.writeStructBegin();
    writer.writeStructField(1, TType.I16, function() { writer.writeI16(2); });
    writer.writeFieldStop();
    writer.writeStructEnd();
  });
  writer.writeStructField(6, TType.I32, function() { writer.writeI32(deviceId); });
  writer.writeStructField(7, TType.MAP, function() { writer.writeMapBegin(0, TType.STRING, TType.STRING); });
  writer.writeStructField(8, TType.LIST, function() {
    writer.writeListBegin(1, TType.I32);
    writer.writeI32(0);
  });
  writer.writeFieldStop();
  writer.writeStructEnd();
  return writer.toBuffer();
}

function loadDevice(devicePath) {
  if (!devicePath || !fs.existsSync(devicePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(devicePath, "utf8"));
  } catch (e) {
    log.warn("call", "Could not read the E2EE device file: " + e.message);
    return null;
  }
}

module.exports = {
  buildE2eeClientState: buildE2eeClientState,
  loadDevice: loadDevice
};
