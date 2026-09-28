"use strict";

// Place a Messenger call and drive its signaling.
//
// This library implements call signaling only: the called device rings, shows
// the call and can answer, and this side can accept, decline or hang up. No
// audio or video is transmitted (a synthesized SDP offer is sent so Facebook
// accepts the join).
//
// One-to-one chats are end-to-end encrypted and Facebook requires the client's
// E2EE call state ("E2eeState" state-sync topic) to join such a call. Without
// it api.call fails with an `e2eeRequired` error. Group calls are not E2EE
// mandated.
//
// Usage:
//   node examples/call.js <userID> [path/to/appstate.json] [seconds]
//
// Incoming calls are reported by api.listenMqtt as
// {type: "call", event: "ring", callID, peerID}.

var fs = require("fs");
var path = require("path");
var login = require("../index.js");

var targetID = process.argv[2];
var appStatePath = process.argv[3] || path.join(__dirname, "appstate.json");
var ringSeconds = parseInt(process.argv[4] || "15", 10);

if (!targetID) {
  console.error("Usage: node examples/call.js <userID> [path/to/appstate.json] [seconds]");
  process.exit(1);
}
if (!fs.existsSync(appStatePath)) {
  console.error("No appState file found at: " + appStatePath);
  console.error("See examples/loginWithAppState.js for how to create one.");
  process.exit(1);
}

var appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));

login({ appState: appState }, { logLevel: "info" }, function(err, api) {
  if (err) return console.error(err.error || err);

  var stopListening = api.listenMqtt(function(listenErr, event) {
    if (listenErr) return console.error(listenErr);
    if (event && event.type === "call") {
      console.log("[call] " + event.event + " " + (event.reason || ""));
      if (event.event === "ring") {
        console.log("incoming call from " + event.peerID);
        // api.acceptCall(event.callID, { e2eeState: e2eeState }, function(acceptErr) { ... });
        // api.declineCall(event.callID);
      }
    }
  });

  // Incoming calls are only reported while the signaling connection is open.
  api.connectCalls(function(connectErr) {
    if (connectErr) console.error(connectErr.error || connectErr);
  });

  api.call(targetID, { video: false }, function(callErr, call) {
    if (callErr) {
      console.error(callErr.error || callErr);
      if (callErr.e2eeRequired) {
        console.error(
          "Hint: capture the `E2eeState` blob from the web client's join and " +
          "pass it as options.e2eeState, or call a group thread instead."
        );
      }
      stopListening();
      return;
    }
    console.log("Ringing " + call.callID + " (" + call.state + ")");

    setTimeout(function() {
      api.endCall(call.callID, function(endErr) {
        if (endErr) console.error(endErr.error || endErr);
        else console.log("Call ended");
        stopListening();
      });
    }, ringSeconds * 1000);
  });
});
