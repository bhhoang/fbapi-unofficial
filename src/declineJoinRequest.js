"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "37337945279154076";

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function declineJoinRequest(groupID, userID, callback) {
    if (!callback) throw { error: "declineJoinRequest: need callback" };

    var variables = {
      currentSection: "MEMBER_REQUESTS",
      input: {
        attribution_id_v2: relayGraphql.attributionID(
          "CometGroupMemberRequestsRoot.react",
          "comet.group.member_requests"
        ),
        consequence: "NONE",
        group_id: String(groupID),
        name_search_string: "",
        pending_member_filters: { filters: [] },
        source: "requests_queue",
        user_id: String(userID),
        actor_id: ctx.userID,
        client_mutation_id: String(ctx.clientMutationId++)
      },
      scale: 1
    };

    postGraphql(
      "GroupsCometDeclinePendingMemberMutation",
      DOC_ID,
      variables
    )
      .then(function() {
        callback(null, {
          groupID: String(groupID),
          userID: String(userID),
          declined: true
        });
      })
      .catch(function(err) {
        log.error("declineJoinRequest", err.error || err.message || err);
        callback(err);
      });
  };
};
