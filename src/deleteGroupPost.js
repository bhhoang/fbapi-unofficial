"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "27542772888736782";

function storyID(authorID, postID) {
  return Buffer.from("S:_I" + authorID + ":VK:" + postID).toString("base64");
}

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function deleteGroupPost(postID, options, callback) {
    if (!callback) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      } else {
        throw { error: "deleteGroupPost: need callback" };
      }
    }
    options = options || {};
    var authorID = options.authorID || ctx.userID;

    var variables = {
      input: {
        story_id: storyID(authorID, postID),
        story_location: "PERMALINK",
        actor_id: ctx.userID,
        client_mutation_id: String(ctx.clientMutationId++)
      },
      groupID: null,
      inviteShortLinkKey: null,
      renderLocation: null,
      scale: 1
    };

    postGraphql("useCometFeedStoryDeleteMutation", DOC_ID, variables)
      .then(function() {
        callback(null, { postID: String(postID), deleted: true });
      })
      .catch(function(err) {
        log.error("deleteGroupPost", err.error || err.message || err);
        callback(err);
      });
  };
};

module.exports.storyID = storyID;
