"use strict";

// Offline tests for which remote tracks the call client subscribes to. The
// SFU only forwards tracks a participant has subscribed to, and Messenger web
// subscribes to the other participant's video as soon as the JOIN response
// lists it.

var assert = require("assert");
var CallClient = require("../../src/rtc/client").CallClient;
var proto = require("../../src/rtc/proto");

var ME = "61591112920161";
var PEER = "100035400259877";

function joinResponseMessage() {
  // Shaped like the JOIN response captured from a real call: `mediaStatus` is
  // a plain map, the per-track details are in `mediaStatusEx.tracks`.
  return {
    messageHeader: {
      type: proto.MessageType.JOIN,
      conferenceName: "ROOM:1",
      serverInfoData: "server-info",
      responseStatusCode: proto.RtcResponseStatusCode.OK
    },
    messageBody: {
      joinResponse: {
        mediaPath: proto.MediaPath.SFU,
        mediaStatus: { "256301852361513736": true, "6240912305017669212": true },
        mediaStatusEx: {
          tracks: {
            "256301852361513736": { enabled: true, owner: PEER, label: proto.TrackLabel.DEFAULT_AUDIO },
            "6240912305017669212": { enabled: true, owner: PEER, label: proto.TrackLabel.DEFAULT_VIDEO }
          }
        }
      }
    }
  };
}

describe("src/rtc/client subscriptions", function() {
  it("subscribes to the peer's tracks listed in the JOIN response", function() {
    var client = new CallClient({ userID: ME, globalOptions: {} }, {});
    var call = { direction: "incoming", state: "connected", mediaSession: { e2eeMedia: null } };
    var sent = [];
    client.findCallForMessage = function() { return call; };
    client.flushLocalCandidates = function() {};
    client.refreshMediaRelays = function() {};
    client.send = function(header, body) { sent.push({ type: header.type, body: body }); };

    client.onJoinResponse(joinResponseMessage());

    var subscriptions = sent
      .filter(function(m) { return m.type === proto.MessageType.SUBSCRIPTION; })
      .reduce(function(all, m) { return all.concat(m.body.subscriptionRequest.subscriptions); }, []);
    var tracks = subscriptions.map(function(s) { return s.trackId; }).sort();
    assert.deepStrictEqual(tracks, ["256301852361513736", "6240912305017669212"]);
    subscriptions.forEach(function(s) {
      assert.strictEqual(s.type, proto.SubscriptionType.TRACK);
    });
  });
});
