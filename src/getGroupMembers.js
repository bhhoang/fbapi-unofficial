"use strict";

var log = require("npmlog");

// Facebook Groups searches members through the People tab (empty query = a
// sample of members). A Messenger group chat has no Groups backend, so when
// that search yields nothing this falls back to the thread's participant list
// (api.getThreadInfo), which covers both groups and regular chats.
module.exports = function(defaultFuncs, api, ctx) {
  return function getGroupMembers(groupID, amount, callback) {
    if (!callback) {
      if (typeof amount === "function") {
        callback = amount;
        amount = 20;
      } else {
        throw { error: "getGroupMembers: need callback" };
      }
    }
    api.searchGroupMembers(groupID, "", amount, function(err, members) {
      if (!err && Array.isArray(members) && members.length) {
        return callback(null, members);
      }
      api.getThreadInfo(groupID, function(threadErr, info) {
        if (threadErr) {
          log.warn("getGroupMembers", "participant fallback failed: " +
            JSON.stringify(threadErr).slice(0, 160));
          return callback(err || threadErr, Array.isArray(members) ? members : []);
        }
        var ids = (info && info.participantIDs) || [];
        var result = ids.map(function(id) {
          return {
            userID: String(id),
            name: null,
            url: null,
            joinedText: null,
            city: null,
            profilePicture: null
          };
        });
        if (amount > 0) result = result.slice(0, amount);
        callback(null, result);
      });
    });
  };
};
