"use strict";

// Log in using a saved appState (session cookies) instead of email/password.
//
// Why appState?
//   Password login is supported again (see the `login` docs), but Facebook can
//   answer it with an interactive security check before accepting a 2FA code,
//   which cannot be completed without a browser. appState sidesteps all of
//   that: you log in once in a real browser (satisfying password + 2FA there),
//   export the cookies, and reuse them here.
//
// How to get appstate.json:
//   1. Log into https://www.facebook.com in a browser (complete 2FA there).
//   2. Export your facebook.com cookies as JSON using a cookie-export browser
//      extension. The result must be an ARRAY of cookie objects. Both shapes
//      work here: objects with `key` (what api.getAppState() produces) or with
//      `name` (what most browser exporters produce).
//   3. Save that array as `appstate.json` next to this file (or pass a path as
//      the first CLI argument).
//
// This script also writes a *fresh* appState back to the same file right after
// logging in (via api.getAppState()), so your session stays current for reuse.
//
// Usage:
//   node examples/loginWithAppState.js [path/to/appstate.json]

var fs = require("fs");
var path = require("path");
var login = require("../index.js");

var appStatePath = process.argv[2] || path.join(__dirname, "appstate.json");

if (!fs.existsSync(appStatePath)) {
  console.error("No appState file found at: " + appStatePath);
  console.error("See the comment at the top of this file for how to create one.");
  process.exit(1);
}

var appState;
try {
  appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));
} catch (e) {
  console.error("Could not parse " + appStatePath + " as JSON: " + e.message);
  process.exit(1);
}

login({ appState: appState }, function(err, api) {
  if (err) {
    // The library now returns a specific, honest error (e.g. missing c_user,
    // malformed array, or "Not logged in." for an expired session).
    console.error("Login failed:", err.error || err);
    process.exit(1);
  }

  console.log("Logged in as user ID:", api.getCurrentUserID());

  // Persist a refreshed appState so the saved session doesn't go stale.
  try {
    fs.writeFileSync(appStatePath, JSON.stringify(api.getAppState(), null, 2));
    console.log("Saved a refreshed appState to:", appStatePath);
  } catch (e) {
    console.warn("Logged in, but couldn't save refreshed appState:", e.message);
  }

  // ---- Your bot logic goes here. Example: echo incoming messages. ----
  // api.listenMqtt(function(err, event) {
  //   if (err) return console.error(err);
  //   if (event.type === "message" && event.body) {
  //     api.sendMessage("Echo: " + event.body, event.threadID);
  //   }
  // });

  console.log("Ready. (Add your bot logic in examples/loginWithAppState.js.)");
});
