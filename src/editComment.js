"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "38556164660694441";

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function editComment(postID, commentID, message, callback) {
    if (!callback) throw { error: "editComment: need callback" };

    var text =
      typeof message === "string"
        ? message
        : message && message.body
          ? message.body
          : "";
    if (!text) {
      throw { error: "editComment: message must not be empty" };
    }

    var variables = {
      input: {
        actor_id: ctx.userID,
        client_mutation_id: String(ctx.clientMutationId++),
        attachments: null,
        attribution_id_v2: relayGraphql.attributionID(
          "CometGroupDiscussionRoot.react",
          "comet.group"
        ),
        comment_id: Buffer.from(
          "comment:" + postID + "_" + commentID
        ).toString("base64"),
        formatting_style: "PLAIN_TEXT",
        message: { ranges: [], text: text },
        tracking: null
      },
      feedLocation: "GROUP",
      scale: 1,
      useDefaultActor: false,
      translationType: "AUTO_TRANSLATE"
    };

    postGraphql("useCometUFIEditCommentMutation", DOC_ID, variables)
      .then(function() {
        callback(null, {
          postID: String(postID),
          commentID: String(commentID),
          body: text
        });
      })
      .catch(function(err) {
        log.error("editComment", err.error || err.message || err);
        callback(err);
      });
  };
};
