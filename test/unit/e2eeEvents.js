"use strict";

// Offline tests for E2EE direct-message events (reactions, edits, revokes).
// The wire structures were captured from the real client; these tests build
// the same protobufs and check the decoded payloads and emitted events.

var assert = require("assert");
var proto = require("../../src/e2ee/proto");
var e2eeClient = require("../../src/e2ee/client");
var E2EEClient = e2eeClient.E2EEClient;

var BOT_JID = "61591112920161@msgr";
var TARGET_ID = "7510664055108826449";

function messageKey(id, fromMe) {
  return new proto.ProtoWriter()
    .string(1, BOT_JID)
    .varint(2, fromMe)
    .string(3, id)
    .build();
}

function consumerApp(content) {
  var consumerPayload = new proto.ProtoWriter().bytes(1, content).build();
  return new proto.ProtoWriter().bytes(1, consumerPayload).build();
}

function transportFor(app) {
  var application = e2eeClient.encodeMessageApplication(app);
  return e2eeClient.encodeMessageTransport({ messageApp: application.messageApp });
}

function decode(app) {
  return e2eeClient.decodeConsumerText(transportFor(app));
}

describe("src/e2ee/client events", function() {
  it("decodes a reaction message", function() {
    var reaction = new proto.ProtoWriter()
      .bytes(1, messageKey(TARGET_ID, 1))
      .string(2, "❤")
      .uint64(4, 1790681857572)
      .build();
    var content = new proto.ProtoWriter().bytes(16, reaction).build();
    var decoded = decode(consumerApp(content));
    assert.strictEqual(decoded.kind, "reaction");
    assert.strictEqual(decoded.reaction.targetMessageID, TARGET_ID);
    assert.strictEqual(decoded.reaction.text, "❤");
    assert.strictEqual(decoded.reaction.timestamp, 1790681857572);
  });

  it("decodes a removed reaction (no text)", function() {
    var reaction = new proto.ProtoWriter()
      .bytes(1, messageKey(TARGET_ID, 1))
      .uint64(4, 1790681859597)
      .build();
    var content = new proto.ProtoWriter().bytes(16, reaction).build();
    var decoded = decode(consumerApp(content));
    assert.strictEqual(decoded.kind, "reaction");
    assert.strictEqual(decoded.reaction.text, null);
    assert.strictEqual(decoded.reaction.targetMessageID, TARGET_ID);
  });

  it("decodes an edited message", function() {
    var newText = new proto.ProtoWriter().string(1, "edited text").build();
    var edit = new proto.ProtoWriter()
      .bytes(1, messageKey(TARGET_ID, 1))
      .bytes(2, newText)
      .uint64(3, 1790681866000)
      .build();
    var content = new proto.ProtoWriter().bytes(19, edit).build();
    var decoded = decode(consumerApp(content));
    assert.strictEqual(decoded.kind, "edit");
    assert.strictEqual(decoded.edit.targetMessageID, TARGET_ID);
    assert.strictEqual(decoded.edit.text, "edited text");
    assert.strictEqual(decoded.edit.timestamp, 1790681866000);
  });

  it("decodes a revoke (protocol message)", function() {
    var key = new proto.ProtoWriter().varint(2, 1).string(3, TARGET_ID).build();
    var x4 = new proto.ProtoWriter().bytes(1, key).build();
    var x3 = new proto.ProtoWriter().bytes(1, x4).build();
    var x2 = new proto.ProtoWriter().bytes(2, x3).build();
    var x1 = new proto.ProtoWriter().bytes(1, x2).build();
    var payloadSubProtocol = new proto.ProtoWriter().bytes(1, x1).build();
    var appPayload = new proto.ProtoWriter().bytes(4, payloadSubProtocol).build();
    var messageApp = new proto.ProtoWriter().bytes(1, appPayload).build();
    var decoded = e2eeClient.decodeConsumerText(e2eeClient.encodeMessageTransport({ messageApp: messageApp }));
    assert.strictEqual(decoded.kind, "revoke");
    assert.strictEqual(decoded.revoke.targetMessageID, TARGET_ID);
  });

  function eventClient(history) {
    var client = new E2EEClient({ userID: "200", globalOptions: { listenEvents: true } }, {});
    client.store = { history: history || {}, save: function() {} };
    return client;
  }

  it("maps a reaction to a message_reaction event", function() {
    var event = eventClient().buildE2EEEvent({
      kind: "reaction",
      reaction: { targetMessageID: TARGET_ID, text: "👍", timestamp: 1 }
    }, "100035400259877", "100035400259877");
    assert.strictEqual(event.type, "message_reaction");
    assert.strictEqual(event.threadID, "100035400259877");
    assert.strictEqual(event.messageID, TARGET_ID);
    assert.strictEqual(event.reaction, "👍");
    assert.strictEqual(event.senderID, "100035400259877");
    assert.strictEqual(event.userID, "100035400259877");
  });

  it("maps a removed reaction without a reaction field", function() {
    var event = eventClient().buildE2EEEvent({
      kind: "reaction",
      reaction: { targetMessageID: TARGET_ID, text: null, timestamp: 1 }
    }, "100", "100");
    assert.strictEqual(event.type, "message_reaction");
    assert.strictEqual("reaction" in event, false);
  });

  it("maps an edit to a message_edit event and updates the stored body", function() {
    var client = eventClient({
      "100": [{ messageID: TARGET_ID, threadID: "100", senderID: "100", timestamp: 123, body: "old body" }]
    });
    var event = client.buildE2EEEvent({
      kind: "edit",
      edit: { targetMessageID: TARGET_ID, text: "new body", timestamp: 999 }
    }, "100", "100");
    assert.strictEqual(event.type, "message_edit");
    assert.strictEqual(event.threadID, "100");
    assert.strictEqual(event.body, "new body");
    assert.strictEqual(event.previousBody, "old body");
    assert.strictEqual(event.timestamp, 123);
    assert.strictEqual(client.store.history["100"][0].body, "new body");
  });

  it("maps a revoke to a message_unsend event", function() {
    var client = eventClient({
      "100": [{ messageID: TARGET_ID, threadID: "100", senderID: "100", timestamp: 123, body: "bye" }]
    });
    var event = client.buildE2EEEvent({
      kind: "revoke",
      revoke: { targetMessageID: TARGET_ID }
    }, "100", "100");
    assert.strictEqual(event.type, "message_unsend");
    assert.strictEqual(event.messageID, TARGET_ID);
    assert.strictEqual(event.senderID, "100");
    assert.strictEqual(event.timestamp, 123);
    assert.strictEqual(typeof event.deletionTimestamp, "number");
  });
});
