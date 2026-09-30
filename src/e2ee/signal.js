"use strict";

var cryptoUtils = require("./crypto");
var proto = require("./proto");

var ZERO32 = Buffer.alloc(32);
var MESSAGE_VERSION = 3;
var SERIALIZED_PREFIX = 0x34;
var MAC_LENGTH = 8;

function b64ToBuf(value) {
  return Buffer.from(value, "base64");
}

function bufToB64(value) {
  return Buffer.from(value).toString("base64");
}

function parseJid(jid) {
  var at = jid.indexOf("@");
  var userPart = at === -1 ? jid : jid.slice(0, at);
  var server = at === -1 ? "" : jid.slice(at + 1);
  var dot = userPart.indexOf(".");
  var colon = userPart.indexOf(":");
  var userEnd = dot !== -1 ? dot : colon !== -1 ? colon : userPart.length;
  var user = userPart.slice(0, userEnd) || userPart;
  var devicePart = colon !== -1 ? userPart.slice(colon + 1) : dot !== -1 ? userPart.slice(dot + 1) : "0";
  return { user: user, device: Number(devicePart) || 0, server: server };
}

function addressKey(jid) {
  var parsed = parseJid(jid);
  return parsed.user + "." + parsed.device;
}

function concatPublicKey(raw32) {
  return Buffer.concat([Buffer.from([5]), raw32]);
}

function deriveMasterSecret(identityPriv, basePriv, bundle) {
  var theirIdentity = bundle.identityKey;
  var theirSigned = bundle.signedPreKey.publicKey.subarray(1);
  var parts = [
    Buffer.alloc(32, 0xff),
    cryptoUtils.dh(identityPriv, theirSigned),
    cryptoUtils.dh(basePriv, theirIdentity),
    cryptoUtils.dh(basePriv, theirSigned)
  ];
  if (bundle.preKey && bundle.preKey.publicKey) {
    parts.push(cryptoUtils.dh(basePriv, bundle.preKey.publicKey.subarray(1)));
  }
  return Buffer.concat(parts);
}

function createChain(rootKey, theirRatchetKey, ourRatchetPriv) {
  var derived = cryptoUtils.hkdf(
    cryptoUtils.dh(ourRatchetPriv, theirRatchetKey),
    rootKey,
    Buffer.from("WhisperRatchet"),
    64
  );
  return { rootKey: derived.subarray(0, 32), chainKey: derived.subarray(32, 64) };
}

function deriveMessageKeys(messageKey) {
  var derived = cryptoUtils.hkdf(messageKey, ZERO32, Buffer.from("WhisperMessageKeys"), 80);
  return {
    cipherKey: derived.subarray(0, 32),
    macKey: derived.subarray(32, 64),
    iv: derived.subarray(64, 80)
  };
}

function advanceChainKey(chainKey) {
  return {
    messageKey: cryptoUtils.hmacSha256(chainKey, Buffer.from([1])),
    nextChainKey: cryptoUtils.hmacSha256(chainKey, Buffer.from([2]))
  };
}

function computeMac(macKey, senderIdentity, receiverIdentity, serializedBody) {
  return cryptoUtils
    .hmacSha256(macKey, Buffer.concat([senderIdentity, receiverIdentity, serializedBody]))
    .subarray(0, MAC_LENGTH);
}

function stripKeyPrefix(buf) {
  return buf.length === 33 ? Buffer.from(buf.subarray(1)) : Buffer.from(buf);
}

