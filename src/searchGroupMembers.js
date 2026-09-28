"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "28372658165708479";

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function searchGroupMembers(groupID, query, amount, callback) {
    if (!callback) {
      if (typeof amount === "function") {
        callback = amount;
        amount = 20;
      } else {
        throw { error: "searchGroupMembers: need callback" };
      }
    }
    if (typeof amount !== "number" || amount <= 0) amount = 20;

    var variables = {
      count: amount,
      cursor: null,
      groupID: String(groupID),
      query: String(query || ""),
      scale: 1,
      id: String(groupID)
    };

    postGraphql(
      "useGroupsCometMemberSearchResultsRefetchQuery",
      DOC_ID,
      variables
    )
      .then(function(objects) {
        var members = [];
        var seen = {};
        function walk(obj) {
          if (!obj || typeof obj !== "object") return;
          if (Array.isArray(obj)) {
            obj.forEach(walk);
            return;
          }
          if (obj.node && obj.node.id && obj.node.name) {
            var node = obj.node;
            if (!seen[node.id]) {
              seen[node.id] = true;
              members.push({
                userID: String(node.id),
                name: node.name || null,
                url: node.url || node.profile_url || null,
                joinedText: obj.join_status_text
                  ? obj.join_status_text.text
                  : null,
                city: node.bio_text ? node.bio_text.text : null,
                profilePicture: node.profile_picture
                  ? node.profile_picture.uri
                  : null
              });
            }
          }
          Object.keys(obj).forEach(function(key) {
            walk(obj[key]);
          });
        }
        objects.forEach(walk);
        callback(null, members);
      })
      .catch(function(err) {
        log.error("searchGroupMembers", err.error || err.message || err);
        callback(err);
      });
  };
};
