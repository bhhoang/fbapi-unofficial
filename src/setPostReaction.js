"use strict";

var utils = require("../utils");
var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

// Facebook's `feedback_reaction_id` values. Pass one of the names below (or
// the raw id) as `reaction` to react, or null to remove the current reaction.
var reactions = {
  LIKE: "1635855486666999",
  LOVE: "1678524932434102",
  HAHA: "115940658764963",
  WOW: "478547315650144",
  SAD: "908563459236466",
  ANGRY: "444813342392137",
  CARE: "613557422527858"
};

var DOC_ID = "27646120298312844";

function resolveReaction(reaction) {
  // Facebook's web client uses "0" as the sentinel that removes the current
  // reaction from a post.
  if (reaction == null) return "0";
  var raw = String(reaction);
  var upper = raw.toUpperCase();
  if (reactions[upper]) return reactions[upper];
  if (/^\d+$/.test(raw)) return raw;
  throw { error: "setPostReaction: unknown reaction " + reaction };
}

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function setPostReaction(postID, reaction, callback) {
    if (!callback) throw { error: "setPostReaction: need callback" };

    var variables = {
      input: {
        attribution_id_v2:
          "CometGroupDiscussionRoot.react,comet.group,via_cold_start," +
          Date.now() +
          "," +
          ((Math.random() * 1000000) | 0) +
          ",2361831622,,",
        feedback_id: Buffer.from("feedback:" + postID).toString("base64"),
        feedback_reaction_id: resolveReaction(reaction),
        feedback_source: "PROFILE",
        is_tracking_encrypted: false,
        tracking: null,
        session_id: utils.getGUID(),
        actor_id: ctx.userID,
        client_mutation_id: String(ctx.clientMutationId++)
      },
      scale: 1,
      canUseNicknameOnComet: false,
      useDefaultActor: false
    };

    postGraphql("CometUFIFeedbackReactMutation", DOC_ID, variables)
      .then(function() {
        callback(null, {
          postID: String(postID),
          reaction:
            reaction == null ? null : String(reaction).toUpperCase()
        });
      })
      .catch(function(err) {
        log.error("setPostReaction", err.error || err.message || err);
        callback(err);
      });
  };
};
