"use strict";

// Offline tests for NOTIFY handling in the call client. Messenger web answers
// every state-sync NOTIFY; unanswered, the server keeps re-sending it.

var assert = require("assert");
var CallClient = require("../../src/rtc/client").CallClient;
var proto = require("../../src/rtc/proto");

function notifyMessage(stateStore) {
  return {
    messageHeader: {
      type: proto.MessageType.NOTIFY,
      conferenceName: "ROOM:1",
      serverInfoData: "server-info",
      transactionId: "777"
    },
    messageBody: {
      notifyRequest: {
        topic: "batched_notify",
        version: 0,
        data: Buffer.alloc(0),
        syncPayload: { stateStore: stateStore, stateStoreV2: {} }
      }
    }
  };
}

function setup() {
  var client = new CallClient({ userID: "2", globalOptions: {} }, {});
  var processed = [];
  var call = {
    conferenceName: "ROOM:1",
    mediaSession: { e2eeMedia: { processServerState: function(data) { processed.push(data); } } }
  };
  var sent = [];
  client.findCallForMessage = function() { return call; };
  client.send = function(header, body) { sent.push({ header: header, body: body }); };
  return { client: client, sent: sent, processed: processed };
}

describe("src/rtc/client NOTIFY", function() {
  it("acknowledges a state-sync notification with its topic and version", function() {
    var s = setup();
    s.client.handleMessage(proto.serializeMessage(notifyMessage({
      config_engine: { version: 2, data: Buffer.from("cfg") }
    })));
    assert.strictEqual(s.sent.length, 1);
    assert.strictEqual(s.sent[0].header.type, proto.MessageType.NOTIFY);
    assert.strictEqual(String(s.sent[0].header.transactionId), "777");
    assert.strictEqual(s.sent[0].header.responseStatusCode, proto.RtcResponseStatusCode.OK);
    assert.deepStrictEqual(s.sent[0].body, { notifyResponse: { topic: "config_engine", version: 2 } });
  });

  it("hands an E2eeState in a notification to the E2EE stack", function() {
    var s = setup();
    s.client.handleMessage(proto.serializeMessage(notifyMessage({
      E2eeState: { version: 4, data: Buffer.from("e2ee-state") }
    })));
    assert.strictEqual(s.processed.length, 1);
    assert.strictEqual(Buffer.from(s.processed[0]).toString(), "e2ee-state");
    assert.deepStrictEqual(s.sent[0].body, { notifyResponse: { topic: "E2eeState", version: 4 } });
  });
});
