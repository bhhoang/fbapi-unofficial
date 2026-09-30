"use strict";

var log = require("npmlog");
var CallClient = require("./rtc/client").CallClient;

module.exports = function(defaultFuncs, api, ctx) {
  // Opens the call-signaling connection (and subscribes to the /t_rtc_multi
  // topic) so incoming calls are delivered as {type: "call"} events through
  // api.listenMqtt. Calling any other call function connects lazily; this
  // method just makes the connection explicit (for example to wait for an
  // incoming call before placing one).
  return function connectCalls(callback) {
    if (!callback) callback = function() {};
    if (!ctx.rtcClient) {
      ctx.rtcClient = new CallClient(ctx, defaultFuncs);
    }
    // Load the media engines while the connection is being set up, instead of
    // in the middle of the first call (~0.6 s of blocking the first time).
    setImmediate(function() {
      try {
        require("./rtc/media").preloadEngines();
      } catch (e) {
        log.verbose("connectCalls", "Could not preload the media engines: " + e.message);
      }
    });
    ctx.rtcClient.ensureConnected(function(err) {
      if (err) {
        log.error("connectCalls", err);
        return callback({ error: "connectCalls: could not connect to call signaling.", err: err });
      }
      callback();
    });
  };
};
