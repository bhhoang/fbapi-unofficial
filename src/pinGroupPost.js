"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "28518805054441828";

// Facebook refers to posts in mutations through a `story_id` token that
// embeds the post author's ID: base64("S:_I<authorID>:VK:<postID>").
function storyID(authorID, postID) {
  return Buffer.from("S:_I" + authorID + ":VK:" + postID).toString("base64");
}

function buildPinVariables(postID, options, userID, mutationId) {
  options = options || {};
  var authorID = options.authorID || userID;
  var groupID = options.groupID != null ? options.groupID : options.groupId;

  var variables = {
    input: {
      actor_id: String(userID),
      client_mutation_id: String(mutationId),
      story_id: storyID(authorID, postID)
    },
    highlighted_stories: options.highlightedStories || [],
    privacySelectorRenderLocation: "COMET_STREAM",
    scale: 3,
    referringStoryRenderLocation: null,
    renderLocation: "group",
    useDefaultActor: true
  };
  // The web client sends the group id with the pin ("Pin to Featured").
  if (groupID != null) variables.input.group_id = String(groupID);
  return variables;
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

    var variables = buildPinVariables(postID, options, ctx.userID, ctx.clientMutationId++);

    postGraphql("useGroupMarkPostAsAnnouncementMutation", DOC_ID, variables, {
      // The response embeds unrelated "highlight units" whose
      // if_viewer_can_use_menu_option field currently trips Facebook's
      // field_type_no_match; the web client ignores those and shows the pin
      // as done, so do the same.
      tolerateFieldErrors: true
    })
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
module.exports.buildPinVariables = buildPinVariables;
