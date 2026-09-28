"use strict";

var crypto = require("crypto");
var proto = require("./proto");
var cryptoUtils = require("./crypto");

var MEDIA_KEY_LENGTH = 32;
var HMAC_LENGTH = 10;
var HKDF_LENGTH = 112;
var ZERO_SALT = Buffer.alloc(32);

var HKDF_INFO = {
  document: "WhatsApp Document Keys",
  image: "WhatsApp Image Keys",
  sticker: "WhatsApp Image Keys",
  "xma-image": "WhatsApp Image Keys",
  video: "WhatsApp Video Keys",
  gif: "WhatsApp Video Keys",
  audio: "WhatsApp Audio Keys",
  ptt: "WhatsApp Audio Keys",
  preview: "Messenger Preview Keys"
};

var IMAGE_MIME_TYPE = "image/jpeg";
var STICKER_MIME_TYPE = "image/webp";
var VIDEO_MIME_TYPE = "video/mp4";
var AUDIO_MIME_TYPE = "audio/ogg";
var GIF_MIME_TYPE = "image/gif";
var FILE_MIME_TYPE = "application/octet-stream";

var CONTENT_IMAGE = 2;
var CONTENT_DOCUMENT = 7;
var CONTENT_AUDIO = 8;
var CONTENT_VIDEO = 9;
var CONTENT_STICKER = 12;

function getHkdfInfo(serverMediaType) {
  var info = HKDF_INFO[serverMediaType];
  if (!info) throw new Error("Unsupported E2EE media type: " + serverMediaType);
  return info;
}

function computeMediaKeys(mediaKey, serverMediaType) {
  var key = Buffer.isBuffer(mediaKey) ? mediaKey : Buffer.from(mediaKey);
  if (key.length !== MEDIA_KEY_LENGTH) {
    throw new Error("E2EE media key must be " + MEDIA_KEY_LENGTH + " bytes, got " + key.length);
  }
  var expanded = cryptoUtils.hkdf(key, ZERO_SALT, Buffer.from(getHkdfInfo(serverMediaType), "utf8"), HKDF_LENGTH);
  return {
    iv: expanded.subarray(0, 16),
    cipherKey: expanded.subarray(16, 48),
    hmacKey: expanded.subarray(48, 80),
    refKey: expanded.subarray(80, 112)
  };
}

function computeHmac(hmacKey, iv, ciphertext) {
  return cryptoUtils
    .hmacSha256(hmacKey, Buffer.concat([iv, ciphertext]))
    .subarray(0, HMAC_LENGTH);
}

function encryptMedia(plaintext, serverMediaType, mediaKey) {
  var key = mediaKey ? Buffer.from(mediaKey) : crypto.randomBytes(MEDIA_KEY_LENGTH);
  var keys = computeMediaKeys(key, serverMediaType);
  var ciphertext = cryptoUtils.aesCbcEncrypt(keys.cipherKey, keys.iv, plaintext);
  var hmac = computeHmac(keys.hmacKey, keys.iv, ciphertext);
  var ciphertextHmac = Buffer.concat([ciphertext, hmac]);
  return {
    mediaKey: key,
    ciphertext: ciphertextHmac,
    fileSha256: cryptoUtils.sha256(plaintext),
    fileEncSha256: cryptoUtils.sha256(ciphertextHmac),
    iv: keys.iv,
    cipherKey: keys.cipherKey,
    hmacKey: keys.hmacKey
  };
}

function decryptMedia(ciphertextHmac, mediaKey, serverMediaType) {
  var data = Buffer.isBuffer(ciphertextHmac) ? ciphertextHmac : Buffer.from(ciphertextHmac);
  if (data.length <= HMAC_LENGTH) throw new Error("E2EE media ciphertext is too short");
  var ciphertext = data.subarray(0, data.length - HMAC_LENGTH);
  var hmac = data.subarray(data.length - HMAC_LENGTH);
  var keys = computeMediaKeys(mediaKey, serverMediaType);
  var expected = computeHmac(keys.hmacKey, keys.iv, ciphertext);
  if (!crypto.timingSafeEqual(hmac, expected)) {
    throw new Error("E2EE media HMAC mismatch");
  }
  return cryptoUtils.aesCbcDecrypt(keys.cipherKey, keys.iv, ciphertext);
}

