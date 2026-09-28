"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "10033608630016847";

// Facebook refers to posts in mutations through a `story_id` token that
// embeds the post author's ID: base64("S:_I<authorID>:VK:<postID>").
function storyID(authorID, postID) {
  return Buffer.from("S:_I" + authorID + ":VK:" + postID).toString("base64");
}

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function pinGroupPost(postID, options, callback) {
    if (!callback) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      } else {
        throw { error: "pinGroupPost: need callback" };
      }
    }
    options = options || {};
    var authorID = options.authorID || ctx.userID;

    var variables = {
      input: {
        actor_id: ctx.userID,
        client_mutation_id: String(ctx.clientMutationId++),
        story_id: storyID(authorID, postID)
      }
    };

    postGraphql("useGroupPinAnnouncementStoryMutation", DOC_ID, variables)
      .then(function() {
        callback(null, { postID: String(postID), pinned: true });
      })
      .catch(function(err) {
        log.error("pinGroupPost", err.error || err.message || err);
        callback(err);
      });
  };
};

module.exports.storyID = storyID;
