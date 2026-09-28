"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "38580553541588665";

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function getPostComments(postID, amount, options, callback) {
    if (!callback) {
      if (typeof amount === "function") {
        callback = amount;
        amount = 10;
        options = {};
      } else if (typeof options === "function") {
        callback = options;
        options = {};
      } else {
        throw { error: "getPostComments: need callback" };
      }
    }
    options = options || {};
    if (typeof amount !== "number" || amount <= 0) amount = 10;

    var variables = {
      commentsAfterCount: amount,
      commentsAfterCursor:
        options.cursor != null ? String(options.cursor) : null,
      commentsBeforeCount: null,
      commentsBeforeCursor: null,
      commentsIntentToken: null,
      feedLocation: options.feedLocation || "GROUP",
      focusCommentID: null,
      id: Buffer.from("feedback:" + postID).toString("base64"),
      scale: 1,
      targetDialect: null,
      useDefaultActor: false
    };

    postGraphql(
      "CommentsListComponentsPaginationQuery",
      DOC_ID,
      variables
    )
      .then(function(objects) {
        var comments = [];
        var seen = {};
        function walk(obj) {
          if (!obj || typeof obj !== "object") return;
          if (Array.isArray(obj)) {
            obj.forEach(walk);
            return;
          }
          if (
            obj.__typename === "Comment" &&
            obj.legacy_fbid &&
            !seen[obj.legacy_fbid]
          ) {
            var id = String(obj.legacy_fbid);
            seen[id] = true;
            var author = obj.author || {};
            var body =
              (obj.preferred_body && obj.preferred_body.text) ||
              (obj.body && obj.body.text) ||
              "";
            var feedback = obj.feedback || {};
            var reactors = feedback.reactors || {};
            var replies = obj.replies_fields || {};
            comments.push({
              commentID: id,
              postID: String(postID),
              senderID: author.id || null,
              senderName: author.name || null,
              body: body,
              timestamp:
                obj.created_time != null ? obj.created_time * 1000 : null,
              reactionCount:
                reactors.count_reduced != null
                  ? Number(reactors.count_reduced)
                  : null,
              replyCount:
                replies.total_count != null ? replies.total_count : null,
              isReply:
                obj.parent_comment && obj.parent_comment.id
                  ? true
                  : false
            });
          }
          Object.keys(obj).forEach(function(key) {
            walk(obj[key]);
          });
        }
        objects.forEach(walk);
        callback(
          null,
          comments,
          relayGraphql.firstPageInfo(objects, null)
        );
      })
      .catch(function(err) {
        log.error("getPostComments", err.error || err.message || err);
        callback(err);
      });
  };
};
