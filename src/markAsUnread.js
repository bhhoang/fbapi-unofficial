"use strict";

var log = require("npmlog");
var lightspeed = require("./lightspeed");
var markAsRead = require("./markAsRead");

// Marks a thread unread by re-publishing the read-watermark task (label 49)
// with an older watermark - exactly what the web client does ("Mark as
// unread"). Without an explicit timestamp the watermark is set just before the
// thread's last message, so only the newest message shows as unread.
//
//   markAsUnread(threadID, callback)
//   markAsUnread(threadID, unreadSinceMs, callback)

module.exports = function(defaultFuncs, api, ctx) {
  return function markAsUnread(threadID, timestamp, callback) {
    if (!callback && typeof timestamp === "function") {
      callback = timestamp;
      timestamp = null;
    }
    if (!callback) {
      callback = function() {};
    }

    function publish(watermark) {
      var task = markAsRead.buildUnreadTask(
        threadID,
        watermark,
        markAsRead.syncGroupFor(ctx, threadID)
      );
      lightspeed.publishTasks(ctx, [task], function(err) {
        if (err) {
          log.error("markAsUnread", err.error || err.message || err);
          return callback(err);
        }
        callback(null, {
          threadID: String(threadID),
          read: false,
          watermarkTimestampMs: task.payload.last_read_watermark_timestamp_ms
        });
      });
    }

    if (timestamp != null && isFinite(Number(timestamp))) {
      return publish(Number(timestamp));
    }

    api.getThreadInfo(threadID, function(err, info) {
      var watermark = 0;
      var lastActivity = info && (info.lastMessageTimestamp || info.timestamp);
      if (!err && lastActivity) {
        watermark = Math.max(0, Number(lastActivity) - 1);
      } else {
        log.warn(
          "markAsUnread",
          "could not read the thread's last message timestamp" +
            (err ? " (" + (err.error || err.message || err) + ")" : "") +
            "; marking every message unread."
        );
      }
      publish(watermark);
    });
  };
};
