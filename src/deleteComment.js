"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "27386493047638332";

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function deleteComment(postID, commentID, callback) {
    if (!callback) throw { error: "deleteComment: need callback" };

    var variables = {
      groupID: null,
      input: {
        actor_id: ctx.userID,
        client_mutation_id: String(ctx.clientMutationId++),
        attribution_id_v2: relayGraphql.attributionID(
          "CometGroupDiscussionRoot.react",
          "comet.group"
        ),
        comment_id: Buffer.from(
          "comment:" + postID + "_" + commentID
        ).toString("base64"),
        remove_location: "MENU",
        tracking: null
      },
      inviteShortLinkKey: null,
      renderLocation: null,
      scale: 1,
      canUseNicknameOnComet: false
    };

    postGraphql("useCometUFIDeleteCommentMutation", DOC_ID, variables)
      .then(function() {
        callback(null, {
          postID: String(postID),
          commentID: String(commentID),
          deleted: true
        });
      })
      .catch(function(err) {
        log.error("deleteComment", err.error || err.message || err);
        callback(err);
      });
  };
};
