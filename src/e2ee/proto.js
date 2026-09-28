"use strict";

/* global BigInt */

function ProtoWriter() {
  this.chunks = [];
}

ProtoWriter.prototype.varint = function(field, value) {
  this.chunks.push(encodeTag(field, 0));
  this.chunks.push(encodeVarint(BigInt(value)));
  return this;
};

ProtoWriter.prototype.bool = function(field, value) {
  return this.varint(field, value ? 1 : 0);
};

ProtoWriter.prototype.uint64 = function(field, value) {
  this.chunks.push(encodeTag(field, 0));
  this.chunks.push(encodeVarint(BigInt(value)));
  return this;
};

ProtoWriter.prototype.bytes = function(field, data) {
  var buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  this.chunks.push(encodeTag(field, 2));
  this.chunks.push(encodeVarint(BigInt(buf.length)));
  this.chunks.push(buf);
  return this;
};

ProtoWriter.prototype.string = function(field, value) {
  return this.bytes(field, Buffer.from(String(value), "utf8"));
};

ProtoWriter.prototype.build = function() {
  return Buffer.concat(this.chunks);
};

function concatLengthDelimited(parts) {
  var chunks = [];
  parts.forEach(function(part) {
    var buf = Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data || []);
    chunks.push(encodeTag(part.field, 2));
    chunks.push(encodeVarint(BigInt(buf.length)));
    chunks.push(buf);
  });
  return Buffer.concat(chunks);
}

function encodeTag(field, wire) {
  return encodeVarint(BigInt(field * 8 + wire));
}

function encodeVarint(value) {
  var out = [];
  var v = value;
  while (v > BigInt(127)) {
    out.push(Number(v & BigInt(127)) | 128);
    v >>= BigInt(7);
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function ProtoReader(data) {
  this.data = data;
  this.index = 0;
}

ProtoReader.prototype.eof = function() {
  return this.index >= this.data.length;
};

ProtoReader.prototype.readVarint = function() {
  var result = BigInt(0);
  var shift = BigInt(0);
  var b;
  do {
    if (this.index >= this.data.length) throw new Error("ProtoReader: EOF in varint");
    b = this.data[this.index++];
    result |= BigInt(b & 0x7f) << shift;
    shift += BigInt(7);
  } while (b & 0x80);
  return result;
};

ProtoReader.prototype.readBytes = function(len) {
  if (this.index + len > this.data.length) throw new Error("ProtoReader: EOF in bytes");
  var out = this.data.subarray(this.index, this.index + len);
  this.index += len;
  return Buffer.from(out);
};

ProtoReader.prototype.skip = function(wire) {
  if (wire === 0) this.readVarint();
  else if (wire === 1) this.index += 8;
  else if (wire === 2) this.readBytes(Number(this.readVarint()));
  else if (wire === 5) this.index += 4;
  else throw new Error("ProtoReader: unsupported wire type " + wire);
};

ProtoReader.prototype.readMessage = function() {
  return this.readBytes(Number(this.readVarint()));
};

function decodeFields(data) {
  var reader = new ProtoReader(data);
  var fields = {};
  while (!reader.eof()) {
    var tag = Number(reader.readVarint());
    var field = tag >> 3;
    var wire = tag & 7;
    var value;
    if (wire === 0) value = reader.readVarint();
    else if (wire === 2) value = reader.readMessage();
    else if (wire === 1) value = reader.readBytes(8);
    else if (wire === 5) value = reader.readBytes(4);
    else throw new Error("ProtoReader: unsupported wire type " + wire);
    if (fields[field] === undefined) fields[field] = value;
  }
  return fields;
}

module.exports = {
  ProtoWriter: ProtoWriter,
  ProtoReader: ProtoReader,
  encodeVarint: encodeVarint,
  encodeTag: encodeTag,
  concatLengthDelimited: concatLengthDelimited,
  decodeFields: decodeFields
};
