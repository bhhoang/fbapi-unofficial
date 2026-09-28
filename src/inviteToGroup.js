"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "26949495548074408";

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function inviteToGroup(groupID, userIDs, callback) {
    if (!callback) throw { error: "inviteToGroup: need callback" };

    var ids = Array.isArray(userIDs) ? userIDs : [userIDs];
    if (ids.length === 0) {
      throw { error: "inviteToGroup: userIDs must not be empty" };
    }

    var variables = {
      input: {
        attribution_id_v2: relayGraphql.attributionID(
          "CometGroupDiscussionRoot.react",
          "comet.group"
        ),
        email_addresses: [],
        group_id: String(groupID),
        source: "comet_invite_friends",
        user_ids: ids.map(String),
        actor_id: ctx.userID,
        client_mutation_id: String(ctx.clientMutationId++)
      },
      groupID: String(groupID)
    };

    postGraphql("useGroupAddMembersMutation", DOC_ID, variables)
      .then(function() {
        callback(null, {
          groupID: String(groupID),
          userIDs: ids.map(String),
          invited: true
        });
      })
      .catch(function(err) {
        log.error("inviteToGroup", err.error || err.message || err);
        callback(err);
      });
  };
};
