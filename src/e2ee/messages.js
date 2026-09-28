"use strict";

// Labyrinth backup message decryption.
//
// Messages in the encrypted backup are stored as
//   { epoch_id, epoch_anon_id, encryption_version, encrypted_protobuf_stanza }
// and the stanza is decrypted with a message key derived from the epoch root
// key (see Meta's LSEncryptedBackupsDecryptProtobufStoredProcedure):
//
//   info = "message_key_in_epoch_<epochAnonId>_cipher_version_<version>[_thread_<threadId>]"
//   key  = HKDF-SHA256(ikm = epochRootKey, salt = 10 zero bytes, info)
//   data = EB-symmetric-decrypt(key, aad = "message_thread_<threadId>", stanza)
//
// The plaintext is the serialized message protobuf; the display text lives in
// the deepest length-delimited field that is valid UTF-8 (same shape the web
// client reads with MPS protobufs).

var cryptoUtils = require("./crypto");
var proto = require("./proto");

var ENCRYPTION_VERSION_KDF_WITH_VERSION = 2;
var ENCRYPTION_VERSION_KDF_WITH_NULL_SALT = 3;
var ENCRYPTION_VERSION_KDF_WITH_NULL_SALT_DF_CANARY = 4;

var ENCRYPTION_VERSION_NAMES = {
  ENCRYPTION_KDF_WITH_VERSION: ENCRYPTION_VERSION_KDF_WITH_VERSION,
  ENCRYPTION_KDF_WITH_NULL_SALT: ENCRYPTION_VERSION_KDF_WITH_NULL_SALT,
  ENCRYPTION_KDF_WITH_NULL_SALT_DF_CANARY: ENCRYPTION_VERSION_KDF_WITH_NULL_SALT_DF_CANARY
};

function encryptionVersionNumber(value) {
  if (typeof value === "number") return value;
  if (value == null) return ENCRYPTION_VERSION_KDF_WITH_NULL_SALT;
  if (ENCRYPTION_VERSION_NAMES[value] != null) return ENCRYPTION_VERSION_NAMES[value];
  var parsed = parseInt(value, 10);
  return isNaN(parsed) ? null : parsed;
}

function buildMessageKeyInfo(epochAnonId, version, threadId) {
  var anonId = epochAnonId == null ? "" : String(epochAnonId);
  if (version >= 3) {
    return [
      "message_key_in_epoch",
      anonId,
      "cipher_version",
      String(version),
      "thread",
      threadId == null ? "" : String(threadId)
    ].join("_");
  }
  if (version >= 2) {
    return ["message_key_in_epoch", anonId, "cipher_version", String(version)].join("_");
  }
  return "message_key_in_epoch_" + anonId;
}

function deriveMessageKey(epochRootKey, epochAnonId, version, threadId) {
  var info = buildMessageKeyInfo(epochAnonId, version, threadId);
  return cryptoUtils.hkdf(epochRootKey, Buffer.alloc(10), Buffer.from(info, "utf8"), 32);
}

// epochs: array of { epochId, epochAnonId, epochRootKey } (Buffers). The stanza
// carries its epoch_id; matching entries win, otherwise the first entry is
// used, mirroring Meta's stored procedure.
function findEpoch(epochs, epochId) {
  var list = epochs || [];
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].epochId) === String(epochId)) return list[i];
  }
  return list[0] || null;
}

function decryptBackupMessage(encryptedMessage, epochs, threadId) {
  var stanzas = encryptedMessage && encryptedMessage.protobuf_stanzas;
  var stanza = stanzas && stanzas.top_level_protobuf;
  if (!stanza) return null;
  // sk_ciphertext (when present) carries the session id of the client that
  // uploaded the message; Meta's own restore paths still decrypt the stanza
  // with the epoch-derived message key, so it does not affect decryption.
  //
  // Note on encryption_version "UNKNOWN": some stanzas (e.g. one-to-one call
  // event logs) were encrypted with a live session key that is never included
  // in the backup (no sk_ciphertext, empty minos keys). Those cannot be
  // decrypted from the backup by any client; callers should skip them.
  var epoch = findEpoch(epochs, stanza.epoch_id);
  if (!epoch || !epoch.epochRootKey) {
    throw new Error("No epoch key available for backup message epoch " + stanza.epoch_id + ".");
  }
  var version = encryptionVersionNumber(stanza.encryption_version);
  if (version == null) {
    throw new Error("Unsupported backup message encryption version: " + stanza.encryption_version);
  }
  var key = deriveMessageKey(epoch.epochRootKey, stanza.epoch_anon_id, version, threadId);
  return cryptoUtils.ebSymmetricDecrypt(key, "message_thread_" + String(threadId), stanza.encrypted_protobuf_stanza);
}

