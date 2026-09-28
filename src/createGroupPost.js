"use strict";

var utils = require("../utils");
var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "28480720511586210";

function attributionID(entryPoint) {
  return (
    entryPoint +
    ",comet.group,via_cold_start," +
    Date.now() +
    "," +
    ((Math.random() * 1000000) | 0) +
    ",2361831622,,"
  );
}

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function createGroupPost(groupID, message, callback) {
    if (!callback) throw { error: "createGroupPost: need callback" };

    var text =
      typeof message === "string"
        ? message
        : message && message.body
          ? message.body
          : "";
    if (!text) {
      throw { error: "createGroupPost: message must not be empty" };
    }

    var variables = {
      input: {
        composer_entry_point: "inline_composer",
        composer_source_surface: "group",
        composer_type: "group",
        logging: { composer_session_id: utils.getGUID() },
        source: "WWW",
        message: { ranges: [], text: text },
        with_tags_ids: null,
        inline_activities: [],
        text_format_preset_id: "0",
        group_flair: { flair_id: null },
        composed_text: {
          block_data: ["{}"],
          block_depths: [0],
          block_types: [0],
          blocks: [text],
          entities: ["[]"],
          entity_map: "{}",
          inline_styles: ["[]"]
        },
        navigation_data: {
          attribution_id_v2: attributionID("CometGroupDiscussionRoot.react")
        },
        tracking: [null],
        event_share_metadata: { surface: "newsfeed" },
        audience: { to_id: String(groupID) },
        actor_id: ctx.userID,
        client_mutation_id: String(ctx.clientMutationId++)
      },
      feedLocation: "GROUP",
      feedbackSource: 0,
      focusCommentID: null,
      gridMediaWidth: null,
      groupID: null,
      scale: 1,
      privacySelectorRenderLocation: "COMET_STREAM",
      checkPhotosToReelsUpsellEligibility: false,
      referringStoryRenderLocation: null,
      renderLocation: "group",
      useDefaultActor: false,
      inviteShortLinkKey: null,
      isFeed: false,
      isFundraiser: false,
      isFunFactPost: false,
      isGroup: true,
      isEvent: false,
      isTimeline: false,
      isSocialLearning: false,
      isPageNewsFeed: false,
      isProfileReviews: false,
      isWorkSharedDraft: false
    };

    postGraphql("ComposerStoryCreateMutation", DOC_ID, variables)
      .then(function(objects) {
        var postID = null;
        var url = null;
        objects.forEach(function(o) {
          var storyCreate = o && o.data && o.data.story_create;
          if (!storyCreate) return;
          var story = storyCreate.story || {};
          var id =
            storyCreate.post_id || story.legacy_story_hideable_id || null;
          if (!id && story.url) {
            var match = /\/permalink\/(\d+)/.exec(story.url);
            if (match) id = match[1];
          }
          if (id && !postID) {
            postID = String(id);
            url = story.url || null;
          }
        });
        callback(null, {
          postID: postID,
          groupID: String(groupID),
          body: text,
          url: url
        });
      })
      .catch(function(err) {
        log.error("createGroupPost", err.error || err.message || err);
        callback(err);
      });
  };
};
