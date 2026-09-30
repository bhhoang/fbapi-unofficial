"use strict";

// Offline tests for the E2EE message transport shapes. Recipient-side copies
// carry the message's own id: integral.f2 = {f5: {f1: "<id>", f2: 1}}
// (captured from the user's phone sending to the library); self-device copies
// carry the destination block {f1: "<jid>"} instead.

var assert = require("assert");

var proto = require("../../src/e2ee/proto");
var clientModule = require("../../src/e2ee/client");

function integralOf(transport) {
  var fields = proto.decodeFields(transport);
  var protocol = proto.decodeFields(fields[2]);
  return proto.decodeFields(protocol[1]);
}

describe("src/e2ee/client message transport", function() {
  it("adds the recipient-side message reference block", function() {
    var transport = clientModule.encodeMessageTransport({
      messageApp: Buffer.from([0x0a, 0x00]),
      messageRef: "7510664055108826449"
    });
    var integral = integralOf(transport);
    var ref = proto.decodeFields(integral[2]);
    var inner = proto.decodeFields(ref[5]);
    assert.strictEqual(inner[1].toString(), "7510664055108826449");
    assert.strictEqual(Number(inner[2]), 1);
  });

  it("keeps the destination block for self-device copies", function() {
    var transport = clientModule.encodeMessageTransport({
      messageApp: Buffer.from([0x0a, 0x00]),
      dsm: { destinationJid: "100035400259877@msgr", phash: "" }
    });
    var integral = integralOf(transport);
    var dsm = proto.decodeFields(integral[2]);
    assert.strictEqual(dsm[1].toString(), "100035400259877@msgr");
    assert.strictEqual(dsm[5], undefined);
  });
});
