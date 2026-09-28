"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "27788177020768038";

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function markGroupVisited(groupID, callback) {
    if (!callback) throw { error: "markGroupVisited: need callback" };

    var variables = {
      bookmarkID: String(groupID),
      input: {
        badge_entry_point: "GROUPS_TAB_MAIN",
        bookmark_folder_id: "FAVORITES",
        environment: "COMET",
        group_id: String(groupID)
      },
      scale: 1
    };

    postGraphql("useGroupsCometVisitMutation", DOC_ID, variables)
      .then(function() {
        callback(null, { groupID: String(groupID), visited: true });
      })
      .catch(function(err) {
        log.error("markGroupVisited", err.error || err.message || err);
        callback(err);
      });
  };
};
