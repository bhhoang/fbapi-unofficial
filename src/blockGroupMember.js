"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "28033644796313334";

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function blockGroupMember(groupID, userID, callback) {
    if (!callback) throw { error: "blockGroupMember: need callback" };

    var variables = {
      groupID: String(groupID),
      input: {
        actor_id: ctx.userID,
        client_mutation_id: String(ctx.clientMutationId++),
        action_source: "MEMBER_LIST",
        apply_to_later_created_accounts: false,
        apply_to_other_groups_you_manage: false,
        attribution_id_v2: relayGraphql.attributionID(
          "GroupsCometMembersRoot.react",
          "comet.group.members"
        ),
        delete_recent_comments: false,
        delete_recent_invites: false,
        delete_recent_poll_options: false,
        delete_recent_posts: false,
        delete_recent_reactions: false,
        delete_recent_story_threads: false,
        group_id: String(groupID),
        user_id: String(userID)
      },
      inviteShortLinkKey: null,
      memberID: String(userID),
      scale: 1
    };

    postGraphql("useGroupsCometBlockUserMutation", DOC_ID, variables)
      .then(function() {
        callback(null, {
          groupID: String(groupID),
          userID: String(userID),
          blocked: true
        });
      })
      .catch(function(err) {
        log.error("blockGroupMember", err.error || err.message || err);
        callback(err);
      });
  };
};