function isPrintableText(text) {
  if (text.length === 0) return false;
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 0xfffd) return false;
  }
  return true;
}

function decodeText(buffer) {
  var text = buffer.toString("utf8");
  if (Buffer.from(text, "utf8").compare(buffer) !== 0) return null;
  if (!isPrintableText(text)) return null;
  return text;
}

function findText(buffer, depth, best, excluded) {
  var fields;
  try {
    fields = proto.decodeFields(buffer);
  } catch (err) {
    return best;
  }
  Object.keys(fields).forEach(function(key) {
    var value = fields[key];
    if (!Buffer.isBuffer(value)) return;
    var text = decodeText(value);
    if (text != null && excluded.indexOf(text) === -1 && !/^\d+$/.test(text)) {
      if (!best || depth >= best.depth) best = { depth: depth, text: text };
    }
    best = findText(value, depth + 1, best, excluded);
  });
  return best;
}

// Best-effort extraction of the display text from a decrypted message
// protobuf. Returns null for messages without text content (reactions,
// receipts, media without captions, ...).
function extractMessageText(plaintext, threadId) {
  if (!plaintext || plaintext.length === 0) return null;
  var excluded = [];
  if (threadId != null) excluded.push(String(threadId));
  var best = findText(plaintext, 0, null, excluded);
  return best ? best.text : null;
}

var ADMIN_TEXT_IGNORED = ["enabled", "disabled", "true", "false", "admin"];

// Unencrypted backup messages carry a small admin/event protobuf: the actor
// and timestamp in the outer core and the event text somewhere in the nested
// payload. Field numbers differ between event types, so the text is picked by
// preferring candidates with letters/spaces over state words like "enabled".
function extractAdminMessage(raw) {
  var info = { actorId: null, timestamp: null, text: null };
  var outer = null;
  try {
    outer = proto.decodeFields(raw);
  } catch (outerError) {
    outer = null;
  }
  if (outer) {
    var core = outer[1];
    if (Buffer.isBuffer(core)) {
      try {
        var coreFields = proto.decodeFields(core);
        if (Buffer.isBuffer(coreFields[1])) info.actorId = decodeText(coreFields[1]);
        if (coreFields[3] != null) info.timestamp = Number(coreFields[3]);
      } catch (coreError) {
        /* not a recognizable core */
      }
    }
  }
  var candidates = [];
  var order = 0;
  (function collect(buffer, depth) {
    var reader;
    try {
      reader = new proto.ProtoReader(buffer);
    } catch (readerError) {
      return;
    }
    for (;;) {
      var value;
      try {
        if (reader.eof()) return;
        var tag = Number(reader.readVarint());
        var wire = tag & 7;
        if (wire === 0) value = reader.readVarint();
        else if (wire === 2) value = reader.readMessage();
        else if (wire === 1) value = reader.readBytes(8);
        else if (wire === 5) value = reader.readBytes(4);
        else return;
      } catch (readError) {
        return;
      }
      if (!Buffer.isBuffer(value)) continue;
      var text = decodeText(value);
      if (
        text != null &&
        text.length > 1 &&
        !/^\d+$/.test(text) &&
        ADMIN_TEXT_IGNORED.indexOf(text) === -1
      ) {
        candidates.push({ depth: depth, order: order++, text: text });
      }
      collect(value, depth + 1);
    }
  })(raw, 0);
  var best = null;
  candidates.forEach(function(candidate) {
    var hasNonAscii = false;
    for (var i = 0; i < candidate.text.length; i++) {
      if (candidate.text.charCodeAt(i) > 0x7f) {
        hasNonAscii = true;
        break;
      }
    }
    var score =
      (hasNonAscii ? 2 : 0) +
      (/\s/.test(candidate.text) ? 1 : 0) +
      (candidate.text.length > 8 ? 1 : 0);
    if (
      !best ||
      score > best.score ||
      (score === best.score && candidate.depth > best.depth)
    ) {
      best = { score: score, depth: candidate.depth, text: candidate.text };
    }
  });
  if (best) info.text = best.text;
  return info;
}

module.exports = {
  ENCRYPTION_VERSION_KDF_WITH_VERSION: ENCRYPTION_VERSION_KDF_WITH_VERSION,
  ENCRYPTION_VERSION_KDF_WITH_NULL_SALT: ENCRYPTION_VERSION_KDF_WITH_NULL_SALT,
  ENCRYPTION_VERSION_NAMES: ENCRYPTION_VERSION_NAMES,
  encryptionVersionNumber: encryptionVersionNumber,
  buildMessageKeyInfo: buildMessageKeyInfo,
  deriveMessageKey: deriveMessageKey,
  decryptBackupMessage: decryptBackupMessage,
  extractMessageText: extractMessageText,
  extractAdminMessage: extractAdminMessage
};
