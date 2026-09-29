"use strict";

// Outgoing E2EE message IDs must look like the ones Messenger's own clients
// send: (milliseconds since the epoch << 22) | 22 random bits. Recipients use
// them to order messages that share the server's one-second timestamp.

var assert = require("assert");
var E2EEClient = require("../../src/e2ee/client").E2EEClient;

describe("src/e2ee/client message IDs", function() {
  it("encode the send time in milliseconds", function() {
    var client = new E2EEClient({ userID: "1", globalOptions: {} }, {});
    var before = Date.now();
    var id = client.nextMessageId();
    var after = Date.now();
    assert(/^\d{19}$/.test(id), "not a 19-digit number: " + id);
    var ms = Number(BigInt(id) >> BigInt(22));
    assert(ms >= before && ms <= after, "decodes to " + ms + ", sent between " + before + " and " + after);
  });

  it("strictly increase, even within the same millisecond", function() {
    var client = new E2EEClient({ userID: "1", globalOptions: {} }, {});
    var previous = BigInt(0);
    for (var i = 0; i < 2000; i++) {
      var id = BigInt(client.nextMessageId());
      assert(id > previous, "id " + i + " did not increase");
      previous = id;
    }
  });
});
