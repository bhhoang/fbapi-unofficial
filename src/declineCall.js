"use strict";

var log = require("npmlog");
var utils = require("../utils");

module.exports = function(defaultFuncs, api, ctx) {
  // Declines a ringing incoming call (HANGUP with reason IGNORE_CALL).
  return function declineCall(callID, callback) {
    if (utils.getType(callID) === "Function" || utils.getType(callID) === "AsyncFunction") {
      callback = callID;
      callID = null;
    }
    if (!callback) {
      callback = function(err) {
        if (err) log.error("declineCall", err);
      };
    }
    if (!ctx.rtcClient) {
      return callback({ error: "declineCall: no calls to decline." });
    }
    ctx.rtcClient.decline(callID, callback);
  };
};
