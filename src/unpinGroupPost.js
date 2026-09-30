"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "28404832819170109";

function storyID(authorID, postID) {
  return Buffer.from("S:_I" + authorID + ":VK:" + postID).toString("base64");
}

function buildUnpinVariables(postID, options, userID, mutationId) {
  options = options || {};
  var authorID = options.authorID || userID;

  return {
    input: {
      actor_id: String(userID),
      client_mutation_id: String(mutationId),
      story_id: storyID(authorID, postID)
    },
    feedLocation: "GROUP",
    feedbackSource: 0,
    focusCommentID: null,
    scale: 3,
    useDefaultActor: false,
    privacySelectorRenderLocation: "COMET_STREAM",
    referringStoryRenderLocation: null,
    renderLocation: "group"
  };
}

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function unpinGroupPost(postID, options, callback) {
    if (!callback) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      } else {
        throw { error: "unpinGroupPost: need callback" };
      }
    }
    options = options || {};

    var variables = buildUnpinVariables(postID, options, ctx.userID, ctx.clientMutationId++);

    postGraphql("useGroupRemovePostFromAnnouncementsMutation", DOC_ID, variables)
      .then(function() {
        callback(null, { postID: String(postID), pinned: false });
      })
      .catch(function(err) {
        log.error("unpinGroupPost", err.error || err.message || err);
        callback(err);
      });
  };
};

module.exports.storyID = storyID;
module.exports.buildUnpinVariables = buildUnpinVariables;