function decodeSignalMessage(ciphertext) {
  if (ciphertext.length < 1 + MAC_LENGTH) {
    throw new Error("Signal message is too short");
  }
  var prefix = ciphertext[0];
  if (prefix !== SERIALIZED_PREFIX && prefix !== 0x33) {
    throw new Error("Unexpected Signal message version " + prefix);
  }
  var bodyWithMac = ciphertext.subarray(1);
  var body = bodyWithMac.subarray(0, bodyWithMac.length - MAC_LENGTH);
  var mac = bodyWithMac.subarray(bodyWithMac.length - MAC_LENGTH);
  var fields = proto.decodeFields(body);
  return {
    prefix: prefix,
    body: body,
    mac: mac,
    ratchetKey: fields[1] ? stripKeyPrefix(fields[1]) : null,
    counter: Number(fields[2] || 0),
    previousCounter: Number(fields[3] || 0),
    ciphertext: fields[4] ? Buffer.from(fields[4]) : Buffer.alloc(0)
  };
}

function decodePreKeySignalMessage(bytes) {
  if (!bytes || bytes.length < 2) throw new Error("PreKeySignalMessage is too short");
  var prefix = bytes[0];
  if (prefix !== SERIALIZED_PREFIX && prefix !== 0x33) {
    throw new Error("Unexpected PreKeySignalMessage version " + prefix);
  }
  var fields = proto.decodeFields(bytes.subarray(1));
  return {
    preKeyId: fields[1] !== undefined ? Number(fields[1]) : null,
    baseKey: fields[2] ? stripKeyPrefix(fields[2]) : null,
    identityKey: fields[3] ? stripKeyPrefix(fields[3]) : null,
    message: fields[4] ? Buffer.from(fields[4]) : null,
    registrationId: Number(fields[5] || 0),
    signedPreKeyId: Number(fields[6] || 0)
  };
}

function deriveMessageKeysForKey(chainKey) {
  var advanced = advanceChainKey(chainKey);
  return {
    keys: deriveMessageKeys(advanced.messageKey),
    nextChainKey: advanced.nextChainKey
  };
}

function skipKeyId(ratchetKeyB64, counter) {
  return ratchetKeyB64 + ":" + counter;
}

function storeSkippedKeys(session, ratchetKeyB64, fromCounter, toCounter) {
  if (toCounter <= fromCounter || !session.receiverChainKey) return;
  session.skippedKeys = session.skippedKeys || {};
  var chainKey = b64ToBuf(session.receiverChainKey);
  for (var index = fromCounter; index < toCounter; index++) {
    var step = deriveMessageKeysForKey(chainKey);
    var keys = step.keys;
    session.skippedKeys[skipKeyId(ratchetKeyB64, index)] = {
      cipherKey: bufToB64(keys.cipherKey),
      macKey: bufToB64(keys.macKey),
      iv: bufToB64(keys.iv)
    };
    chainKey = step.nextChainKey;
  }
  session.receiverChainKey = bufToB64(chainKey);
  session.receiverCounter = toCounter;
  var ids = Object.keys(session.skippedKeys);
  if (ids.length > 2000) {
    ids.slice(0, ids.length - 2000).forEach(function(id) {
      delete session.skippedKeys[id];
    });
  }
}

function sameBuffer(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
  return require("crypto").timingSafeEqual(a, b);
}

// Keeps the key used for the last few messages of a session, so a message
// that re-uses an envelope (a revoke re-sends the revoked message's envelope
// with a different plaintext) can still be decrypted. Same-counter messages
// with the same ciphertext are still treated as duplicates.
function rememberRecentMessageKey(session, counterKey, keys, body) {
  if (!session.recentMessageKeys) session.recentMessageKeys = {};
  if (!session.recentMessageKeyOrder) session.recentMessageKeyOrder = [];
  if (!session.recentMessageKeys[counterKey]) {
    session.recentMessageKeyOrder.push(counterKey);
  }
  session.recentMessageKeys[counterKey] = {
    cipherKey: bufToB64(keys.cipherKey),
    macKey: bufToB64(keys.macKey),
    iv: bufToB64(keys.iv),
    body: bufToB64(body || Buffer.alloc(0))
  };
  while (session.recentMessageKeyOrder.length > 50) {
    delete session.recentMessageKeys[session.recentMessageKeyOrder.shift()];
  }
}

