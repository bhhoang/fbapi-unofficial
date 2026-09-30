"use strict";

// In calls we place, the other participant joins after our media state was
// published, so the E2EE state we got back doesn't list them and our E2EE key
// is never sent. Messenger web re-sends its media state with unchanged
// versions a few seconds after joining; the server's answer carries the
// current E2eeState. The call client does the same when a peer joins.

var assert = require("assert");
var CallClient = require("../../src/rtc/client").CallClient;
var proto = require("../../src/rtc/proto");

var ME = "61591112920161";
var PEER = "100035400259877";

function conferenceState(state) {
  var participants = {};
  participants[ME] = { state: 9 };
  participants[PEER] = { state: state };
  return {
    messageHeader: { type: proto.MessageType.CONFERENCE_STATE, conferenceName: "ROOM:1", transactionId: "5" },
    messageBody: { conferenceStateRequest: { version: "7", participantStates: participants } }
  };
}

function setup(call) {
  var client = new CallClient({ userID: ME, globalOptions: {} }, {});
  var sent = [];
  client.findCallForMessage = function() { return call; };
  client.startCallAudio = function() {};
  client.send = function(header, body) { sent.push({ type: header.type, body: body }); };
  return { client: client, sent: sent };
}

function mediaUpdates(sent) {
  return sent.filter(function(m) { return m.type === proto.MessageType.CLIENT_MEDIA_UPDATE; });
}

describe("src/rtc/client E2EE state refresh", function() {
  function e2eeCall() {
    return {
      conferenceName: "ROOM:1",
      clientMediaVersion: 1,
      audioTrackId: "audio-track",
      videoTrackId: "video-track",
      mediaSession: { e2eeMedia: {} }
    };
  }

  it("re-sends the media state with unchanged versions when the peer joins", function() {
    var s = setup(e2eeCall());
    s.client.onConferenceState(conferenceState(9));
    var updates = mediaUpdates(s.sent);
    assert.strictEqual(updates.length, 1);
    var request = updates[0].body.clientMediaUpdateRequest;
    assert.strictEqual(String(request.fromVersion), "1");
    assert.strictEqual(String(request.toVersion), "1");
    var tracks = request.mediaUpdates[0].mediaStatusEx.tracks;
    assert.strictEqual(tracks["audio-track"].label, proto.TrackLabel.DEFAULT_AUDIO);
    assert.strictEqual(tracks["video-track"].label, proto.TrackLabel.DEFAULT_VIDEO);
  });

  it("does it once per call, and only for encrypted calls with published media", function() {
    var s = setup(e2eeCall());
    s.client.onConferenceState(conferenceState(9));
    s.client.onConferenceState(conferenceState(5));
    s.client.onConferenceState(conferenceState(9));
    assert.strictEqual(mediaUpdates(s.sent).length, 1);

    var plain = e2eeCall();
    plain.mediaSession = { e2eeMedia: null };
    var s2 = setup(plain);
    s2.client.onConferenceState(conferenceState(9));
    assert.strictEqual(mediaUpdates(s2.sent).length, 0);

    var unpublished = e2eeCall();
    delete unpublished.clientMediaVersion;
    var s3 = setup(unpublished);
    s3.client.onConferenceState(conferenceState(9));
    assert.strictEqual(mediaUpdates(s3.sent).length, 0);
  });
});
