"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "28493416426984190";

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function leaveGroup(groupID, callback) {
    if (!callback) throw { error: "leaveGroup: need callback" };

    var variables = {
      input: {
        attribution_id_v2: relayGraphql.attributionID(
          "CometGroupDiscussionRoot.react",
          "comet.group"
        ),
        group_id: String(groupID),
        actor_id: ctx.userID,
        client_mutation_id: String(ctx.clientMutationId++)
      },
      inviteShortLinkKey: null,
      isChainingRecommendationUnit: false,
      ordering: ["viewer_added"],
      scale: 1,
      groupID: String(groupID)
    };

    postGraphql("GroupCometLeaveForumMutation", DOC_ID, variables)
      .then(function() {
        callback(null, { groupID: String(groupID), left: true });
      })
      .catch(function(err) {
        log.error("leaveGroup", err.error || err.message || err);
        callback(err);
      });
  };
};
