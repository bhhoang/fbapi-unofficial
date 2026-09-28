"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "28385045111162926";

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function approveJoinRequest(groupID, userID, callback) {
    if (!callback) throw { error: "approveJoinRequest: need callback" };

    var variables = {
      currentSection: "MEMBER_REQUESTS",
      input: {
        attribution_id_v2: relayGraphql.attributionID(
          "CometGroupMemberRequestsRoot.react",
          "comet.group.member_requests"
        ),
        group_id: String(groupID),
        name_search_string: "",
        pending_member_filters: { filters: [] },
        source: "requests_queue",
        user_id: String(userID),
        actor_id: ctx.userID,
        client_mutation_id: String(ctx.clientMutationId++)
      },
      groupID: String(groupID),
      scale: 1,
      user_id: String(userID)
    };

    postGraphql(
      "GroupsCometApprovePendingMemberMutation",
      DOC_ID,
      variables
    )
      .then(function() {
        callback(null, {
          groupID: String(groupID),
          userID: String(userID),
          approved: true
        });
      })
      .catch(function(err) {
        log.error("approveJoinRequest", err.error || err.message || err);
        callback(err);
      });
  };
};
