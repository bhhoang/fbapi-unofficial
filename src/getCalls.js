"use strict";

module.exports = function(defaultFuncs, api, ctx) {
  // Returns the calls this client currently knows about (ringing, incoming or
  // connected).
  return function getCalls(callback) {
    var calls = ctx.rtcClient ? ctx.rtcClient.getCalls() : [];
    if (callback) callback(null, calls);
    return calls;
  };
};