function decryptWithSession(store, jid, session, message, isPreKeyMessage, skipSave) {
  if (!message.ratchetKey) throw new Error("Signal message has no ratchet key");
  var ratchetKeyB64 = bufToB64(message.ratchetKey);
  if (session.remoteRatchetKey !== ratchetKeyB64) {
    if (session.receiverChainKey) {
      var previous = message.previousCounter || 0;
      storeSkippedKeys(session, session.remoteRatchetKey, session.receiverCounter, previous);
    }
    var receive = createChain(
      b64ToBuf(session.rootKey),
      message.ratchetKey,
      b64ToBuf(session.senderRatchetPriv)
    );
    session.rootKey = bufToB64(receive.rootKey);
    session.receiverChainKey = bufToB64(receive.chainKey);
    session.receiverCounter = 0;
    session.remoteRatchetKey = ratchetKeyB64;

    var ratchet = cryptoUtils.generateKeyPair();
    var send = createChain(receive.rootKey, message.ratchetKey, ratchet.priv);
    session.rootKey = bufToB64(send.rootKey);
    session.senderRatchetPriv = bufToB64(ratchet.priv);
    session.senderRatchetPub = bufToB64(ratchet.pub);
    session.senderChainKey = bufToB64(send.chainKey);
    session.previousCounter = session.senderCounter;
    session.senderCounter = 0;
    if (isPreKeyMessage) delete session.pendingPreKey;
  }

  var messageKeys;
  var counterKey = skipKeyId(ratchetKeyB64, message.counter);
  if (message.counter < session.receiverCounter) {
    var skipped = session.skippedKeys && session.skippedKeys[counterKey];
    var recent = session.recentMessageKeys && session.recentMessageKeys[counterKey];
    if (recent && recent.body === bufToB64(message.body || Buffer.alloc(0))) {
      throw new Error("Duplicate or too old message (counter " + message.counter + ")");
    }
    if (recent) {
      messageKeys = {
        cipherKey: b64ToBuf(recent.cipherKey),
        macKey: b64ToBuf(recent.macKey),
        iv: b64ToBuf(recent.iv)
      };
    } else if (skipped) {
      messageKeys = {
        cipherKey: b64ToBuf(skipped.cipherKey),
        macKey: b64ToBuf(skipped.macKey),
        iv: b64ToBuf(skipped.iv)
      };
      delete session.skippedKeys[counterKey];
      rememberRecentMessageKey(session, counterKey, messageKeys, message.body);
    } else {
      throw new Error("Duplicate or too old message (counter " + message.counter + ")");
    }
  } else {
    storeSkippedKeys(session, ratchetKeyB64, session.receiverCounter, message.counter);
    var step = deriveMessageKeysForKey(b64ToBuf(session.receiverChainKey));
    messageKeys = step.keys;
    session.receiverChainKey = bufToB64(step.nextChainKey);
    session.receiverCounter = message.counter + 1;
    rememberRecentMessageKey(session, counterKey, messageKeys, message.body);
  }

  var senderIdentity = concatPublicKey(b64ToBuf(session.remoteIdentity));
  var receiverIdentity = concatPublicKey(store.identityKeyPair.pub);
  var expectedMac = computeMac(
    messageKeys.macKey,
    senderIdentity,
    receiverIdentity,
    Buffer.concat([Buffer.from([message.prefix]), message.body])
  );
  if (!sameBuffer(expectedMac, message.mac)) {
    throw new Error("Bad MAC on E2EE message from " + jid);
  }

  var plaintext = cryptoUtils.aesCbcDecrypt(messageKeys.cipherKey, messageKeys.iv, message.ciphertext);
  if (!skipSave) saveSession(store, jid, session);
  return plaintext;
}

