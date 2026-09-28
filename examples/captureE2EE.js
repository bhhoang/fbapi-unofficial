"use strict";

// Capture raw E2EE socket frames in order to implement/verify features that
// need real server traffic (most notably Messenger's end-to-end encrypted
// message history sync, which is pushed from a primary phone when a companion
// device is linked).
//
// What it does:
//   1. Logs in with an appState and connects the built-in E2EE client.
//   2. Appends every decrypted incoming E2EE frame to a JSONL file as
//      {ts, bytes, hex}, before any parsing.
//   3. Keeps listening and prints decrypted direct messages as they arrive.
//
// To capture a fresh device link (which is when history sync, if any, is
// pushed):
//   - Log into this same Facebook account in Messenger on a phone first.
//   - Run this script with a NEW device store path (third argument) so a new
//     companion device is registered, and keep it running.
//   - Watch the jsonl file grow; frames of interest are usually notifications
//     or ib nodes arriving shortly after the connection is ready.
//
// Usage:
//   node examples/captureE2EE.js [appstate.json] [device-store.json] [frames.jsonl]
//
// Defaults: examples/appstate.json, examples/e2ee_device.json, examples/e2ee_frames.jsonl

var fs = require("fs");
var path = require("path");
var login = require("../index.js");

var appStatePath = process.argv[2] || path.join(__dirname, "appstate.json");
var devicePath = process.argv[3] || path.join(__dirname, "e2ee_device.json");
var framesPath = process.argv[4] || path.join(__dirname, "e2ee_frames.jsonl");

if (!fs.existsSync(appStatePath)) {
  console.error("No appState file found at: " + appStatePath);
  console.error("See examples/loginWithAppState.js for how to create one.");
  process.exit(1);
}

var appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));

login(
  { appState: appState },
  {
    logLevel: "info",
    selfListen: true,
    listenEvents: true,
    e2eeDevicePath: devicePath,
    e2eeFrameLog: framesPath
  },
  function(err, api) {
    if (err) return console.error(err.error || err);

    var stop = api.listenMqtt(function(listenErr, event) {
      if (listenErr) return console.error("listen error:", listenErr.error || listenErr);
      if (event && (event.type === "message" || event.type === "message_reply")) {
        console.log("[message] " + (event.senderID || "?") + ": " + (event.body || ""));
      }
    });

    api.connectE2EE(function(e2eeErr, info) {
      if (e2eeErr) return console.error("E2EE connection failed:", e2eeErr.error || e2eeErr);
      console.log("E2EE connected as device " + info.deviceId);
      console.log("Device store : " + devicePath);
      console.log("Frame capture: " + framesPath);
      console.log("Keep this running while you link Messenger on your phone, then check the capture file.");
    });

    process.on("SIGINT", function() {
      stop();
      console.log("\nStopped. Captured frames are in " + framesPath);
      process.exit(0);
    });
  }
);
