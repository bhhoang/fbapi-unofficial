"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var reactions = {
  LIKE: "1635855486666999",
  LOVE: "1678524932434102",
  HAHA: "115940658764963",
  WOW: "478547315650144",
  SAD: "908563459236466",
  ANGRY: "444813342392137",
  CARE: "613557422527858"
};

var DOC_ID = "28316088138022831";

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function getPostReactions(postID, options, callback) {
    if (!callback) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      } else {
        throw { error: "getPostReactions: need callback" };
      }
    }
    options = options || {};

    var reactionID = null;
    if (options.reaction != null) {
      var raw = String(options.reaction);
      reactionID = reactions[raw.toUpperCase()] || raw;
    }

    var variables = {
      feedbackTargetID: Buffer.from("feedback:" + postID).toString("base64"),
      reactionID: reactionID,
      scale: 1
    };
    if (options.cursor != null) variables.cursor = String(options.cursor);

    postGraphql("CometUFIReactionsDialogQuery", DOC_ID, variables)
      .then(function(objects) {
        var users = [];
        var seen = {};
        function walk(obj) {
          if (!obj || typeof obj !== "object") return;
          if (Array.isArray(obj)) {
            obj.forEach(walk);
            return;
          }
          if (
            (obj.__typename === "User" || obj.__typename === "Page") &&
            obj.id &&
            obj.name &&
            !seen[obj.id]
          ) {
            seen[obj.id] = true;
            users.push({
              userID: String(obj.id),
              name: obj.name,
              url: obj.url || obj.profile_url || null,
              type: obj.__typename
            });
          }
          Object.keys(obj).forEach(function(key) {
            walk(obj[key]);
          });
        }
        objects.forEach(walk);
        callback(null, users, relayGraphql.firstPageInfo(objects, null));
      })
      .catch(function(err) {
        log.error("getPostReactions", err.error || err.message || err);
        callback(err);
      });
  };
};
