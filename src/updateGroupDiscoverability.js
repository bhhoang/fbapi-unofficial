"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "38370252545952935";

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function updateGroupDiscoverability(
    groupID,
    discoverability,
    callback
  ) {
    if (!callback) {
      throw { error: "updateGroupDiscoverability: need callback" };
    }

    var value = String(discoverability || "").toUpperCase();
    if (value !== "ANYONE" && value !== "MEMBERS_ONLY") {
      throw {
        error:
          "updateGroupDiscoverability: discoverability must be ANYONE or MEMBERS_ONLY"
      };
    }

    var variables = {
      input: {
        actor_id: ctx.userID,
        client_mutation_id: String(ctx.clientMutationId++),
        discoverability: value,
        group_id: String(groupID)
      },
      scale: 1
    };

    postGraphql(
      "useGroupEditDiscoverabilitySettingMutation",
      DOC_ID,
      variables
    )
      .then(function() {
        callback(null, {
          groupID: String(groupID),
          discoverability: value
        });
      })
      .catch(function(err) {
        log.error(
          "updateGroupDiscoverability",
          err.error || err.message || err
        );
        callback(err);
      });
  };
};
