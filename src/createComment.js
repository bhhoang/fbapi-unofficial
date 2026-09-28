"use strict";

var utils = require("../utils");
var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "28368856719432906";

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function createComment(postID, message, options, callback) {
    if (!callback) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      } else {
        throw { error: "createComment: need callback" };
      }
    }
    options = options || {};

    var text =
      typeof message === "string"
        ? message
        : message && message.body
          ? message.body
          : "";
    if (!text) {
      throw { error: "createComment: message must not be empty" };
    }

    var isReply = !!options.replyToCommentID;
    var commentFeedbackID = function(id) {
      return Buffer.from("feedback:" + postID + "_" + id).toString("base64");
    };

    var variables = {
      feedLocation: "GROUP",
      feedbackSource: 0,
      groupID: null,
      input: {
        actor_id: ctx.userID,
        client_mutation_id: String(ctx.clientMutationId++),
        attachments: null,
        feedback_id: isReply
          ? commentFeedbackID(options.replyToCommentID)
          : Buffer.from("feedback:" + postID).toString("base64"),
        formatting_style: null,
        is_inline_vote_enabled_for_qna: false,
        message: { ranges: [], text: text },
        attribution_id_v2:
          "CometGroupDiscussionRoot.react,comet.group,via_cold_start," +
          Date.now() +
          "," +
          ((Math.random() * 1000000) | 0) +
          ",2361831622,,",
        vod_video_timestamp: null,
        is_tracking_encrypted: false,
        tracking: null,
        feedback_source: "PROFILE",
        idempotence_token: "client:" + utils.getGUID(),
        session_id: utils.getGUID(),
        reply_comment_parent_fbid: isReply
          ? Buffer.from(
              "comment:" + postID + "_" + options.replyToCommentID
            ).toString("base64")
          : null,
        reply_target_clicked: isReply ? true : null
      },
      inviteShortLinkKey: null,
      renderLocation: null,
      scale: 1,
      useDefaultActor: false,
      focusCommentID: null,
      translationType: "AUTO_TRANSLATE",
      canUseNicknameOnComet: false
    };

    postGraphql("useCometUFICreateCommentMutation", DOC_ID, variables)
      .then(function(objects) {
        var commentID = null;
        objects.forEach(function(o) {
          var created = o && o.data && o.data.comment_create;
          if (!created || commentID) return;
          var comment =
            created.comment ||
            (created.feedback_comment_edge && created.feedback_comment_edge.node);
          if (comment) {
            commentID = comment.legacy_fbid || comment.id || null;
          }
        });
        callback(null, {
          commentID: commentID != null ? String(commentID) : null,
          postID: String(postID),
          body: text
        });
      })
      .catch(function(err) {
        log.error("createComment", err.error || err.message || err);
        callback(err);
      });
  };
};
