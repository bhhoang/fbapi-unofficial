"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "37309644325300927";

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function createGroup(name, options, callback) {
    if (!callback) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      } else {
        throw { error: "createGroup: need callback" };
      }
    }
    options = options || {};

    if (typeof name !== "string" || name.trim().length === 0) {
      throw { error: "createGroup: name must be a non-empty string" };
    }

    var privacy = options.privacy || "PRIVATE";
    if (privacy !== "PRIVATE" && privacy !== "PUBLIC") {
      throw { error: "createGroup: privacy must be PRIVATE or PUBLIC" };
    }
    var discoverability = options.discoverability || "ANYONE";
    if (discoverability !== "ANYONE" && discoverability !== "MEMBERS_ONLY") {
      throw {
        error: "createGroup: discoverability must be ANYONE or MEMBERS_ONLY"
      };
    }

    var variables = {
      scale: 1,
      input: {
        attribution_id_v2:
          "GroupsCometCreateRoot.react,comet.group.create,via_cold_start," +
          Date.now() +
          "," +
          ((Math.random() * 1000000) | 0) +
          ",,,",
        bulk_invitee_members: [],
        cover_focus: null,
        discoverability: discoverability,
        enable_contextual_actors: false,
        is_forum: false,
        is_purchaser_automatic_membership_approval_enabled: false,
        members: (options.members || []).map(String),
        name: name.trim(),
        privacy: privacy,
        referrer: "AFTER_DIRECT_NAVIGATION_TO_CREATION_SCREEN",
        set_affiliation: false,
        should_invite_followers: false,
        actor_id: ctx.userID,
        client_mutation_id: String(ctx.clientMutationId++)
      }
    };

    postGraphql("useGroupsCometCreateMutation", DOC_ID, variables)
      .then(function(objects) {
        var group = null;
        objects.forEach(function(o) {
          var created =
            o && o.data && o.data.create_group && o.data.create_group.group;
          if (created) group = created;
        });
        if (!group) {
          throw { error: "createGroup: no group in response", res: objects };
        }
        callback(null, {
          groupID: group.id,
          name: group.name || name.trim(),
          url: group.url || "https://www.facebook.com/groups/" + group.id,
          privacy: privacy,
          discoverability: discoverability
        });
      })
      .catch(function(err) {
        log.error("createGroup", err.error || err.message || err);
        callback(err);
      });
  };
};
