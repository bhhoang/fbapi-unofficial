"use strict";

var log = require("npmlog");
var E2EEClient = require("./e2ee/client").E2EEClient;

module.exports = function(defaultFuncs, api, ctx) {
  return function connectE2EE(callback) {
    if (!callback) callback = function() {};
    if (!ctx.e2eeClient) {
      ctx.e2eeClient = new E2EEClient(ctx, defaultFuncs);
    }
    ctx.e2eeClient.connect(function(err, result) {
      if (err) {
        log.error("connectE2EE", err);
        return callback(err);
      }
      callback(null, result);
    });
  };
};
