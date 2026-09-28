"use strict";

var log = require("npmlog");
var utils = require("../utils");

module.exports = function(defaultFuncs, api, ctx) {
  // Accepts a ringing incoming call. `callID` is optional when only one call
  // is active.
  //
  // options:
  //   answerSdp: SDP answer to send (needed to exchange media with the caller).
  //   offerSdp:  SDP offer to send instead (used when the caller is on SFU).
  //   e2ee:      true to request an end-to-end encrypted call.
  return function acceptCall(callID, options, callback) {
    if (utils.getType(callID) === "Function" || utils.getType(callID) === "AsyncFunction") {
      callback = callID;
      callID = null;
    } else if (utils.getType(options) === "Function" || utils.getType(options) === "AsyncFunction") {
      callback = options;
      options = {};
    }
    if (utils.getType(callID) === "Object" && callID !== null) {
      options = callID;
      callID = null;
    }
    if (!callback) {
      callback = function(err) {
        if (err) log.error("acceptCall", err);
      };
    }
    if (!ctx.rtcClient) {
      return callback({ error: "acceptCall: no calls to accept." });
    }
    ctx.rtcClient.accept(callID, options || {}, callback);
  };
};
