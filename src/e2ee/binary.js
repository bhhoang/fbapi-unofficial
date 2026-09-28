"use strict";

var zlib = require("zlib");
var tokens = require("./tokens");

var LIST_EMPTY = 0;
var STREAM_END = 2;
var DICTIONARY_0 = 236;
var DICTIONARY_3 = 239;
var LIST_8 = 248;
var LIST_16 = 249;
var JID_PAIR = 250;
var HEX_8 = 251;
var BINARY_8 = 252;
var BINARY_20 = 253;
var BINARY_32 = 254;
var NIBBLE_8 = 255;
var FBJID = 246;
var ADJID = 247;

var jidAttributes = {
  to: true,
  from: true,
  jid: true,
  participant: true,
  recipient: true,
  target: true
};

function encodeVarint(value) {
  var out = [];
  var v = value >>> 0;
  while (v > 127) {
    out.push((v & 127) | 128);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

function encodeListStart(size) {
  if (size === 0) return Buffer.from([LIST_EMPTY]);
  if (size < 256) return Buffer.from([LIST_8, size]);
  if (size < 65536) {
    var out = Buffer.alloc(3);
    out[0] = LIST_16;
    out.writeUInt16BE(size, 1);
    return out;
  }
  throw new Error("List too large");
}

function encodeStringRaw(buf) {
  if (buf.length < 256) {
    return Buffer.concat([Buffer.from([BINARY_8, buf.length]), buf]);
  }
  if (buf.length < 1048576) {
    var header20 = Buffer.alloc(4);
    header20[0] = BINARY_20;
    header20[1] = (buf.length >> 16) & 255;
    header20[2] = (buf.length >> 8) & 255;
    header20[3] = buf.length & 255;
    return Buffer.concat([header20, buf]);
  }
  var header32 = Buffer.alloc(5);
  header32[0] = BINARY_32;
  header32.writeUInt32BE(buf.length, 1);
  return Buffer.concat([header32, buf]);
}

function encodeString(value) {
  var single = tokens.tokenToIndex[value];
  if (typeof single === "number") return Buffer.from([single]);
  var dbl = tokens.doubleTokenToIndex[value];
  if (dbl) return Buffer.from([DICTIONARY_0 + dbl.dict, dbl.index]);
  return encodeStringRaw(Buffer.from(String(value), "utf8"));
}

function encodeJID(jid) {
  var atIdx = jid.indexOf("@");
  if (atIdx === -1) return encodeString(jid);
  var userFull = jid.slice(0, atIdx);
  var server = jid.slice(atIdx + 1);
  if (server === "msgr") {
    var user = userFull;
    var device = 0;
    var splitIdx = userFull.indexOf(".");
    if (splitIdx === -1) splitIdx = userFull.indexOf(":");
    if (splitIdx !== -1) {
      user = userFull.slice(0, splitIdx);
      device = parseInt(userFull.slice(splitIdx + 1), 10) || 0;
    }
    var devBuf = Buffer.alloc(2);
    devBuf.writeUInt16BE(device);
    return Buffer.concat([
      Buffer.from([FBJID]),
      encodeString(user),
      devBuf,
      encodeString(server)
    ]);
  }
  if (server === "s.whatsapp.net" && (userFull.indexOf(".") !== -1 || userFull.indexOf(":") !== -1)) {
    var agent = 0;
    var dev = 0;
    var userOut = userFull;
    var dotIdx = userFull.indexOf(".");
    var colonIdx = userFull.indexOf(":");
    if (dotIdx !== -1 && colonIdx !== -1) {
      userOut = userFull.slice(0, dotIdx);
      agent = parseInt(userFull.slice(dotIdx + 1, colonIdx), 10) || 0;
      dev = parseInt(userFull.slice(colonIdx + 1), 10) || 0;
    } else if (dotIdx !== -1) {
      userOut = userFull.slice(0, dotIdx);
      dev = parseInt(userFull.slice(dotIdx + 1), 10) || 0;
    }
    return Buffer.concat([
      Buffer.from([ADJID, agent, dev]),
      encodeString(userOut)
    ]);
  }
  var parts = [Buffer.from([JID_PAIR])];
  parts.push(userFull ? encodeString(userFull) : Buffer.from([LIST_EMPTY]));
  parts.push(encodeString(server));
  return Buffer.concat(parts);
}

function encodeNode(tag, attrs, content) {
  var attrKeys = attrs ? Object.keys(attrs).filter(function(k) {
    return attrs[k] !== undefined && attrs[k] !== null;
  }) : [];
  var hasContent = content !== undefined && content !== null;
  var listSize = 1 + attrKeys.length * 2 + (hasContent ? 1 : 0);
  var chunks = [encodeListStart(listSize), encodeString(tag)];
  attrKeys.forEach(function(key) {
    var value = attrs[key];
    chunks.push(encodeString(key));
    if (typeof value === "string" && (value.indexOf("@") !== -1 || jidAttributes[key])) {
      chunks.push(encodeJID(value));
    } else {
      chunks.push(encodeString(String(value)));
    }
  });
  if (hasContent) {
    if (Array.isArray(content)) {
      chunks.push(
        encodeNodeList(
          content.map(function(child) {
            if (Buffer.isBuffer(child)) return child;
            return encodeNode(child.tag, child.attrs, child.content);
          })
        )
      );
    } else if (Buffer.isBuffer(content)) chunks.push(encodeStringRaw(content));
    else chunks.push(encodeString(String(content)));
  }
  return Buffer.concat(chunks);
}

function encodeNodeList(nodes) {
  var parts = [encodeListStart(nodes.length)];
  nodes.forEach(function(node) {
    parts.push(node);
  });
  return Buffer.concat(parts);
}

function marshal(node) {
  var body = Buffer.isBuffer(node) ? node : encodeNode(node.tag, node.attrs, node.content);
  return Buffer.concat([Buffer.from([0]), body]);
}

function BinaryDecoder(data) {
  this.data = data;
  this.index = 0;
}

BinaryDecoder.prototype.readByte = function() {
  if (this.index >= this.data.length) throw new Error("BinaryDecoder: EOF");
  return this.data[this.index++];
};

BinaryDecoder.prototype.readBytes = function(len) {
  if (this.index + len > this.data.length) throw new Error("BinaryDecoder: read out of bounds");
  var out = this.data.subarray(this.index, this.index + len);
  this.index += len;
  return out;
};

BinaryDecoder.prototype.readInt8 = function() {
  return this.readByte();
};

BinaryDecoder.prototype.readInt16 = function() {
  var b = this.readBytes(2);
  return b.readUInt16BE(0);
};

BinaryDecoder.prototype.readInt20 = function() {
  var b = this.readBytes(3);
  return (b[0] << 16) | (b[1] << 8) | b[2];
};

BinaryDecoder.prototype.readInt32 = function() {
  var b = this.readBytes(4);
  return b.readUInt32BE(0);
};

BinaryDecoder.prototype.readListSize = function(tag) {
  if (tag === LIST_EMPTY) return 0;
  if (tag === LIST_8) return this.readInt8();
  if (tag === LIST_16) return this.readInt16();
  throw new Error("Invalid list tag: " + tag);
};

BinaryDecoder.prototype.readPacked8 = function(tag) {
  var start = this.readByte();
  var len = start & 127;
  var out = "";
  for (var i = 0; i < len; i++) {
    var b = this.readByte();
    out += this.unpackByte(tag, (b & 240) >> 4);
    out += this.unpackByte(tag, b & 15);
  }
  if ((start >> 7) !== 0 && tag === HEX_8) out = out.slice(0, -1);
  return out;
};

BinaryDecoder.prototype.unpackByte = function(tag, val) {
  if (tag === NIBBLE_8) {
    if (val < 10) return String.fromCharCode(48 + val);
    if (val === 10) return "-";
    if (val === 11) return ".";
    if (val === 15) return "";
  } else if (tag === HEX_8) {
    if (val < 10) return String.fromCharCode(48 + val);
    if (val < 16) return String.fromCharCode(65 + val - 10);
  }
  return "";
};

BinaryDecoder.prototype.readString = function(tag) {
  if (tag >= 3 && tag < DICTIONARY_0) {
    return tokens.singleByteTokens[tag] || "";
  }
  if (tag >= DICTIONARY_0 && tag <= DICTIONARY_3) {
    var idx = this.readByte();
    var dict = tokens.doubleByteTokens[tag - DICTIONARY_0];
    if (!dict) throw new Error("Invalid dictionary index: " + (tag - DICTIONARY_0));
    return dict[idx] || "";
  }
  switch (tag) {
    case BINARY_8:
      return this.readBytes(this.readInt8()).toString();
    case BINARY_20:
      return this.readBytes(this.readInt20()).toString();
    case BINARY_32:
      return this.readBytes(this.readInt32()).toString();
    case NIBBLE_8:
    case HEX_8:
      return this.readPacked8(tag);
    default:
      throw new Error("Invalid string tag: " + tag);
  }
};

BinaryDecoder.prototype.read = function(asString) {
  var tag = this.readByte();
  if (tag === LIST_EMPTY) return null;
  if (tag === LIST_8 || tag === LIST_16) {
    var size = this.readListSize(tag);
    var list = [];
    for (var i = 0; i < size; i++) list.push(this.readNode());
    return list;
  }
  if (tag === BINARY_8) return this.readBytesOrString(this.readInt8(), asString);
  if (tag === BINARY_20) return this.readBytesOrString(this.readInt20(), asString);
  if (tag === BINARY_32) return this.readBytesOrString(this.readInt32(), asString);
  if (tag === JID_PAIR) {
    var user = this.read(true);
    var server = this.read(true);
    return (user ? user + "@" : "") + server;
  }
  if (tag === FBJID) {
    var fbUser = this.read(true);
    var device = this.readInt16();
    var fbServer = this.read(true);
    return fbUser + "." + device + "@" + fbServer;
  }
  if (tag === ADJID) {
    var agent = this.readByte();
    var adDevice = this.readByte();
    var adUser = this.read(true);
    return adUser + "." + agent + ":" + adDevice + "@s.whatsapp.net";
  }
  return this.readString(tag);
};

BinaryDecoder.prototype.readBytesOrString = function(len, asString) {
  var raw = this.readBytes(len);
  return asString ? raw.toString() : Buffer.from(raw);
};

BinaryDecoder.prototype.readNode = function() {
  var listSize = this.readListSize(this.readByte());
  var tag = this.readString(this.readByte());
  var attrs = {};
  var attrCount = (listSize - 1) >> 1;
  for (var i = 0; i < attrCount; i++) {
    var key = this.readString(this.readByte());
    attrs[key] = this.read(true);
  }
  var content;
  if (listSize % 2 === 0) content = this.read(false);
  return { tag: tag, attrs: attrs, content: content };
};

function unmarshal(data) {
  if (!data || data.length === 0) throw new Error("Empty data in unmarshal");
  var dataType = data[0];
  var body = data.subarray(1);
  if (dataType & 2) body = zlib.inflateSync(body);
  return new BinaryDecoder(body).readNode();
}

function findChild(node, tag) {
  if (!node || !Array.isArray(node.content)) return null;
  for (var i = 0; i < node.content.length; i++) {
    if (node.content[i] && node.content[i].tag === tag) return node.content[i];
  }
  return null;
}

function findDescendant(node, tag) {
  if (!node) return null;
  if (node.tag === tag) return node;
  if (!Array.isArray(node.content)) return null;
  for (var i = 0; i < node.content.length; i++) {
    var found = findDescendant(node.content[i], tag);
    if (found) return found;
  }
  return null;
}

module.exports = {
  encodeVarint: encodeVarint,
  encodeNode: encodeNode,
  encodeString: encodeString,
  encodeStringRaw: encodeStringRaw,
  encodeJID: encodeJID,
  marshal: marshal,
  unmarshal: unmarshal,
  BinaryDecoder: BinaryDecoder,
  findChild: findChild,
  findDescendant: findDescendant,
  tags: {
    LIST_EMPTY: LIST_EMPTY,
    STREAM_END: STREAM_END,
    LIST_8: LIST_8,
    LIST_16: LIST_16,
    BINARY_8: BINARY_8,
    BINARY_20: BINARY_20,
    BINARY_32: BINARY_32
  }
};