function defaultMimeType(serverMediaType) {
  switch (serverMediaType) {
    case "image":
      return IMAGE_MIME_TYPE;
    case "sticker":
    case "sticker-pack":
      return STICKER_MIME_TYPE;
    case "video":
    case "gif":
      return VIDEO_MIME_TYPE;
    case "audio":
    case "ptt":
      return AUDIO_MIME_TYPE;
    default:
      return FILE_MIME_TYPE;
  }
}

function encodeWAMediaTransport(entry, opts) {
  var fileLength = entry.size != null ? entry.size : opts.fileLength || 0;
  var mimetype = entry.mimetype || opts.mimetype || defaultMimeType(entry.serverMediaType);
  var integral = new proto.ProtoWriter()
    .bytes(1, entry.fileSha256)
    .bytes(2, entry.mediaKey)
    .bytes(3, entry.fileEncSha256)
    .string(4, entry.directPath)
    .uint64(5, BigInt(entry.mediaKeyTimestamp));
  var thumbnail = new proto.ProtoWriter();
  if (opts.jpegThumbnail && opts.jpegThumbnail.length) thumbnail.bytes(1, opts.jpegThumbnail);
  if (opts.thumbnailWidth) thumbnail.varint(3, opts.thumbnailWidth);
  if (opts.thumbnailHeight) thumbnail.varint(4, opts.thumbnailHeight);
  var ancillary = new proto.ProtoWriter()
    .uint64(1, BigInt(fileLength))
    .string(2, mimetype)
    .bytes(3, thumbnail.build());
  if (entry.objectId) ancillary.string(4, entry.objectId);
  return new proto.ProtoWriter()
    .bytes(1, integral.build())
    .bytes(2, ancillary.build())
    .build();
}

function encodeImageTransport(entry, opts) {
  var inner = encodeWAMediaTransport(entry, opts);
  var integral = new proto.ProtoWriter().bytes(1, inner).build();
  var ancillary = new proto.ProtoWriter();
  if (opts.height) ancillary.varint(1, opts.height);
  if (opts.width) ancillary.varint(2, opts.width);
  if (opts.scansSidecar) ancillary.bytes(3, opts.scansSidecar);
  return new proto.ProtoWriter().bytes(1, integral).bytes(2, ancillary.build()).build();
}

function encodeVideoTransport(entry, opts) {
  var inner = encodeWAMediaTransport(entry, opts);
  var integral = new proto.ProtoWriter().bytes(1, inner).build();
  var ancillary = new proto.ProtoWriter();
  if (opts.duration) ancillary.varint(1, opts.duration);
  if (opts.gifPlayback) ancillary.bool(3, true);
  if (opts.height) ancillary.varint(4, opts.height);
  if (opts.width) ancillary.varint(5, opts.width);
  return new proto.ProtoWriter().bytes(1, integral).bytes(2, ancillary.build()).build();
}

function encodeAudioTransport(entry, opts) {
  var inner = encodeWAMediaTransport(entry, opts);
  var integral = new proto.ProtoWriter().bytes(1, inner).varint(2, 1).build();
  var ancillary = new proto.ProtoWriter();
  if (opts.duration) ancillary.varint(1, opts.duration);
  if (opts.waveform) ancillary.bytes(4, opts.waveform);
  return new proto.ProtoWriter().bytes(1, integral).bytes(2, ancillary.build()).build();
}

function encodeDocumentTransport(entry, opts) {
  var inner = encodeWAMediaTransport(entry, opts);
  var integral = new proto.ProtoWriter().bytes(1, inner).build();
  return new proto.ProtoWriter().bytes(1, integral).bytes(2, Buffer.alloc(0)).build();
}

function encodeStickerTransport(entry, opts) {
  var inner = encodeWAMediaTransport(entry, opts);
  var integral = new proto.ProtoWriter().bytes(1, inner);
  if (opts.animated) integral.bool(2, true);
  var ancillary = new proto.ProtoWriter();
  if (opts.height) ancillary.varint(2, opts.height);
  if (opts.width) ancillary.varint(3, opts.width);
  return new proto.ProtoWriter()
    .bytes(1, integral.build())
    .bytes(2, ancillary.build())
    .build();
}

function encodeTransport(kind, entry, opts) {
  switch (kind) {
    case "image":
      return encodeImageTransport(entry, opts);
    case "video":
    case "gif":
      return encodeVideoTransport(entry, opts);
    case "audio":
    case "ptt":
      return encodeAudioTransport(entry, opts);
    case "document":
      return encodeDocumentTransport(entry, opts);
    case "sticker":
      return encodeStickerTransport(entry, opts);
    default:
      throw new Error("Unsupported E2EE attachment kind: " + kind);
  }
}

