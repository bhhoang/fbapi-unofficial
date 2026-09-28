"use strict";
/* global BigInt */

// Thrift compact protocol reader/writer, wire-compatible with Meta's
// TCompactProtocol/TReadBuffer/TWriteBuffer used by the Messenger "Multiway"
// (Zenon) call signaling messages.
//
// Only the subset the signaling codec needs is implemented: structs, bools,
// bytes, i16/i32/i64, doubles, strings/binary, lists, sets and maps. Field ids
// use the compact delta encoding, integers are zigzag varints and i64 values
// are BigInt on write / decimal string on read (matching Meta's generated
// serializers).

var TType = {
  STOP: 0,
  BOOL: 2,
  BYTE: 3,
  DOUBLE: 4,
  I16: 6,
  I32: 8,
  I64: 10,
  STRING: 11,
  STRUCT: 12,
  MAP: 13,
  SET: 14,
  LIST: 15
};

// Compact protocol type codes.
var CT = {
  STOP: 0,
  TRUE: 1,
  FALSE: 2,
  BYTE: 3,
  I16: 4,
  I32: 5,
  I64: 6,
  DOUBLE: 7,
  BINARY: 8,
  LIST: 9,
  SET: 10,
  MAP: 11,
  STRUCT: 12
};

function compactType(type) {
  switch (type) {
    case TType.BOOL: return CT.TRUE;
    case TType.BYTE: return CT.BYTE;
    case TType.DOUBLE: return CT.DOUBLE;
    case TType.I16: return CT.I16;
    case TType.I32: return CT.I32;
    case TType.I64: return CT.I64;
    case TType.STRING: return CT.BINARY;
    case TType.STRUCT: return CT.STRUCT;
    case TType.MAP: return CT.MAP;
    case TType.SET: return CT.SET;
    case TType.LIST: return CT.LIST;
  }
  throw new Error("Unsupported thrift type " + type);
}

function typeFromCompact(ct) {
  switch (ct) {
    case CT.TRUE:
    case CT.FALSE: return TType.BOOL;
    case CT.BYTE: return TType.BYTE;
    case CT.DOUBLE: return TType.DOUBLE;
    case CT.I16: return TType.I16;
    case CT.I32: return TType.I32;
    case CT.I64: return TType.I64;
    case CT.BINARY: return TType.STRING;
    case CT.STRUCT: return TType.STRUCT;
    case CT.MAP: return TType.MAP;
    case CT.SET: return TType.SET;
    case CT.LIST: return TType.LIST;
  }
  throw new Error("Unsupported compact type " + ct);
}

function zigzag32(value) {
  value = value | 0;
  return ((value << 1) ^ (value >> 31)) >>> 0;
}

function unzigzag32(value) {
  return (value >>> 1) ^ -(value & 1);
}

function zigzag64(value) {
  var v = BigInt(value);
  return (v >> BigInt(63)) ^ (v << BigInt(1));
}

function unzigzag64(value) {
  var v = BigInt(value);
  return (v >> BigInt(1)) ^ -(v & BigInt(1));
}

// eslint-disable-next-line valid-typeof
var bigintType = typeof BigInt(0);

function toBigInt(value) {
  if (typeof value === bigintType) return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string") return BigInt(value);
  throw new Error("Cannot encode i64 from " + typeof value);
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new Error("Expected bytes, got " + typeof value);
}

function Writer() {
  this.buffer = Buffer.alloc(512);
  this.offset = 0;
  // Field id of the last written field per nesting level, used for the
  // compact field-header delta encoding.
  this.lastFieldId = [0];
  this.pendingBoolField = null;
}

Writer.prototype.grow = function(extra) {
  if (this.offset + extra <= this.buffer.length) return;
  var size = this.buffer.length;
  while (size < this.offset + extra) size *= 2;
  var next = Buffer.alloc(size);
  this.buffer.copy(next, 0, 0, this.offset);
  this.buffer = next;
};

Writer.prototype.writeByte = function(value) {
  this.grow(1);
  this.buffer[this.offset++] = value & 0xff;
};

