"use strict";

var utils = require("../utils");
var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "28442649252050710";

function storyID(authorID, postID) {
  return Buffer.from("S:_I" + authorID + ":VK:" + postID).toString("base64");
}

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function editGroupPost(postID, message, options, callback) {
    if (!callback) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      } else {
        throw { error: "editGroupPost: need callback" };
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
      throw { error: "editGroupPost: message must not be empty" };
    }
    var authorID = options.authorID || ctx.userID;

    var variables = {
      input: {
        composer_entry_point: "inline_composer",
        composer_source_surface: "group",
        composer_type: "edit",
        logging: { composer_session_id: utils.getGUID() },
        story_id: storyID(authorID, postID),
        with_tags_ids: [],
        inline_activities: [],
        text_format_preset_id: "0",
        group_flair: { flair_id: null },
        message: { ranges: [], text: text },
        attachments: [],
        composed_text: {
          block_data: ["{}"],
          block_depths: [0],
          block_types: [0],
          blocks: [text],
          entities: ["[]"],
          entity_map: "{}",
          inline_styles: ["[]"]
        },
        editable_post_feature_capabilities: [
          "CONTAINED_LINK",
          "CONTAINED_MEDIA",
          "POLL"
        ],
        actor_id: ctx.userID,
        client_mutation_id: String(ctx.clientMutationId++)
      },
      feedLocation: "GROUP",
      feedbackSource: 1,
      focusCommentID: null,
      scale: 1,
      privacySelectorRenderLocation: "COMET_STREAM",
      referringStoryRenderLocation: null,
      renderLocation: "group",
      useDefaultActor: false,
      isGroupViewerContent: false,
      shouldFetchProDashContentLibraryStory: false,
      isSocialLearning: false,
      isWorkDraftFor: false,
      ppeEnabled: false
    };

    postGraphql("ComposerStoryEditMutation", DOC_ID, variables)
      .then(function() {
        callback(null, { postID: String(postID), body: text });
      })
      .catch(function(err) {
        log.error("editGroupPost", err.error || err.message || err);
        callback(err);
      });
  };
};

module.exports.storyID = storyID;