function encodeSubProtocol(payload) {
  return new proto.ProtoWriter().bytes(1, payload).varint(2, 1).build();
}

function encodeCaption(text) {
  var caption = new proto.ProtoWriter();
  if (text) caption.string(1, text);
  return caption.build();
}

function encodeConsumerMediaApp(kind, entry, opts) {
  var transport = encodeTransport(kind, entry, opts);
  var subProtocol = encodeSubProtocol(transport);
  var contentBytes;
  if (kind === "image") {
    var imageMessage = new proto.ProtoWriter()
      .bytes(1, subProtocol)
      .bytes(2, encodeCaption(opts.caption));
    contentBytes = new proto.ProtoWriter().bytes(CONTENT_IMAGE, imageMessage.build());
  } else if (kind === "video" || kind === "gif") {
    var videoMessage = new proto.ProtoWriter()
      .bytes(1, subProtocol)
      .bytes(2, encodeCaption(opts.caption));
    contentBytes = new proto.ProtoWriter().bytes(CONTENT_VIDEO, videoMessage.build());
  } else if (kind === "document") {
    var documentMessage = new proto.ProtoWriter().bytes(1, subProtocol);
    if (opts.filename) documentMessage.string(2, opts.filename);
    contentBytes = new proto.ProtoWriter().bytes(CONTENT_DOCUMENT, documentMessage.build());
  } else if (kind === "audio" || kind === "ptt") {
    var audioMessage = new proto.ProtoWriter().bytes(1, subProtocol).bool(2, true);
    contentBytes = new proto.ProtoWriter().bytes(CONTENT_AUDIO, audioMessage.build());
  } else if (kind === "sticker") {
    var stickerMessage = new proto.ProtoWriter().bytes(1, subProtocol);
    contentBytes = new proto.ProtoWriter().bytes(CONTENT_STICKER, stickerMessage.build());
  } else {
    throw new Error("Unsupported E2EE attachment kind: " + kind);
  }
  var payload = new proto.ProtoWriter().bytes(1, contentBytes.build());
  return new proto.ProtoWriter().bytes(1, payload.build()).build();
}

function decodeFieldsSafe(bytes) {
  try {
    return proto.decodeFields(bytes);
  } catch (e) {
    return null;
  }
}

function readString(fields, key) {
  if (!fields || !fields[key]) return null;
  return Buffer.from(fields[key]).toString("utf8");
}

function readNumber(fields, key) {
  if (!fields || fields[key] === undefined || fields[key] === null) return null;
  return Number(fields[key]);
}

function readBytes(fields, key) {
  if (!fields || !fields[key]) return null;
  return Buffer.from(fields[key]);
}

function parseMediaTransport(kind, buffer) {
  var outer = decodeFieldsSafe(buffer);
  if (!outer) return null;
  var ancillaryFields = decodeFieldsSafe(outer[2]);
  var integralFields = decodeFieldsSafe(outer[1]);
  var transportFields = integralFields ? decodeFieldsSafe(integralFields[1]) : null;
  if (!transportFields) return null;
  var mediaIntegral = decodeFieldsSafe(transportFields[1]);
  var mediaAncillary = decodeFieldsSafe(transportFields[2]);
  if (!mediaIntegral) return null;
  var thumbnailFields = mediaAncillary ? decodeFieldsSafe(mediaAncillary[3]) : null;
  var result = {
    serverMediaType: kind,
    fileSha256: readBytes(mediaIntegral, 1),
    mediaKey: readBytes(mediaIntegral, 2),
    fileEncSha256: readBytes(mediaIntegral, 3),
    directPath: readString(mediaIntegral, 4),
    mediaKeyTimestamp: readNumber(mediaIntegral, 5),
    fileLength: readNumber(mediaAncillary, 1),
    mimetype: readString(mediaAncillary, 2),
    objectId: readString(mediaAncillary, 4),
    jpegThumbnail: thumbnailFields ? readBytes(thumbnailFields, 1) : null,
    thumbnailWidth: thumbnailFields ? readNumber(thumbnailFields, 3) : null,
    thumbnailHeight: thumbnailFields ? readNumber(thumbnailFields, 4) : null
  };
  if (kind === "image" || kind === "sticker") {
    result.width = readNumber(ancillaryFields, kind === "image" ? 2 : 3);
    result.height = readNumber(ancillaryFields, kind === "image" ? 1 : 2);
    if (kind === "sticker") result.animated = integralFields ? !!readNumber(integralFields, 2) : false;
  } else if (kind === "video" || kind === "gif") {
    result.duration = readNumber(ancillaryFields, 1);
    result.gifPlayback = ancillaryFields ? readNumber(ancillaryFields, 3) === 1 : false;
    result.height = readNumber(ancillaryFields, 4);
    result.width = readNumber(ancillaryFields, 5);
  } else if (kind === "audio" || kind === "ptt") {
    result.duration = ancillaryFields ? readNumber(ancillaryFields, 1) : null;
    result.waveform = ancillaryFields ? readBytes(ancillaryFields, 4) : null;
  }
  return result;
}