Writer.prototype.writeVarint = function(value) {
  var remaining = BigInt(value);
  if (remaining < BigInt(0)) throw new Error("Varint cannot be negative");
  for (;;) {
    if (remaining <= BigInt(0x7f)) {
      this.writeByte(Number(remaining));
      return;
    }
    this.writeByte((Number(remaining & BigInt(0x7f)) | 0x80) & 0xff);
    remaining = remaining >> BigInt(7);
  }
};

Writer.prototype.writeI16 = function(value) {
  var zigzag = ((value << 1) ^ (value >> 15)) & 0xffff;
  this.writeVarint(zigzag);
};

Writer.prototype.writeI32 = function(value) {
  this.writeVarint(zigzag32(value));
};

Writer.prototype.writeI64 = function(value) {
  this.writeVarint(zigzag64(value));
};

Writer.prototype.writeDouble = function(value) {
  this.grow(8);
  this.buffer.writeDoubleBE(value, this.offset);
  this.offset += 8;
};

Writer.prototype.writeBinary = function(value) {
  var bytes = toBuffer(value);
  this.writeVarint(bytes.length);
  this.grow(bytes.length);
  bytes.copy(this.buffer, this.offset);
  this.offset += bytes.length;
};

Writer.prototype.writeString = function(value) {
  this.writeBinary(Buffer.from(String(value), "utf8"));
};

Writer.prototype.writeStructBegin = function() {
  this.lastFieldId.push(0);
  this.pendingBoolField = null;
};

Writer.prototype.writeStructEnd = function() {
  if (this.lastFieldId.length === 1) throw new Error("Unbalanced struct");
  this.lastFieldId.pop();
};

Writer.prototype.writeStructField = function(id, type, write) {
  this.writeFieldBegin(id, type);
  write();
};

Writer.prototype.writeFieldBegin = function(id, type) {
  if (type === TType.BOOL) {
    // Bools carry their value in the field header written by writeBool.
    this.pendingBoolField = id;
    return;
  }
  var compact = compactType(type);
  var last = this.lastFieldId[this.lastFieldId.length - 1];
  var delta = id - last;
  if (delta > 0 && delta <= 15) {
    this.writeByte((delta << 4) | compact);
  } else {
    this.writeByte(compact);
    this.writeI16(id);
  }
  this.lastFieldId[this.lastFieldId.length - 1] = id;
};

Writer.prototype.writeBool = function(value) {
  var id = this.pendingBoolField;
  this.pendingBoolField = null;
  var compact = value ? CT.TRUE : CT.FALSE;
  if (id == null) {
    this.writeByte(compact);
    return;
  }
  var last = this.lastFieldId[this.lastFieldId.length - 1];
  var delta = id - last;
  if (delta > 0 && delta <= 15) {
    this.writeByte((delta << 4) | compact);
  } else {
    this.writeByte(compact);
    this.writeI16(id);
  }
  this.lastFieldId[this.lastFieldId.length - 1] = id;
};

Writer.prototype.writeFieldStop = function() {
  this.writeByte(CT.STOP);
  this.lastFieldId[this.lastFieldId.length - 1] = 0;
};

Writer.prototype.writeCollectionBegin = function(compact, size) {
  if (size <= 14) {
    this.writeByte((size << 4) | compact);
  } else {
    this.writeByte(0xf0 | compact);
    this.writeVarint(size);
  }
};

Writer.prototype.writeListBegin = function(size, elementType) {
  this.writeCollectionBegin(compactType(elementType), size);
};

Writer.prototype.writeSetBegin = function(size, elementType) {
  this.writeCollectionBegin(compactType(elementType), size);
};

Writer.prototype.writeMapBegin = function(size, keyType, valueType) {
  if (size === 0) {
    this.writeByte(0);
    return;
  }
  this.writeVarint(size);
  this.writeByte((compactType(keyType) << 4) | compactType(valueType));
};

Writer.prototype.toBuffer = function() {
  return this.buffer.slice(0, this.offset);
};

function Reader(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = toBuffer(buffer);
  this.buffer = buffer;
  this.offset = 0;
  this.lastFieldId = [0];
}

Reader.prototype.readByte = function() {
  if (this.offset >= this.buffer.length) throw new Error("Unexpected end of thrift buffer");
  return this.buffer[this.offset++];
};

