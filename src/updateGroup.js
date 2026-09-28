"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "27527523563552571";

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function updateGroup(groupID, settings, callback) {
    if (!callback) throw { error: "updateGroup: need callback" };
    settings = settings || {};

    if (settings.name == null && settings.description == null) {
      throw {
        error: "updateGroup: pass a name and/or description to update"
      };
    }

    var variables = {
      input: {
        description:
          settings.description != null ? String(settings.description) : null,
        group_id: String(groupID),
        name: settings.name != null ? String(settings.name) : null,
        actor_id: ctx.userID,
        client_mutation_id: String(ctx.clientMutationId++)
      },
      scale: 1
    };

    postGraphql(
      "useGroupEditNameAndDescriptionSettingMutation",
      DOC_ID,
      variables
    )
      .then(function() {
        callback(null, {
          groupID: String(groupID),
          name: settings.name != null ? String(settings.name) : null,
          description:
            settings.description != null
              ? String(settings.description)
              : null
        });
      })
      .catch(function(err) {
        log.error("updateGroup", err.error || err.message || err);
        callback(err);
      });
  };
};
