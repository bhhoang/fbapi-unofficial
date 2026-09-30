"use strict";

var utils = require("../utils");

// Facebook retired /ajax/mercury/search_threads.php (it answers with 404 now).
// This rebuilds what callers actually need from a search using the parts that
// still work:
//   1. resolve the query as a username to a user id and present the 1:1
//      thread (Messenger uses the peer's user id as the thread id), and
//   2. match the name against the account's own thread list.
// The result keeps the original shape: an array of utils.formatThread entries.
module.exports = function(defaultFuncs, api, ctx) {
  function notFound(name) {
    return { error: "Could not find thread `" + name + "`." };
  }

  return function searchForThread(name, callback) {
    if (!callback) {
      throw { error: "searchForThread: need callback" };
    }
    var query = String(name || "");
    if (!query) {
      return callback(notFound(name));
    }

    var results = [];
    var seen = {};

    function addThread(thread) {
      if (!thread || thread.threadID == null) return;
      if (seen[thread.threadID]) return;
      seen[thread.threadID] = true;
      results.push(thread);
    }

    function finish() {
      if (!results.length) return callback(notFound(name));
      callback(null, results);
    }

    function scanOwnThreads() {
      api.getThreadList(100, null, ["INBOX", "OTHER", "PENDING"], function(err, list) {
        if (!err && Array.isArray(list)) {
          var needle = query.toLowerCase();
          list.forEach(function(thread) {
            var threadName = thread && thread.name ? String(thread.name).toLowerCase() : "";
            if (threadName.indexOf(needle) !== -1) addThread(thread);
          });
        }
        finish();
      });
    }

    // A username resolves to a user id; a 1:1 thread's id is that user id.
    api.getUserID(query, function(err, entries) {
      if (!err && Array.isArray(entries)) {
        entries.forEach(function(entry) {
          if (!entry || !entry.userID) return;
          addThread(utils.formatThread({
            thread_fbid: entry.userID,
            participants: [ctx.userID, entry.userID],
            name: entry.name,
            snippet: "",
            custom_nickname: null
          }));
        });
      }
      scanOwnThreads();
    });
  };
};