function parseConsumerMedia(consumerFields) {
  var payload = consumerFields && consumerFields[1] ? decodeFieldsSafe(consumerFields[1]) : null;
  var content = payload && payload[1] ? decodeFieldsSafe(payload[1]) : null;
  if (!content) return null;
  var kinds = [
    { field: CONTENT_IMAGE, kind: "image" },
    { field: CONTENT_VIDEO, kind: "video" },
    { field: CONTENT_DOCUMENT, kind: "document" },
    { field: CONTENT_AUDIO, kind: "ptt" },
    { field: CONTENT_STICKER, kind: "sticker" }
  ];
  for (var i = 0; i < kinds.length; i++) {
    var entry = kinds[i];
    if (!content[entry.field]) continue;
    var message = decodeFieldsSafe(content[entry.field]);
    var subProtocol = message && message[1] ? decodeFieldsSafe(message[1]) : null;
    var transport = subProtocol && subProtocol[1] ? Buffer.from(subProtocol[1]) : null;
    if (!transport) return null;
    var media = parseMediaTransport(entry.kind, transport);
    if (!media) return null;
    var caption = message && message[2] ? decodeFieldsSafe(message[2]) : null;
    return {
      kind: entry.kind,
      caption: caption ? readString(caption, 1) : null,
      filename: entry.kind === "document" ? readString(message, 2) : null,
      media: media
    };
  }
  return null;
}

function classifyMedia(mimeType, sniffed) {
  var mime = (mimeType || sniffed || "").toLowerCase();
  if (mime.indexOf("image/gif") === 0) return { kind: "image", serverMediaType: "image", mimetype: GIF_MIME_TYPE };
  if (mime.indexOf("image/") === 0) return { kind: "image", serverMediaType: "image", mimetype: mime || IMAGE_MIME_TYPE };
  if (mime.indexOf("video/") === 0) return { kind: "video", serverMediaType: "video", mimetype: mime || VIDEO_MIME_TYPE };
  if (mime.indexOf("audio/") === 0) return { kind: "ptt", serverMediaType: "ptt", mimetype: AUDIO_MIME_TYPE };
  return { kind: "document", serverMediaType: "document", mimetype: mime || FILE_MIME_TYPE };
}

function sniffMimeType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif";
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WAVE") {
    return "audio/wav";
  }
  if (buffer.subarray(0, 4).toString("ascii") === "OggS") return "audio/ogg";
  if (buffer.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return "video/webm";
  return null;
}

function mimeExtension(mimeType) {
  switch ((mimeType || "").toLowerCase()) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "video/mp4":
      return ".mp4";
    case "video/webm":
      return ".webm";
    case "audio/wav":
      return ".wav";
    case "audio/ogg":
      return ".ogg";
    default:
      return "";
  }
}

module.exports = {
  MEDIA_KEY_LENGTH: MEDIA_KEY_LENGTH,
  HMAC_LENGTH: HMAC_LENGTH,
  IMAGE_MIME_TYPE: IMAGE_MIME_TYPE,
  STICKER_MIME_TYPE: STICKER_MIME_TYPE,
  VIDEO_MIME_TYPE: VIDEO_MIME_TYPE,
  AUDIO_MIME_TYPE: AUDIO_MIME_TYPE,
  GIF_MIME_TYPE: GIF_MIME_TYPE,
  FILE_MIME_TYPE: FILE_MIME_TYPE,
  computeMediaKeys: computeMediaKeys,
  encryptMedia: encryptMedia,
  decryptMedia: decryptMedia,
  encodeTransport: encodeTransport,
  encodeConsumerMediaApp: encodeConsumerMediaApp,
  parseMediaTransport: parseMediaTransport,
  parseConsumerMedia: parseConsumerMedia,
  classifyMedia: classifyMedia,
  sniffMimeType: sniffMimeType,
  mimeExtension: mimeExtension
};
