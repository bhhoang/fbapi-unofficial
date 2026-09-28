"use strict";

var utils = require("../utils");
var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "28816591454626019";

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function searchGroupPosts(groupID, query, amount, callback) {
    if (!callback) {
      if (typeof amount === "function") {
        callback = amount;
        amount = 5;
      } else {
        throw { error: "searchGroupPosts: need callback" };
      }
    }
    if (typeof amount !== "number" || amount <= 0) amount = 5;

    var variables = {
      count: amount,
      allow_streaming: false,
      args: {
        callsite: "comet:scoped:group",
        config: {
          exact_match: false,
          high_confidence_config: null,
          intercept_config: null,
          sts_disambiguation: null,
          watch_config: null
        },
        context: { bsid: utils.getGUID(), tsid: null },
        experience: {
          client_defined_experiences: ["ADS_PARALLEL_FETCH"],
          encoded_server_defined_params: null,
          fbid: String(groupID),
          type: "GROUPS_SCOPED"
        },
        filters: [],
        text: String(query || "")
      },
      cursor: null,
      feedbackSource: 23,
      fetch_filters: true,
      renderLocation: "group_serp",
      scale: 1,
      stream_initial_count: 0,
      useDefaultActor: false
    };

    postGraphql(
      "SearchCometResultsInitialResultsQuery",
      DOC_ID,
      variables
    )
      .then(function(objects) {
        var posts = relayGraphql.collectFeedStories(objects).map(function(story) {
          var actor = (story.actors && story.actors[0]) || {};
          var message = relayGraphql.findByKey(story, "message");
          var creationTime = relayGraphql.findByKey(story, "creation_time");
          var url = relayGraphql.findByKey(story, "wwwURL");
          return {
            postID: story.post_id,
            senderID: actor.id || null,
            senderName: actor.name || null,
            body: (message && message.text) || "",
            timestamp: creationTime != null ? creationTime * 1000 : null,
            url: url || null
          };
        });
        callback(null, posts);
      })
      .catch(function(err) {
        log.error("searchGroupPosts", err.error || err.message || err);
        callback(err);
      });
  };
};
