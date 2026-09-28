"use strict";

var utils = require("../utils");
var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

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
  // "0" is Facebook's sentinel that removes the current reaction.
  if (reaction == null) return "0";
  var raw = String(reaction);
  var upper = raw.toUpperCase();
  if (reactions[upper]) return reactions[upper];
  if (/^\d+$/.test(raw)) return raw;
  throw { error: "setCommentReaction: unknown reaction " + reaction };
}

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function setCommentReaction(postID, commentID, reaction, callback) {
    if (!callback) throw { error: "setCommentReaction: need callback" };

    var variables = {
      input: {
        attribution_id_v2: relayGraphql.attributionID(
          "CometGroupDiscussionRoot.react",
          "comet.group"
        ),
        feedback_id: Buffer.from(
          "feedback:" + postID + "_" + commentID
        ).toString("base64"),
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
          commentID: String(commentID),
          reaction: reaction == null ? null : String(reaction).toUpperCase()
        });
      })
      .catch(function(err) {
        log.error("setCommentReaction", err.error || err.message || err);
        callback(err);
      });
  };
};
