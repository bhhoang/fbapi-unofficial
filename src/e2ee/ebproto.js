"use strict";
/* global BigInt */

// Spec-driven protobuf codec for Meta's EBWasm ("Labyrinth") messages.
//
// Mirrors the wire semantics of Meta's encodeProtobuf/decodeProtobuf modules
// (WAProtoCompile + WABinary): varint fields, length-delimited fields and
// nested/repeated messages. Only the message types needed for the encrypted
// backup restore flow are declared here; unknown fields are skipped when
// decoding, so newer producers stay readable.

var TYPES = {
  UINT64: 1,
  BYTES: 2,
  BOOL: 3,
  MESSAGE: 4,
  STRING: 5,
  ENUM: 6
};

var WIRE_VARINT = 0;
var WIRE_BYTES = 2;

var SPECS = {
  AddDeviceSyncEpoch: {
    fields: {
      epochId: { tag: 1, type: TYPES.UINT64, required: true },
      encryptedEpochKey: { tag: 2, type: TYPES.BYTES },
      backupId: { tag: 3, type: TYPES.UINT64, required: true },
      epochAnonId: { tag: 4, type: TYPES.BYTES, required: true },
      epochAuthPublicKey: { tag: 5, type: TYPES.BYTES, required: true },
      isActiveEpoch: { tag: 6, type: TYPES.BOOL, required: true },
      nextEpochId: { tag: 7, type: TYPES.UINT64 },
      prevEpochId: { tag: 8, type: TYPES.UINT64 },
      backwardEdge: { tag: 9, type: TYPES.BYTES }
    }
  },
  AddDeviceEpochDerivationInput: {
    fields: {
      blobDecryptionKey: { tag: 1, type: TYPES.BYTES, required: true },
      encryptedEpochRootKey: { tag: 2, type: TYPES.BYTES, required: true },
      encryptedEpochAnonId: { tag: 3, type: TYPES.BYTES, required: true },
      encryptedEpochStoragePrivateKey: { tag: 4, type: TYPES.BYTES },
      baseEpochId: { tag: 5, type: TYPES.UINT64, required: true },
      lastEpochId: { tag: 6, type: TYPES.UINT64, required: true },
      epochStoragePublicKey: { tag: 7, type: TYPES.BYTES, required: true },
      syncEpochs: {
        tag: 8,
        type: TYPES.MESSAGE,
        message: "AddDeviceSyncEpoch",
        repeated: true
      }
    }
  },
  DerivedEpoch: {
    fields: {
      epochId: { tag: 1, type: TYPES.UINT64 },
      epochAnonId: { tag: 2, type: TYPES.BYTES },
      epochRootKey: { tag: 3, type: TYPES.BYTES },
      isOpen: { tag: 4, type: TYPES.BOOL },
      epochStoragePrivateKey: { tag: 5, type: TYPES.BYTES }
    }
  },
  AddDeviceEpochDerivationOutput: {
    fields: {
      epochs: { tag: 1, type: TYPES.MESSAGE, message: "DerivedEpoch", repeated: true },
      error: { tag: 2, type: TYPES.STRING },
      errorCode: { tag: 3, type: TYPES.ENUM }
    }
  },
  LabyrinthCommand: {
    fields: {
      addDeviceEpochDerivationInput: {
        tag: 2,
        type: TYPES.MESSAGE,
        message: "AddDeviceEpochDerivationInput"
      }
    }
  }
};

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error("Expected bytes, got " + typeof value);
}

function encodeVarint(value) {
  var remaining = BigInt(value);
  var bytes = [];
  while (remaining > BigInt(0x7f)) {
    bytes.push(Number(remaining & BigInt(0x7f)) | 0x80);
    remaining = remaining >> BigInt(7);
  }
  bytes.push(Number(remaining));
  return Buffer.from(bytes);
}

function readVarint(buffer, offset) {
  var value = BigInt(0);
  var shift = BigInt(0);
  while (offset < buffer.length) {
    var byte = buffer[offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value, offset: offset };
    shift += BigInt(7);
    if (shift > BigInt(63)) throw new Error("Varint is too long.");
  }
  throw new Error("Unexpected end of buffer while reading a varint.");
}

