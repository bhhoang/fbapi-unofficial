"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "23954755464142194";

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function followGroup(groupID, callback) {
    if (!callback) throw { error: "followGroup: need callback" };

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

    postGraphql("useGroupsCometFollowMutation", DOC_ID, variables)
      .then(function() {
        callback(null, { groupID: String(groupID), following: true });
      })
      .catch(function(err) {
        log.error("followGroup", err.error || err.message || err);
        callback(err);
      });
  };
};
