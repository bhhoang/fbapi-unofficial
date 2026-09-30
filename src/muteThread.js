"use strict";

var log = require("npmlog");
var lightspeed = require("./lightspeed");

// The web client mutes a thread by publishing a Lightspeed task (label 144):
//
//   mute:   {"thread_key":<id>,"mailbox_type":0,"mute_expire_time_ms":-1,"sync_group":1}
//   unmute: same with mute_expire_time_ms:0
//
// The old endpoint (/ajax/mercury/change_mute_thread.php) answers 404 now.
// muteSeconds keeps the historical API (-1 = forever, 0 = unmute, N = seconds
// from now); a value that already looks like an absolute millisecond timestamp
// is passed through unchanged.

function muteExpireMs(muteSeconds, now) {
  var n = Number(muteSeconds);
  if (!isFinite(n)) return null;
  if (n === -1) return -1;
  if (n === 0) return 0;
  if (n > 1e12) return Math.round(n);
  return Math.round((now == null ? Date.now() : now) + n * 1000);
}

function syncGroupFor(ctx, threadID) {
  return ctx.e2eeThreads && ctx.e2eeThreads[String(threadID)] ? 95 : 1;
}

module.exports = function(defaultFuncs, api, ctx) {
  return function muteThread(threadID, muteSeconds, callback) {
    if (!callback) {
      callback = function() {};
    }

    var expire = muteExpireMs(muteSeconds);
    if (expire === null) {
      return callback({
        error: "muteThread: muteSeconds must be a number (-1 = forever, 0 = unmute, N = seconds)"
      });
    }

    var threadKey = Number(threadID);
    if (!isFinite(threadKey)) {
      return callback({ error: "muteThread: the thread id must be numeric" });
    }

    var payload = {
      thread_key: threadKey,
      mailbox_type: 0,
      mute_expire_time_ms: expire,
      sync_group: syncGroupFor(ctx, threadID)
    };

    lightspeed.publishTasks(ctx, [
      { label: "144", payload: payload, queueName: String(threadID) }
    ], function(err) {
      if (err) {
        log.error("muteThread", err.error || err.message || err);
        return callback(err);
      }
      callback(null, {
        threadID: String(threadID),
        muted: expire !== 0,
        muteExpireTimeMs: expire
      });
    });
  };
};

module.exports.muteExpireMs = muteExpireMs;
