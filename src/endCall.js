"use strict";

var log = require("npmlog");
var utils = require("../utils");

module.exports = function(defaultFuncs, api, ctx) {
  // Ends an active call, or cancels a call that is still ringing
  // (HANGUP with reason HANGUP_CALL).
  return function endCall(callID, callback) {
    if (utils.getType(callID) === "Function" || utils.getType(callID) === "AsyncFunction") {
      callback = callID;
      callID = null;
    }
    if (!callback) {
      callback = function(err) {
        if (err) log.error("endCall", err);
      };
    }
    if (!ctx.rtcClient) {
      return callback({ error: "endCall: no active call." });
    }
    ctx.rtcClient.end(callID, callback);
  };
};