function bigIntToValue(value) {
  if (value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return value.toString();
}

function encodeField(def, value) {
  if (value == null) {
    if (def.required) throw new Error("Missing required field with tag " + def.tag + ".");
    return null;
  }
  if (def.type === TYPES.UINT64 || def.type === TYPES.ENUM) {
    return Buffer.concat([
      encodeVarint(BigInt(def.tag << 3) | BigInt(WIRE_VARINT)),
      encodeVarint(value)
    ]);
  }
  if (def.type === TYPES.BOOL) {
    return Buffer.concat([
      encodeVarint(BigInt(def.tag << 3) | BigInt(WIRE_VARINT)),
      encodeVarint(value ? 1 : 0)
    ]);
  }
  var payload;
  if (def.type === TYPES.BYTES) payload = toBuffer(value);
  else if (def.type === TYPES.STRING) payload = Buffer.from(String(value), "utf8");
  else if (def.type === TYPES.MESSAGE) payload = encode(def.message, value);
  else throw new Error("Unsupported field type " + def.type + ".");
  return Buffer.concat([
    encodeVarint(BigInt(def.tag << 3) | BigInt(WIRE_BYTES)),
    encodeVarint(payload.length),
    payload
  ]);
}

function encode(specName, value) {
  var spec = SPECS[specName];
  if (!spec) throw new Error("Unknown message spec: " + specName + ".");
  var valueObject = value || {};
  var parts = [];
  Object.keys(spec.fields).forEach(function(name) {
    var def = spec.fields[name];
    var fieldValue = valueObject[name];
    if (def.repeated) {
      if (fieldValue == null) {
        if (def.required) throw new Error("Missing required field: " + name + ".");
        return;
      }
      if (!Array.isArray(fieldValue)) throw new Error("Field " + name + " must be an array.");
      fieldValue.forEach(function(item) {
        parts.push(encodeField(def, item));
      });
      return;
    }
    var encoded = encodeField(def, fieldValue);
    if (encoded) parts.push(encoded);
  });
  return Buffer.concat(parts);
}

function findFieldByTag(spec, tag) {
  var names = Object.keys(spec.fields);
  for (var i = 0; i < names.length; i++) {
    var def = spec.fields[names[i]];
    if (def.tag === tag) return { name: names[i], def: def };
  }
  return null;
}

function skipField(buffer, offset, wireType) {
  if (wireType === WIRE_VARINT) return readVarint(buffer, offset).offset;
  if (wireType === WIRE_BYTES) {
    var length = Number(readVarint(buffer, offset).value);
    return offset + length;
  }
  if (wireType === 1) return offset + 8;
  if (wireType === 5) return offset + 4;
  throw new Error("Unsupported wire type " + wireType + ".");
}

function decode(specName, buffer) {
  var spec = SPECS[specName];
  if (!spec) throw new Error("Unknown message spec: " + specName + ".");
  var data = toBuffer(buffer);
  var result = {};
  var offset = 0;
  while (offset < data.length) {
    var key = readVarint(data, offset);
    offset = key.offset;
    var tag = Number(key.value >> BigInt(3));
    var wireType = Number(key.value & BigInt(7));
    var field = findFieldByTag(spec, tag);
    if (!field) {
      offset = skipField(data, offset, wireType);
      continue;
    }
    var value;
    if (field.def.type === TYPES.MESSAGE) {
      var nested = readVarint(data, offset);
      var messageLength = Number(nested.value);
      var messageOffset = nested.offset;
      value = decode(field.def.message, data.slice(messageOffset, messageOffset + messageLength));
      offset = messageOffset + messageLength;
    } else if (wireType === WIRE_VARINT) {
      var read = readVarint(data, offset);
      offset = read.offset;
      if (field.def.type === TYPES.BOOL) value = read.value !== BigInt(0);
      else if (field.def.type === TYPES.UINT64) value = bigIntToValue(read.value);
      else value = Number(read.value);
    } else {
      var sized = readVarint(data, offset);
      var size = Number(sized.value);
      var payloadOffset = sized.offset;
      var payload = data.slice(payloadOffset, payloadOffset + size);
      offset = payloadOffset + size;
      if (field.def.type === TYPES.STRING) value = payload.toString("utf8");
      else value = payload;
    }
    if (field.def.repeated) {
      if (!result[field.name]) result[field.name] = [];
      result[field.name].push(value);
    } else {
      result[field.name] = value;
    }
  }
  return result;
}

module.exports = {
  TYPES: TYPES,
  SPECS: SPECS,
  encode: encode,
  decode: decode
};
