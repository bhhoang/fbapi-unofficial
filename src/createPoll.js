"use strict";

var utils = require("../utils");
var log = require("npmlog");
var lightspeed = require("./lightspeed");

// Creates a thread poll. The legacy HTTP endpoint
// (/messaging/group_polling/create_poll) was retired by Facebook; the web
// client publishes a `poll_creation` task on the Lightspeed gateway socket
// instead (see src/lightspeed.js for the captured envelope). The result is
// { pollID, response } — pollID is present when the server's response carried
// it, response is the raw channel-23 text for diagnostics.
module.exports = function(defaultFuncs, api, ctx) {
  return function createPoll(title, threadID, options, callback) {
    if (!callback) {
      if (utils.getType(options) == "Function") {
        callback = options;
      } else {
        callback = function() {};
      }
    }
    if (!options) {
      options = {}; // Initial poll options are optional
    }

    var optionTexts = [];
    for (var opt in options) {
      if (options.hasOwnProperty(opt)) {
        optionTexts.push(opt);
      }
    }
    if (!optionTexts.length) {
      return callback({ error: "createPoll: at least one poll option is needed" });
    }

    lightspeed.publishPoll(ctx, threadID, title, optionTexts, function(err, result) {
      if (err) {
        log.error("createPoll", err);
        return callback(err);
      }
      callback(null, result);
    });
  };
};
