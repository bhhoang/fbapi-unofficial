"use strict";

var utils = require("../utils");
var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "28610721578594644";

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

  return function getFeed(amount, options, callback) {
    if (!callback) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      } else if (typeof amount === "function") {
        callback = amount;
        options = {};
        amount = 5;
      } else {
        throw { error: "getFeed: need callback" };
      }
    }
    options = options || {};
    if (typeof amount !== "number" || amount <= 0) amount = 5;

    var variables = {
      RELAY_INCREMENTAL_DELIVERY: true,
      clientQueryId: utils.getGUID(),
      clientSession: null,
      connectionClass: "EXCELLENT",
      count: amount,
      cursor: options.cursor != null ? String(options.cursor) : null,
      experimentalValues: null,
      feedLocation: "NEWSFEED",
      feedStyle: "DEFAULT",
      feedbackSource: 1,
      focusCommentID: null,
      orderby: ["TOP_STORIES"],
      privacySelectorRenderLocation: "COMET_STREAM",
      recentVPVs: [],
      referringStoryRenderLocation: null,
      refreshMode: "AUTO",
      renderLocation: "homepage_stream",
      scale: 1,
      shouldChangeBRSLabelFieldName: false,
      shouldObfuscateCategoryField: true,
      shouldUseBRSLabelFieldNameV1: false,
      shouldUseBRSLabelFieldNameV2: false,
      useDefaultActor: false
    };

    postGraphql("CometNewsFeedPaginationQuery", DOC_ID, variables)
      .then(function(objects) {
        callback(
          null,
          relayGraphql.collectFeedStories(objects).map(formatPost),
          relayGraphql.firstPageInfo(objects, "news_feed")
        );
      })
      .catch(function(err) {
        log.error("getFeed", err.error || err.message || err);
        callback(err);
      });
  };
};
