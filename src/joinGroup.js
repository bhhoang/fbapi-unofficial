"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "28560961653595096";

// Joins a Facebook Group, or sends a join request when the group is private.
// The response tells which one happened: `is_viewer_member` is true after a
// direct join, while `viewer_join_state` becomes "REQUESTED" for a request.
module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function joinGroup(groupID, callback) {
    if (!callback) throw { error: "joinGroup: need callback" };

    var variables = {
      feedType: "DISCUSSION",
      groupID: String(groupID),
      input: {
        action_source: "GROUP_MALL",
        attribution_id_v2: relayGraphql.attributionID(
          "GroupsCometGroupHeader.react",
          "comet.group"
        ),
        group_id: String(groupID),
        group_share_tracking_params: null
      },
      renderLocation: "group_mall",
      scale: 1
    };

    postGraphql("useGroupRequestToJoinMutation", DOC_ID, variables)
      .then(function(objects) {
        var group = null;
        objects.forEach(function(o) {
          var joined =
            o &&
            o.data &&
            o.data.group_request_to_join &&
            o.data.group_request_to_join.group;
          if (joined) group = joined;
        });
        callback(null, {
          groupID: String(groupID),
          joined: !!(group && group.viewer_join_state === "MEMBER"),
          joinState: group ? group.viewer_join_state : null
        });
      })
      .catch(function(err) {
        log.error("joinGroup", err.error || err.message || err);
        callback(err);
      });
  };
};
