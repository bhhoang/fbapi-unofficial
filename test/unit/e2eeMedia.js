"use strict";

// Offline tests for the E2EE media helpers (src/e2ee/media.js). Run with
// `npm run test:unit`.

var assert = require("assert");
var crypto = require("crypto");
var media = require("../../src/e2ee/media");
var proto = require("../../src/e2ee/proto");
var e2eeClient = require("../../src/e2ee/client");

function mediaEntry(overrides) {
  var entry = {
    fileSha256: crypto.randomBytes(32),
    mediaKey: crypto.randomBytes(32),
    fileEncSha256: crypto.randomBytes(32),
    directPath: "/v/t62/example/direct",
    mediaKeyTimestamp: 1700000000,
    objectId: "1234567890",
    serverMediaType: "image",
    size: 4
  };
  Object.keys(overrides || {}).forEach(function(key) {
    entry[key] = overrides[key];
  });
  return entry;
}

describe("src/e2ee/media", function() {
  describe("encryptMedia / decryptMedia", function() {
    ["image", "video", "document", "ptt"].forEach(function(serverMediaType) {
      it("round-trips " + serverMediaType, function() {
        var plaintext = crypto.randomBytes(1024);
        var result = media.encryptMedia(plaintext, serverMediaType);
        assert.strictEqual(result.mediaKey.length, 32);
        assert.strictEqual(
          Buffer.compare(result.fileSha256, crypto.createHash("sha256").update(plaintext).digest()),
          0
        );
        assert.strictEqual(
          Buffer.compare(result.fileEncSha256, crypto.createHash("sha256").update(result.ciphertext).digest()),
          0
        );
        var decrypted = media.decryptMedia(result.ciphertext, result.mediaKey, serverMediaType);
        assert.strictEqual(Buffer.compare(decrypted, plaintext), 0);
      });
    });

    it("rejects a tampered ciphertext", function() {
      var result = media.encryptMedia(Buffer.from("hello e2ee media"), "image");
      var tampered = Buffer.from(result.ciphertext);
      tampered[0] ^= 0xff;
      assert.throws(function() {
        media.decryptMedia(tampered, result.mediaKey, "image");
      }, /HMAC mismatch/);
    });

    it("rejects the wrong server media type", function() {
      var result = media.encryptMedia(Buffer.from("hello e2ee media"), "image");
      assert.throws(function() {
        media.decryptMedia(result.ciphertext, result.mediaKey, "video");
      }, /HMAC mismatch/);
    });
  });

  describe("transport encoding", function() {
    function roundTrip(kind, opts) {
      var entry = mediaEntry({ serverMediaType: kind === "ptt" ? "ptt" : kind });
      var transport = media.encodeTransport(kind, entry, opts || {});
      return { entry: entry, parsed: media.parseMediaTransport(kind, transport) };
    }

    it("round-trips an image transport", function() {
      var result = roundTrip("image", { width: 4032, height: 3024, jpegThumbnail: Buffer.from([1, 2, 3]) });
      assert.strictEqual(Buffer.compare(result.parsed.fileSha256, result.entry.fileSha256), 0);
      assert.strictEqual(Buffer.compare(result.parsed.mediaKey, result.entry.mediaKey), 0);
      assert.strictEqual(Buffer.compare(result.parsed.fileEncSha256, result.entry.fileEncSha256), 0);
      assert.strictEqual(result.parsed.directPath, result.entry.directPath);
      assert.strictEqual(result.parsed.mediaKeyTimestamp, result.entry.mediaKeyTimestamp);
      assert.strictEqual(result.parsed.objectId, result.entry.objectId);
      assert.strictEqual(result.parsed.width, 4032);
      assert.strictEqual(result.parsed.height, 3024);
      assert.strictEqual(Buffer.compare(result.parsed.jpegThumbnail, Buffer.from([1, 2, 3])), 0);
    });

    it("round-trips a video transport", function() {
      var result = roundTrip("video", { width: 1920, height: 1080, duration: 12 });
      assert.strictEqual(result.parsed.width, 1920);
      assert.strictEqual(result.parsed.height, 1080);
      assert.strictEqual(result.parsed.duration, 12);
    });

    it("round-trips an audio transport", function() {
      var result = roundTrip("ptt", { duration: 7 });
      assert.strictEqual(result.parsed.duration, 7);
      assert.strictEqual(result.parsed.serverMediaType, "ptt");
    });

    it("carries the file length and mimetype", function() {
      var result = roundTrip("document", {});
      assert.strictEqual(result.parsed.fileLength, 4);
      assert.strictEqual(result.parsed.mimetype, "application/octet-stream");
    });
  });

  describe("consumer message encoding", function() {
    it("wraps an image in a decodable consumer application", function() {
      var entry = mediaEntry({});
      var consumerApp = media.encodeConsumerMediaApp("image", entry, {
        caption: "look at this",
        width: 100,
        height: 50
      });
      var parsed = media.parseConsumerMedia(proto.decodeFields(consumerApp));
      assert.strictEqual(parsed.kind, "image");
      assert.strictEqual(parsed.caption, "look at this");
      assert.strictEqual(parsed.media.width, 100);
      assert.strictEqual(parsed.media.height, 50);
      assert.strictEqual(Buffer.compare(parsed.media.fileEncSha256, entry.fileEncSha256), 0);
    });

    it("wraps a document with its filename", function() {
      var entry = mediaEntry({ serverMediaType: "document" });
      var consumerApp = media.encodeConsumerMediaApp("document", entry, {
        filename: "report.pdf"
      });
      var parsed = media.parseConsumerMedia(proto.decodeFields(consumerApp));
      assert.strictEqual(parsed.kind, "document");
      assert.strictEqual(parsed.filename, "report.pdf");
    });

    it("survives the full MessageApplication/transport decoding path", function() {
      var entry = mediaEntry({});
      var consumerApp = media.encodeConsumerMediaApp("image", entry, { caption: "hi" });
      var application = e2eeClient.encodeMessageApplication(consumerApp);
      var transport = e2eeClient.encodeMessageTransport({ messageApp: application.messageApp });
      var decoded = e2eeClient.decodeConsumerText(transport);
      assert.strictEqual(decoded.kind, "media");
      assert.strictEqual(decoded.media.kind, "image");
      assert.strictEqual(decoded.media.caption, "hi");
      assert.strictEqual(decoded.media.media.directPath, entry.directPath);
      assert.strictEqual(
        Buffer.compare(decoded.media.media.fileEncSha256, entry.fileEncSha256),
        0
      );
    });
  });

  describe("classification", function() {
    it("maps common mime types", function() {
      assert.strictEqual(media.classifyMedia("image/png").kind, "image");
      assert.strictEqual(media.classifyMedia("video/mp4").serverMediaType, "video");
      assert.strictEqual(media.classifyMedia("audio/ogg").kind, "ptt");
      assert.strictEqual(media.classifyMedia("application/pdf").kind, "document");
      assert.strictEqual(media.classifyMedia("image/webp").kind, "image");
      assert.strictEqual(media.classifyMedia("image/gif").mimetype, "image/gif");
    });

    it("sniffs common file signatures", function() {
      var png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
      assert.strictEqual(media.sniffMimeType(png), "image/png");
      var jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12)]);
      assert.strictEqual(media.sniffMimeType(jpeg), "image/jpeg");
      var mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom"), Buffer.alloc(8)]);
      assert.strictEqual(media.sniffMimeType(mp4), "video/mp4");
      assert.strictEqual(media.sniffMimeType(Buffer.from("not a media file at all")), null);
    });
  });
});
