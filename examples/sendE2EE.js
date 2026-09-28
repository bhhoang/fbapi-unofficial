"use strict";

// Send an end-to-end encrypted message to a one-to-one chat.
//
// Direct chats are E2EE by default now. Plain text sends to them are routed
// through the built-in E2EE client automatically, but you can connect it ahead
// of time with api.connectE2EE to keep the first send fast.
//
// The first connection registers this library as an E2EE device for your
// account and stores its keys in `e2ee_device.json` (configurable with
// api.setOptions({ e2eeDevicePath })). Keep that file: deleting it registers
// a brand new device.
//
// Usage:
//   node examples/sendE2EE.js <userID> [path/to/appstate.json]

var fs = require("fs");
var path = require("path");
var login = require("../index.js");

var targetID = process.argv[2];
var appStatePath = process.argv[3] || path.join(__dirname, "appstate.json");

if (!targetID) {
  console.error("Usage: node examples/sendE2EE.js <userID> [path/to/appstate.json]");
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

  // listenMqtt has to be connected before plain text sends can reach E2EE
  // chats, because non-encrypted threads are sent over it.
  var stopListening = api.listenMqtt(function(listenErr) {
    if (listenErr) console.error(listenErr);
  });

  api.connectE2EE(function(e2eeErr, info) {
    if (e2eeErr) return console.error(e2eeErr.error || e2eeErr);
    console.log("E2EE device " + info.deviceId + " connected");

    api.sendMessage("Hello from the encrypted side " + Date.now(), targetID, function(sendErr, messageInfo) {
      if (sendErr) return console.error(sendErr.error || sendErr);
      console.log("Sent as " + messageInfo.messageID);
      stopListening();
    });
  });
});
