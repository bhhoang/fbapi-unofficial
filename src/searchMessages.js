"use strict";

// Search messages in a thread by paging through getThreadHistory.
//
// Works for every kind of thread the library can read history for: regular
// chats (GraphQL history) and end-to-end encrypted chats whose backup has been
// restored (see api.restoreE2EEBackup), because getThreadHistory already
// handles both.

var log = require("npmlog");

module.exports = function(defaultFuncs, api, _ctx) {
  return function searchMessages(threadID, query, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    if (!callback) {
      throw { error: "searchMessages: need callback" };
    }
    options = options || {};
    if (threadID == null || query == null) {
      return callback({ error: "searchMessages: need threadID and query" });
    }

    var needle = String(query);
    var caseSensitive = options.caseSensitive === true;
    var maxMessages = options.amount != null ? options.amount : 300;
    var pageSize = options.pageSize != null ? options.pageSize : 50;
    var maxMatches = options.limit != null ? options.limit : 50;
    if (pageSize < 1) pageSize = 1;
    if (pageSize > 500) pageSize = 500;

    var matches = [];
    var seen = {};
    var scanned = 0;
    var before = options.before != null ? options.before : null;

    function matchesQuery(message) {
      var haystack = String(
        message.body != null ? message.body : message.snippet != null ? message.snippet : ""
      );
      if (!caseSensitive) {
        haystack = haystack.toLowerCase();
      }
      return haystack.indexOf(needle) !== -1;
    }

    function nextPage() {
      if (scanned >= maxMessages || matches.length >= maxMatches) {
        return callback(null, matches);
      }
      var remaining = Math.min(pageSize, maxMessages - scanned);
      api.getThreadHistory(threadID, remaining, before, function(err, history) {
        if (err) {
          if (scanned > 0) {
            // Paging can hit the end of the available history; treat the
            // first error after a successful page as the end of the scan.
            return callback(null, matches);
          }
          log.error("searchMessages", err);
          return callback(err);
        }
        if (!Array.isArray(history) || history.length === 0) {
          return callback(null, matches);
        }
        var oldest = null;
        history.forEach(function(message) {
          var id = message && message.messageID != null ? String(message.messageID) : null;
          if (id != null) {
            if (seen[id]) return;
            seen[id] = true;
          }
          scanned++;
          if (message && typeof message.timestamp === "number") {
            if (oldest == null || message.timestamp < oldest) oldest = message.timestamp;
          }
          if (message && matchesQuery(message)) matches.push(message);
        });
        if (oldest == null || (before != null && oldest >= before)) {
          // No progress possible: avoid paging forever.
          return callback(null, matches);
        }
        before = oldest;
        setImmediate(nextPage);
      });
    }

    nextPage();
  };
};
