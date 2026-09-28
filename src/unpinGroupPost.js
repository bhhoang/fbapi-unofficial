"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "9573242819419742";

function storyID(authorID, postID) {
  return Buffer.from("S:_I" + authorID + ":VK:" + postID).toString("base64");
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
    var authorID = options.authorID || ctx.userID;

    var variables = {
      input: {
        actor_id: ctx.userID,
        client_mutation_id: String(ctx.clientMutationId++),
        story_id: storyID(authorID, postID)
      }
    };

    postGraphql("useGroupUnpinAnnouncementStoryMutation", DOC_ID, variables)
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
