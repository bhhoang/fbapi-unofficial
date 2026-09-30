"use strict";

var log = require("npmlog");
var lightspeed = require("./lightspeed");

// The web client marks a thread read by publishing two Lightspeed tasks with
// the read watermark (captured 2026-09-30):
//
//   label 49: {"thread_key":<id>,"last_read_watermark_timestamp_ms":<ts>,
//              "sync_group":<g>,"offline_threading_id":null}
//   label 21: {"thread_id":<id>,"last_read_watermark_ts":<ts>,
//              "sync_group":<g>,"offline_threading_id":null}
//
// Marking unread re-publishes label 49 with an older watermark (see
// markAsUnread). The old endpoint (/ajax/mercury/change_read_status.php) is
// gone.

function asThreadKey(threadID) {
  return /^\d+$/.test(String(threadID)) ? Number(threadID) : String(threadID);
}

function syncGroupFor(ctx, threadID) {
  return ctx.e2eeThreads && ctx.e2eeThreads[String(threadID)] ? 95 : 1;
}

function buildReadTasks(threadID, watermark, syncGroup) {
  var key = asThreadKey(threadID);
  var ts = Math.round(Number(watermark));
  return [
    {
      label: "49",
      queueName: String(threadID),
      payload: {
        thread_key: key,
        last_read_watermark_timestamp_ms: ts,
        sync_group: syncGroup,
        offline_threading_id: null
      }
    },
    {
      label: "21",
      queueName: String(threadID),
      payload: {
        thread_id: key,
        last_read_watermark_ts: ts,
        sync_group: syncGroup,
        offline_threading_id: null
      }
    }
  ];
}

function buildUnreadTask(threadID, watermark, syncGroup) {
  return {
    label: "49",
    queueName: String(threadID),
    payload: {
      thread_key: asThreadKey(threadID),
      last_read_watermark_timestamp_ms: Math.max(0, Math.round(Number(watermark) || 0)),
      sync_group: syncGroup,
      offline_threading_id: null
    }
  };
}

module.exports = function(defaultFuncs, api, ctx) {
  return function markAsRead(threadID, read, callback) {
    if (!callback && (typeof read === "function" || typeof read === "undefined")) {
      callback = read;
      read = true;
    }
    if (read == null) read = true;
    if (!callback) {
      callback = function() {};
    }

    // The historical signature allowed markAsRead(threadID, false) to mark a
    // thread unread; keep that working through the modern unread task.
    if (read === false) {
      return api.markAsUnread(threadID, callback);
    }

    var tasks = buildReadTasks(threadID, Date.now(), syncGroupFor(ctx, threadID));
    lightspeed.publishTasks(ctx, tasks, function(err) {
      if (err) {
        log.error("markAsRead", err.error || err.message || err);
        return callback(err);
      }
      callback(null, { threadID: String(threadID), read: true });
    });
  };
};

module.exports.buildReadTasks = buildReadTasks;
module.exports.buildUnreadTask = buildUnreadTask;
module.exports.syncGroupFor = syncGroupFor;
