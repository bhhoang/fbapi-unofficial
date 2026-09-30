"use strict";

// Outgoing video calls join the SFU directly. Started P2P, a web callee built
// a P2P leg from our offer that never connected and kept that leg's ended
// video track for our participant, so it showed our avatar. Joined on the
// SFU, the call never gets the server's renegotiation request, so the client
// renegotiates by itself once the peer's tracks appear: the answer lists the
// peer's streams and E2eeState, and only then is our E2EE key sent.

var assert = require("assert");
var client = require("../../src/rtc/client");
var proto = require("../../src/rtc/proto");

var ME = "61591112920161";
var PEER = "100074194021553";

function join(call) {
  return client.buildJoinRequest(Object.assign({ invitees: [PEER], peerID: PEER }, call), {});
}

describe("src/rtc/client SFU join", function() {
  it("joins outgoing 1:1 video calls on the SFU", function() {
    assert.strictEqual(join({ direction: "outgoing", isVideo: true }).clientMediaMode, proto.MediaPath.SFU);
  });

  it("keeps outgoing 1:1 audio calls P2P", function() {
    assert.strictEqual(join({ direction: "outgoing", isVideo: false }).clientMediaMode, proto.MediaPath.P2P);
  });

  it("follows the call's media path when accepting", function() {
    assert.strictEqual(join({ direction: "incoming", isVideo: true, mediaPath: proto.MediaPath.P2P }).clientMediaMode,
      proto.MediaPath.P2P);
  });

  it("renegotiates for the peer's streams in a call joined on the SFU", function() {
    var cc = new client.CallClient({ userID: ME }, {});
    var calls = 0;
    cc.initiateClientRenegotiation = function() { calls++; };
    var call = {
      mediaPath: proto.MediaPath.SFU,
      mediaSession: { e2eeMedia: {}, remoteDescriptionSet: true }
    };
    var update = { mediaStatus: { tracks: { v: { enabled: true, owner: PEER, label: proto.TrackLabel.DEFAULT_VIDEO } } } };
    cc.renegotiateForPeerStreams(call, update);
    cc.renegotiateForPeerStreams(call, update);
    assert.strictEqual(calls, 1);
  });

  it("waits for the server's request in a call started P2P", function() {
    var cc = new client.CallClient({ userID: ME }, {});
    var calls = 0;
    cc.initiateClientRenegotiation = function() { calls++; };
    var call = {
      mediaPath: proto.MediaPath.P2P,
      mediaSession: { e2eeMedia: {}, remoteDescriptionSet: true }
    };
    cc.renegotiateForPeerStreams(call, { mediaStatus: { tracks: { v: { owner: PEER } } } });
    assert.strictEqual(calls, 0);
  });
});

describe("src/rtc/client held media start", function() {
  function conferenceState(userID, state) {
    var states = {};
    states[userID] = { state: state };
    return {
      messageHeader: { type: proto.MessageType.CONFERENCE_STATE, conferenceName: "ROOM:1" },
      messageBody: { conferenceStateRequest: { version: "1", participantStates: states } }
    };
  }

  it("waits for the peer to be in the call, not for the call to be answered", function() {
    var cc = new client.CallClient({ userID: ME }, {});
    cc.emitCallEvent = function() {};
    cc.send = function() {};
    var call = { isGroup: false, state: "ringing", conferenceName: "ROOM:1", mediaSession: {} };
    cc.findCallForMessage = function() { return call; };
    cc.setConnected(call);
    assert.ok(!call.audioStarted, "media must not be scheduled when the call is answered");
    cc.onConferenceState(conferenceState(PEER, 9));
    assert.strictEqual(call.audioStarted, true);
    call.state = "ended";
  });
});
