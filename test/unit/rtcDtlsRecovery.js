"use strict";

// werift fails a DTLS transport when it chokes on a handshake record that
// arrives after the handshake, and its senders then drop all RTP while ICE is
// still up: the outbound video went silent 33 s into a call. The media
// session puts an established transport back to "connected".

var assert = require("assert");
var media = require("../../src/rtc/media.js");

function fakeEvent() {
  var listeners = [];
  return {
    subscribe: function(fn) { listeners.push(fn); },
    execute: function(value) { listeners.slice().forEach(function(fn) { fn(value); }); }
  };
}

function fakeTransport(state) {
  var transport = {
    state: state,
    srtp: {},
    onStateChange: fakeEvent(),
    dtls: { onError: fakeEvent() },
    setState: function(next) {
      if (next === transport.state) return;
      transport.state = next;
      transport.onStateChange.execute(next);
    }
  };
  return transport;
}

function session(transport, ice) {
  var s = Object.create(media.MediaSession.prototype);
  s.pc = { iceConnectionState: ice, dtlsTransports: [transport] };
  return s;
}

describe("src/rtc/media DTLS failure recovery", function() {
  it("restores an established transport that werift marked failed", function(done) {
    var transport = fakeTransport("connected");
    var s = session(transport, "connected");
    s.guardDtlsTransport(transport);
    transport.dtls.onError.execute(new Error("stray handshake"));
    transport.setState("failed");
    assert.strictEqual(s.canSendRtp(), false);
    setImmediate(function() {
      assert.strictEqual(transport.state, "connected");
      assert.strictEqual(s.dtlsRecoveries, 1);
      assert.strictEqual(s.canSendRtp(), true);
      assert.strictEqual(s.blockedPackets, 0);
      done();
    });
  });

  it("leaves the transport failed when ICE is down", function(done) {
    var transport = fakeTransport("connected");
    var s = session(transport, "disconnected");
    s.guardDtlsTransport(transport);
    transport.setState("failed");
    setImmediate(function() {
      assert.strictEqual(transport.state, "failed");
      assert.strictEqual(s.canSendRtp(), false);
      done();
    });
  });

  it("does not touch a transport closed by an alert", function(done) {
    var transport = fakeTransport("connected");
    var s = session(transport, "connected");
    s.guardDtlsTransport(transport);
    transport.setState("closed");
    setImmediate(function() {
      assert.strictEqual(transport.state, "closed");
      done();
    });
  });
});
