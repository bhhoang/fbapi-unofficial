"use strict";

// Offline tests for end-to-end encrypted replies. The web client references
// the quoted message from field 10 of the E2EE message metadata:
//   {1: "<numeric offline-threading-style id>", 3: "<sender>@msgr"}
// (captured 2026-09-30 from a reply in an encrypted one-to-one chat; an extra
// field there breaks Meta's parsers, so the shape is asserted exactly).

var assert = require("assert");

var proto = require("../../src/e2ee/proto");
var clientModule = require("../../src/e2ee/client");

var QUOTED_ID = "7510968978232072491";
var QUOTED_SENDER = "61591112920161@msgr";

describe("src/e2ee/client replies", function() {
  it("adds the reply block to the message metadata", function() {
    var app = clientModule.encodeMessageApplication(Buffer.from([0x0a, 0x00]), {
      quotedId: QUOTED_ID,
      quotedSenderJid: QUOTED_SENDER
    });
    var messageApp = proto.decodeFields(app.messageApp);
    assert.ok(Buffer.isBuffer(messageApp[1]), "app payload present");
    var metadata = proto.decodeFields(messageApp[2]);
    assert.strictEqual(metadata[8].length, 32, "franking key present");
    var reply = proto.decodeFields(metadata[10]);
    assert.deepStrictEqual(Object.keys(reply), ["1", "3"], "exactly fields 1 and 3");
    assert.strictEqual(reply[1].toString(), QUOTED_ID);
    assert.strictEqual(reply[3].toString(), QUOTED_SENDER);
    assert.strictEqual(app.frankingTag.length, 32);
  });

  it("omits the reply block for plain messages", function() {
    var app = clientModule.encodeMessageApplication(Buffer.from([0x0a, 0x00]), null);
    var messageApp = proto.decodeFields(app.messageApp);
    var metadata = proto.decodeFields(messageApp[2]);
    assert.strictEqual(metadata[10], undefined);
  });

  it("resolves the quoted sender from the thread history", function() {
    var fake = Object.create(clientModule.E2EEClient.prototype);
    fake.store = {
      e2ee_history: {
        "100035400259877": [
          { messageID: "7510993260681105050", senderID: "61591112920161" }
        ]
      }
    };
    assert.strictEqual(
      fake.quotedSenderJid("100035400259877", "7510993260681105050"),
      "61591112920161@msgr"
    );
  });

  it("falls back to the peer for unknown quoted senders", function() {
    var fake = Object.create(clientModule.E2EEClient.prototype);
    fake.store = { e2ee_history: {} };
    assert.strictEqual(
      fake.quotedSenderJid("100035400259877", "999"),
      "100035400259877@msgr"
    );
  });

  it("normalizes reply descriptors", function() {
    var fake = Object.create(clientModule.E2EEClient.prototype);
    fake.store = {
      e2ee_history: {
        "100035400259877": [
          { messageID: "7510993260681105050", senderID: "61591112920161" }
        ]
      }
    };
    var resolved = fake.resolveReply("100035400259877", { quotedId: "7510993260681105050" });
    assert.deepStrictEqual(resolved, {
      quotedId: "7510993260681105050",
      quotedSenderJid: "61591112920161@msgr"
    });
    assert.strictEqual(fake.resolveReply("100035400259877", null), null);
  });
});
