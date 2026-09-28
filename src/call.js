"use strict";

var log = require("npmlog");
var CallClient = require("./rtc/client").CallClient;
var utils = require("../utils");

module.exports = function(defaultFuncs, api, ctx) {
  // Starts a voice or video call to a user (or group) through Messenger's
  // "Multiway" (Zenon) call signaling.
  //
  // options:
  //   video:        true to request a video call (default false = audio).
  //   offerSdp:     full SDP offer to send. When omitted a synthetic offer is
  //                 generated; signaling works, but no audio/video flows.
  //   callTrigger:  value for the joining_context call_trigger field.
  //   e2ee:         true to request an end-to-end encrypted call.
  //   timeout:      ms to wait for Facebook to accept the call (default 20000).
  return function call(threadID, options, callback) {
    if (!threadID) {
      throw { error: "call: need a threadID to call." };
    }
    if (utils.getType(options) === "Function" || utils.getType(options) === "AsyncFunction") {
      callback = options;
      options = {};
    }
    if (!callback) {
      callback = function(err) {
        if (err) log.error("call", err);
      };
    }
    if (!ctx.rtcClient) {
      ctx.rtcClient = new CallClient(ctx, defaultFuncs);
    }
    ctx.rtcClient.startCall(threadID, options, callback);
  };
};
