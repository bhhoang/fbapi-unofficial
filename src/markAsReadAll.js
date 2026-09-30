"use strict";

var log = require("npmlog");
var lightspeed = require("./lightspeed");
var markAsRead = require("./markAsRead");

// The old /ajax/mercury/mark_folder_as_read.php endpoint is gone; this marks
// every thread in the inbox/other/pending folders as read by publishing the
// same Lightspeed read-watermark tasks markAsRead uses (in chunks, so one
// epoch request does not carry hundreds of tasks).
module.exports = function(defaultFuncs, api, ctx) {
  return function markAsReadAll(callback) {
    if (!callback) {
      callback = function() {};
    }

    api.getThreadList(100, null, ["INBOX", "OTHER", "PENDING"], function(err, threads) {
      if (err) {
        log.error("markAsReadAll", err.error || err.message || err);
        return callback(err);
      }
      var list = (threads || []).filter(function(t) {
        return t && t.threadID;
      });
      var tasks = [];
      list.forEach(function(t) {
        var syncGroup = markAsRead.syncGroupFor(ctx, t.threadID);
        markAsRead.buildReadTasks(t.threadID, Date.now(), syncGroup).forEach(function(task) {
          tasks.push(task);
        });
      });
      if (!tasks.length) {
        return callback(null, { threads: 0, tasks: 0 });
      }

      var CHUNK = 40;
      var chunks = [];
      for (var i = 0; i < tasks.length; i += CHUNK) {
        chunks.push(tasks.slice(i, i + CHUNK));
      }
      var index = 0;
      (function publishNext() {
        if (index >= chunks.length) {
          return callback(null, { threads: list.length, tasks: tasks.length });
        }
        lightspeed.publishTasks(ctx, chunks[index++], function(perr) {
          if (perr) {
            log.error("markAsReadAll", perr.error || perr.message || perr);
            return callback(perr);
          }
          publishNext();
        });
      })();
    });
  };
};
