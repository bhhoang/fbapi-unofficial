"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "28777159338592000";

function formatPost(story) {
  var actor = (story.actors && story.actors[0]) || {};
  var message = relayGraphql.findByKey(story, "message");
  var creationTime = relayGraphql.findByKey(story, "creation_time");
  var url = relayGraphql.findByKey(story, "wwwURL");
  var reactions = relayGraphql.findByKey(story, "reaction_count");
  var comments = relayGraphql.findByKey(story, "total_comment_count");
  var shares = relayGraphql.findByKey(story, "share_count");

  return {
    type: "post",
    postID: story.post_id,
    groupID: story.to && story.to.id ? story.to.id : null,
    senderID: actor.id || null,
    senderName: actor.name || null,
    body: (message && message.text) || "",
    timestamp: creationTime != null ? creationTime * 1000 : null,
    url: url || null,
    reactionCount:
      reactions && reactions.count != null ? reactions.count : null,
    commentCount: comments != null ? comments : null,
    shareCount: shares && shares.count != null ? shares.count : null
  };
}

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function getGroupPosts(groupID, amount, options, callback) {
    if (!callback) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      } else if (typeof amount === "function") {
        callback = amount;
        options = {};
        amount = 10;
      } else {
        throw { error: "getGroupPosts: need callback" };
      }
    }
    options = options || {};
    if (typeof amount !== "number" || amount <= 0) amount = 10;

    var variables = {
      count: amount,
      cursor: options.cursor != null ? String(options.cursor) : null,
      feedLocation: "GROUP",
      feedType: "DISCUSSION",
      feedbackSource: 0,
      filterTopicId: null,
      focusCommentID: null,
      id: String(groupID),
      privacySelectorRenderLocation: "COMET_STREAM",
      referringStoryRenderLocation: null,
      renderLocation: "group",
      scale: 1,
      sortingSetting: options.sortingSetting || "CHRONOLOGICAL",
      stream_initial_count: 1,
      useDefaultActor: false,
      youthIntegrityHostID: null
    };

    postGraphql(
      "GroupsCometFeedRegularStoriesPaginationQuery",
      DOC_ID,
      variables
    )
      .then(function(objects) {
        callback(
          null,
          relayGraphql.collectFeedStories(objects).map(formatPost),
          relayGraphql.firstPageInfo(objects, "group_feed")
        );
      })
      .catch(function(err) {
        log.error("getGroupPosts", err.error || err.message || err);
        callback(err);
      });
  };
};
