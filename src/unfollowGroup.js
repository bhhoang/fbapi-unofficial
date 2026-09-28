"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "9558102717592331";

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function unfollowGroup(groupID, callback) {
    if (!callback) throw { error: "unfollowGroup: need callback" };

    var variables = {
      input: {
        attribution_id_v2: relayGraphql.attributionID(
          "GroupsCometAboutPanel.react",
          "comet.group"
        ),
        group_id: String(groupID),
        subscribe_location: "PROFILE"
      }
    };

    postGraphql("useGroupsCometUnfollowMutation", DOC_ID, variables)
      .then(function() {
        callback(null, { groupID: String(groupID), following: false });
      })
      .catch(function(err) {
        log.error("unfollowGroup", err.error || err.message || err);
        callback(err);
      });
  };
};