function decryptPreKey(store, senderJid, ciphertext) {
  var preKeyMessage = decodePreKeySignalMessage(ciphertext);
  var existing = store.sessions[addressKey(senderJid)];
  if (existing && existing.processedPreKeyBaseKey === bufToB64(preKeyMessage.baseKey)) {
    return decryptMessageWithSession(store, senderJid, existing, decodeSignalMessage(preKeyMessage.message));
  }

  var signed = store.getSignedPreKeyById(preKeyMessage.signedPreKeyId);
  if (!signed) {
    throw new Error("No signed prekey " + preKeyMessage.signedPreKeyId + " for " + senderJid);
  }
  var oneTime = null;
  var replayedPreKey = false;
  if (preKeyMessage.preKeyId !== null) {
    oneTime = store.takePreKey(preKeyMessage.preKeyId);
    if (!oneTime) {
      // A revoke re-sends the revoked message's envelope, including its
      // one-time prekey; decrypt with it without replacing the live session.
      oneTime = store.getUsedPreKey(preKeyMessage.preKeyId);
      replayedPreKey = !!oneTime;
    }
    if (!oneTime) {
      throw new Error("No one-time prekey " + preKeyMessage.preKeyId + " for " + senderJid);
    }
  }

  var ourSignedPriv = b64ToBuf(signed.priv);
  var parts = [
    Buffer.alloc(32, 0xff),
    cryptoUtils.dh(ourSignedPriv, preKeyMessage.identityKey),
    cryptoUtils.dh(store.identityKeyPair.priv, preKeyMessage.baseKey),
    cryptoUtils.dh(ourSignedPriv, preKeyMessage.baseKey)
  ];
  if (oneTime) {
    parts.push(cryptoUtils.dh(b64ToBuf(oneTime.priv), preKeyMessage.baseKey));
  }
  var derived = cryptoUtils.hkdf(Buffer.concat(parts), ZERO32, Buffer.from("WhisperText"), 64);

  var session = {
    rootKey: bufToB64(derived.subarray(0, 32)),
    senderRatchetPriv: signed.priv,
    senderRatchetPub: signed.pub,
    senderChainKey: bufToB64(derived.subarray(32, 64)),
    senderCounter: 0,
    previousCounter: 0,
    remoteRatchetKey: null,
    receiverChainKey: null,
    receiverCounter: 0,
    remoteIdentity: bufToB64(preKeyMessage.identityKey),
    remoteRegistrationId: preKeyMessage.registrationId,
    skippedKeys: {},
    processedPreKeyBaseKey: bufToB64(preKeyMessage.baseKey)
  };
  if (replayedPreKey) {
    return decryptWithSession(store, senderJid, session, decodeSignalMessage(preKeyMessage.message), true, true);
  }
  store.sessions[addressKey(senderJid)] = session;
  store.identities[preKeyMessage.identityKey.toString("base64")] = 1;
  if (store.save) store.save();

  return decryptWithSession(store, senderJid, session, decodeSignalMessage(preKeyMessage.message), true);
}

function decryptMessageWithSession(store, senderJid, session, message) {
  return decryptWithSession(store, senderJid, session, message, false);
}

function decryptMessage(store, senderJid, ciphertext) {
  var session = store.sessions[addressKey(senderJid)];
  if (!session) throw new Error("No session for " + senderJid);
  return decryptMessageWithSession(store, senderJid, session, decodeSignalMessage(ciphertext));
}

function encodePreKeySignalMessage(session, signalMessage) {
  var pending = session.pendingPreKey;
  var writer = new proto.ProtoWriter();
  if (pending.preKeyId !== undefined && pending.preKeyId !== null) {
    writer.varint(1, pending.preKeyId);
  }
  writer
    .bytes(2, pending.baseKey)
    .bytes(3, pending.identityKey)
    .bytes(4, signalMessage)
    .varint(5, pending.registrationId)
    .varint(6, pending.signedPreKeyId);
  return Buffer.concat([Buffer.from([SERIALIZED_PREFIX]), writer.build()]);
}

function hasSession(store, jid) {
  return !!store.sessions[addressKey(jid)];
}

function saveSession(store, jid, session) {
  store.sessions[addressKey(jid)] = session;
  if (store.save) store.save();
}

