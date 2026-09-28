"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "28087767330918768";

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function removeGroupMember(groupID, userID, callback) {
    if (!callback) throw { error: "removeGroupMember: need callback" };

    var variables = {
      groupID: String(groupID),
      memberID: String(userID),
      input: {
        action_source: "MEMBER_LIST",
        attribution_id_v2: relayGraphql.attributionID(
          "GroupsCometMembersRoot.react",
          "comet.group.members"
        ),
        consequence: "NONE",
        group_id: String(groupID),
        should_apply_block_to_later_created_accounts: false,
        should_apply_to_other_groups_you_manage: false,
        should_delete_comments: false,
        should_delete_pending_invites: false,
        should_delete_polls: false,
        should_delete_posts: false,
        should_delete_reactions: false,
        should_delete_stories: false,
        user_id: String(userID),
        actor_id: ctx.userID,
        client_mutation_id: String(ctx.clientMutationId++)
      },
      scale: 1
    };

    postGraphql("GroupsCometRemoveMemberMutation", DOC_ID, variables)
      .then(function() {
        callback(null, {
          groupID: String(groupID),
          userID: String(userID),
          removed: true
        });
      })
      .catch(function(err) {
        log.error("removeGroupMember", err.error || err.message || err);
        callback(err);
      });
  };
};