Reader.prototype.readVarint = function() {
  var value = BigInt(0);
  var shift = BigInt(0);
  for (;;) {
    var byte = this.readByte();
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += BigInt(7);
    if (shift > BigInt(63)) throw new Error("Thrift varint is too long");
  }
};

Reader.prototype.readI16 = function() {
  return unzigzag32(Number(this.readVarint()));
};

Reader.prototype.readI32 = function() {
  return unzigzag32(Number(this.readVarint()));
};

Reader.prototype.readI64 = function() {
  return unzigzag64(this.readVarint()).toString();
};

Reader.prototype.readDouble = function() {
  if (this.offset + 8 > this.buffer.length) throw new Error("Unexpected end of thrift buffer");
  var value = this.buffer.readDoubleBE(this.offset);
  this.offset += 8;
  return value;
};

Reader.prototype.readBinary = function() {
  var size = Number(this.readVarint());
  if (this.offset + size > this.buffer.length) throw new Error("Unexpected end of thrift buffer");
  var value = this.buffer.slice(this.offset, this.offset + size);
  this.offset += size;
  return value;
};

Reader.prototype.readString = function() {
  return this.readBinary().toString("utf8");
};

Reader.prototype.readStructBegin = function() {
  this.lastFieldId.push(0);
};

Reader.prototype.readStructEnd = function() {
  if (this.lastFieldId.length === 1) throw new Error("Unbalanced struct");
  this.lastFieldId.pop();
};

Reader.prototype.readFieldBegin = function() {
  var header = this.readByte();
  if (header === 0) return { type: TType.STOP, id: 0 };

  var compact = header & 0x0f;
  var modifier = (header & 0xf0) >> 4;
  var id;
  if (modifier === 0) {
    id = this.readI16();
  } else {
    id = this.lastFieldId[this.lastFieldId.length - 1] + modifier;
  }
  this.lastFieldId[this.lastFieldId.length - 1] = id;

  var type = typeFromCompact(compact);
  if (type === TType.BOOL) {
    return { type: type, id: id, value: compact === CT.TRUE };
  }
  return { type: type, id: id };
};

Reader.prototype.readCollectionBegin = function() {
  var header = this.readByte();
  var size = (header & 0xf0) >> 4;
  var compact = header & 0x0f;
  if (size === 15) size = Number(this.readVarint());
  return { size: size, type: typeFromCompact(compact) };
};

Reader.prototype.readListBegin = function() {
  return this.readCollectionBegin();
};

Reader.prototype.readSetBegin = function() {
  return this.readCollectionBegin();
};

Reader.prototype.readMapBegin = function() {
  var size = Number(this.readVarint());
  if (size === 0) return { size: 0, keyType: TType.STOP, valueType: TType.STOP };
  var header = this.readByte();
  return {
    size: size,
    keyType: typeFromCompact((header & 0xf0) >> 4),
    valueType: typeFromCompact(header & 0x0f)
  };
};

Reader.prototype.skip = function(type) {
  switch (type) {
    case TType.BOOL:
    case TType.BYTE:
      this.readByte();
      return;
    case TType.I16:
    case TType.I32:
    case TType.I64:
      this.readVarint();
      return;
    case TType.DOUBLE:
      this.offset += 8;
      return;
    case TType.STRING:
      this.readBinary();
      return;
    case TType.STRUCT:
      this.skipStruct();
      return;
    case TType.LIST:
    case TType.SET: {
      var collection = this.readCollectionBegin();
      for (var i = 0; i < collection.size; i++) this.skip(collection.type);
      return;
    }
    case TType.MAP: {
      var map = this.readMapBegin();
      for (var j = 0; j < map.size; j++) {
        this.skip(map.keyType);
        this.skip(map.valueType);
      }
      return;
    }
  }
  throw new Error("Cannot skip unknown thrift type " + type);
};

Reader.prototype.skipStruct = function() {
  this.readStructBegin();
  for (;;) {
    var field = this.readFieldBegin();
    if (field.type === TType.STOP) break;
    if (field.type === TType.BOOL) continue;
    this.skip(field.type);
  }
  this.readStructEnd();
};

module.exports = {
  TType: TType,
  Writer: Writer,
  Reader: Reader,
  toBigInt: toBigInt,
  toBuffer: toBuffer
};