function verifyBundleSignature(bundle) {
  if (!bundle.signedPreKey.signature) return true;
  return cryptoUtils.xeddsaVerify(
    bundle.identityKey,
    bundle.signedPreKey.publicKey,
    bundle.signedPreKey.signature
  );
}

function establishSession(store, jid, bundle) {
  if (!verifyBundleSignature(bundle)) {
    throw new Error("Invalid signed prekey signature for " + jid);
  }
  var identity = store.identityKeyPair;
  var base = cryptoUtils.generateKeyPair();
  var ratchet = cryptoUtils.generateKeyPair();
  var master = deriveMasterSecret(identity.priv, base.priv, bundle);
  var derived = cryptoUtils.hkdf(master, ZERO32, Buffer.from("WhisperText"), 64);
  var chain = createChain(derived.subarray(0, 32), bundle.signedPreKey.publicKey.subarray(1), ratchet.priv);
  var session = {
    rootKey: bufToB64(chain.rootKey),
    senderRatchetPriv: bufToB64(ratchet.priv),
    senderRatchetPub: bufToB64(ratchet.pub),
    senderChainKey: bufToB64(chain.chainKey),
    senderCounter: 0,
    previousCounter: 0,
    remoteRatchetKey: bufToB64(bundle.signedPreKey.publicKey.subarray(1)),
    remoteIdentity: bufToB64(bundle.identityKey),
    remoteRegistrationId: bundle.registrationId,
    pendingPreKey: {
      preKeyId: bundle.preKey ? bundle.preKey.keyId : null,
      signedPreKeyId: bundle.signedPreKey.keyId,
      baseKey: concatPublicKey(base.pub),
      identityKey: concatPublicKey(identity.pub),
      registrationId: store.registrationId
    }
  };
  if (store.identities[bundle.identityKey.toString("base64")] === undefined) {
    store.identities[bundle.identityKey.toString("base64")] = 1;
  }
  saveSession(store, jid, session);
  return session;
}

function encrypt(store, jid, plaintext) {
  var session = store.sessions[addressKey(jid)];
  if (!session) throw new Error("No session with " + jid);
  var chain = advanceChainKey(b64ToBuf(session.senderChainKey));
  var keys = deriveMessageKeys(chain.messageKey);
  var ciphertext = cryptoUtils.aesCbcEncrypt(keys.cipherKey, keys.iv, plaintext);
  var ratchetPub = b64ToBuf(session.senderRatchetPub);
  var body = new proto.ProtoWriter()
    .bytes(1, concatPublicKey(ratchetPub))
    .varint(2, session.senderCounter)
    .varint(3, session.previousCounter)
    .bytes(4, ciphertext)
    .build();
  var identity = store.identityKeyPair;
  var remoteIdentity = b64ToBuf(session.remoteIdentity);
  var mac = computeMac(
    keys.macKey,
    concatPublicKey(identity.pub),
    concatPublicKey(remoteIdentity),
    Buffer.concat([Buffer.from([SERIALIZED_PREFIX]), body])
  );
  var signalMessage = Buffer.concat([Buffer.from([SERIALIZED_PREFIX]), body, mac]);

  session.senderChainKey = bufToB64(chain.nextChainKey);
  session.senderCounter += 1;

  var result;
  if (session.pendingPreKey) {
    result = { type: "pkmsg", ciphertext: encodePreKeySignalMessage(session, signalMessage) };
    delete session.pendingPreKey;
  } else {
    result = { type: "msg", ciphertext: signalMessage };
  }
  saveSession(store, jid, session);
  return result;
}

module.exports = {
  parseJid: parseJid,
  addressKey: addressKey,
  hasSession: hasSession,
  establishSession: establishSession,
  encrypt: encrypt,
  decryptMessage: decryptMessage,
  decryptPreKey: decryptPreKey,
  decodePreKeySignalMessage: decodePreKeySignalMessage,
  MESSAGE_VERSION: MESSAGE_VERSION
};
