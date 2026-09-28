"use strict";

var fs = require("fs");
var utils = require("../utils");
var log = require("npmlog");

function formatLocalHistoryMessage(threadID, entry) {
  return {
    type: "message",
    attachments: [],
    body: entry.body || "",
    isGroup: false,
    messageID: entry.messageID,
    senderID: entry.senderID,
    threadID: String(threadID),
    timestamp: entry.timestamp,
    mentions: {},
    isUnread: false,
    messageReactions: null,
    isSponsored: false,
    snippet: entry.body || ""
  };
}

// End-to-end encrypted chats have no server-side plaintext history. When the
// encrypted backup has been restored (see api.restoreE2EEBackup), history is
// fetched from the backup and decrypted; otherwise messages this library sent
// over E2EE from the local device store are used.
function readBackupE2EEHistory(ctx, defaultFuncs, threadID, amount, before, callback) {
  var storePath = ctx.globalOptions.e2eeDevicePath;
  if (!storePath || !fs.existsSync(storePath)) return callback(null, null);
  var data;
  try {
    data = JSON.parse(fs.readFileSync(storePath, "utf8"));
  } catch (e) {
    return callback(null, null);
  }
  var state = data.backup;
  if (
    !state ||
    !state.deviceId ||
    !state.mailboxRootKey ||
    !state.ocmfClientState ||
    !state.epochs ||
    !state.epochs.length
  ) {
    return callback(null, null);
  }

  var backupLib = require("./e2ee/backup");
  var messagesLib = require("./e2ee/messages");
  var epochs = state.epochs.map(function(epoch) {
    return {
      epochId: epoch.epochId,
      epochAnonId: epoch.epochAnonId,
      epochRootKey: Buffer.from(epoch.epochRootKey, "base64")
    };
  });
  var wanted = amount != null ? amount : 50;

  // Some backup stanzas cannot be decrypted by any client (their content was
  // sealed with a live-session key that never reaches the backup, e.g. call
  // event logs). Widen the fetched window when a range contains no usable
  // messages so that usable messages behind such a wall are still returned.
  // Filtering by `before` happens locally: the server-side reference
  // timestamp query is not reliable for backup ranges.
  var MAX_WINDOW = 500;

  function buildMessages(result, metadata) {
    var messages = [];
    result.encrypted_messages.forEach(function(message) {
      var stanzas = message.protobuf_stanzas || {};
      var metadataEntry = metadata[String(message.otid)] || null;
      // The metadata endpoint only exposes sender ids when they are
      // available (admin messages always have null, some regular messages
      // are redacted); fall back to the chat peer for one-to-one threads
      // and to the admin message's actor for events.
      var senderID =
        metadataEntry && metadataEntry.sender_id != null
          ? String(metadataEntry.sender_id)
          : String(threadID);
      if (stanzas.top_level_protobuf) {
        var timestampSource = stanzas.top_level_protobuf;
        var text = null;
        try {
          var plaintext = messagesLib.decryptBackupMessage(message, epochs, String(threadID));
          text = plaintext && messagesLib.extractMessageText(plaintext, String(threadID));
        } catch (decryptError) {
          text = null;
        }
        if (text == null) return;
        messages.push({
          type: "message",
          attachments: [],
          body: text,
          isGroup: false,
          messageID: String(message.otid),
          senderID: senderID,
          threadID: String(threadID),
          timestamp:
            timestampSource.protobuf_timestamp_ms != null
              ? Number(timestampSource.protobuf_timestamp_ms)
              : null,
          mentions: {},
          isUnread: false,
          messageReactions: null,
          isSponsored: false,
          snippet: text
        });
        return;
      }
      if (stanzas.top_level_protobuf_unencrypted) {
        var unencrypted = stanzas.top_level_protobuf_unencrypted;
        var admin = { actorId: null, timestamp: null, text: null };
        try {
          admin = messagesLib.extractAdminMessage(
            Buffer.from(unencrypted.unencrypted_protobuf, "base64")
          );
        } catch (adminError) {
          admin = { actorId: null, timestamp: null, text: null };
        }
        messages.push({
          type: "event",
          messageID: String(message.otid),
          threadID: String(threadID),
          isGroup: false,
          senderID: admin.actorId || senderID,
          timestamp:
            admin.timestamp != null
              ? admin.timestamp
              : unencrypted.protobuf_timestamp_ms != null
                ? Number(unencrypted.protobuf_timestamp_ms)
                : null,
          eventType: "admin_message",
          snippet: admin.text || "",
          eventData: {},
          author: admin.actorId || senderID,
          logMessageType: "other",
          logMessageData: {}
        });
      }
    });
    return messages;
  }

  function fetchWindow(size, widensLeft) {
    var thread = {
      threadId: String(threadID),
      direction: "before",
      numMessages: size
    };

    backupLib.fetchBackupMessageRanges(defaultFuncs, ctx, ctx.jar, {
      threads: [thread],
      deviceId: state.deviceId,
      epochIds: state.epochs.map(function(epoch) {
        return String(epoch.epochId);
      }),
      mailboxRootKey: state.mailboxRootKey,
      ocmfClientState: state.ocmfClientState,
      restoreType: "RANGE_QUERY_RESTORE"
    }, function(fetchError, results) {
      if (fetchError) return callback(fetchError, null);
      var result = results && results[0];
      if (!result || result.exception_string || !(result.encrypted_messages || []).length) {
        return callback(null, null);
      }
      fetchBackupMessageMetadata(defaultFuncs, ctx, threadID, wanted, function(metadata) {
        var messages = buildMessages(result, metadata);
        if (messages.length > 0) {
          if (before != null) {
            messages = messages.filter(function(message) {
              return message.timestamp == null || message.timestamp < before;
            });
          }
          if (messages.length > 0) {
            messages.sort(function(a, b) {
              return (b.timestamp || 0) - (a.timestamp || 0);
            });
            return callback(null, messages.slice(0, wanted));
          }
        }
        var rangeInfo = result.message_range_info;
        var hasMore = rangeInfo && rangeInfo.has_more_before === true;
        if (widensLeft > 0 && hasMore && size < MAX_WINDOW) {
          return fetchWindow(Math.min(size * 2, MAX_WINDOW), widensLeft - 1);
        }
        callback(null, null);
      });
    });
  }

  var initialSize = Math.min(Math.max(wanted, 50), MAX_WINDOW);
  fetchWindow(initialSize, 3);
}

// Per-message metadata (sender ids) for backup messages. The server omits
// sender_id for messages sent by this account, so null means "self".
function fetchBackupMessageMetadata(defaultFuncs, ctx, threadID, amount, callback) {
  defaultFuncs
    .post("https://www.facebook.com/api/graphql/", ctx.jar, {
      doc_id: "28525853583670706",
      variables: JSON.stringify({
        data: {
          act_thread_id: String(threadID),
          direction: "BEFORE",
          include_anonymized_messages: false,
          reference_timestamp: null,
          requested_messages: amount != null ? amount : 50
        }
      }),
      server_timestamps: "true"
    })
    .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
    .then(function(response) {
      var mailbox =
        response &&
        response.data &&
        response.data.viewer &&
        response.data.viewer.encrypted_backup &&
        response.data.viewer.encrypted_backup.mailbox;
      var metadata = {};
      ((mailbox && mailbox.deanon_messages_metadata) || []).forEach(function(entry) {
        metadata[String(entry.offline_threading_id)] = entry;
      });
      callback(metadata);
    })
    .catch(function(error) {
      log.error("getThreadHistoryGraphQL", error);
      callback({});
    });
}

function readLocalE2EEHistory(ctx, threadID, amount, before) {
  var storePath = ctx.globalOptions.e2eeDevicePath;
  if (!storePath || !fs.existsSync(storePath)) return [];
  var data;
  try {
    data = JSON.parse(fs.readFileSync(storePath, "utf8"));
  } catch (e) {
    return [];
  }
  var list = (data.e2ee_history && data.e2ee_history[String(threadID)]) || [];
  var filtered = list.filter(function(entry) {
    return before == null || entry.timestamp < before;
  });
  filtered.sort(function(a, b) {
    return b.timestamp - a.timestamp;
  });
  if (amount != null) filtered = filtered.slice(0, amount);
  return filtered.map(function(entry) {
    return formatLocalHistoryMessage(threadID, entry);
  });
}

function formatAttachmentsGraphQLResponse(attachment) {
  switch (attachment.__typename) {
    case "MessageImage":
      return {
        type: "photo",
        ID: attachment.legacy_attachment_id,
        filename: attachment.filename,
        thumbnailUrl: attachment.thumbnail.uri,

        previewUrl: attachment.preview.uri,
        previewWidth: attachment.preview.width,
        previewHeight: attachment.preview.height,

        largePreviewUrl: attachment.large_preview.uri,
        largePreviewHeight: attachment.large_preview.height,
        largePreviewWidth: attachment.large_preview.width,

        // You have to query for the real image. See below.
        url: attachment.large_preview.uri, // @Legacy
        width: attachment.large_preview.width, // @Legacy
        height: attachment.large_preview.height, // @Legacy
        name: attachment.filename, // @Legacy

        // @Undocumented
        attributionApp: attachment.attribution_app
          ? {
              attributionAppID: attachment.attribution_app.id,
              name: attachment.attribution_app.name,
              logo: attachment.attribution_app.square_logo
            }
          : null

        // @TODO No idea what this is, should we expose it?
        //      Ben - July 15th 2017
        // renderAsSticker: attachment.render_as_sticker,

        // This is _not_ the real URI, this is still just a large preview.
        // To get the URL we'll need to support a POST query to
        //
        //    https://www.facebook.com/webgraphql/query/
        //
        // With the following query params:
        //
        //    query_id:728987990612546
        //    variables:{"id":"100009069356507","photoID":"10213724771692996"}
        //    dpr:1
        //
        // No special form though.
      };
    case "MessageAnimatedImage":
      return {
        type: "animated_image",
        ID: attachment.legacy_attachment_id,
        filename: attachment.filename,

        previewUrl: attachment.preview_image.uri,
        previewWidth: attachment.preview_image.width,
        previewHeight: attachment.preview_image.height,

        url: attachment.animated_image.uri,
        width: attachment.animated_image.width,
        height: attachment.animated_image.height,

        thumbnailUrl: attachment.preview_image.uri, // @Legacy
        name: attachment.filename, // @Legacy
        facebookUrl: attachment.animated_image.uri, // @Legacy
        rawGifImage: attachment.animated_image.uri, // @Legacy
        animatedGifUrl: attachment.animated_image.uri, // @Legacy
        animatedGifPreviewUrl: attachment.preview_image.uri, // @Legacy
        animatedWebpUrl: attachment.animated_image.uri, // @Legacy
        animatedWebpPreviewUrl: attachment.preview_image.uri, // @Legacy

        // @Undocumented
        attributionApp: attachment.attribution_app
          ? {
              attributionAppID: attachment.attribution_app.id,
              name: attachment.attribution_app.name,
              logo: attachment.attribution_app.square_logo
            }
          : null
      };
    case "MessageVideo":
      return {
        type: "video",
        filename: attachment.filename,
        ID: attachment.legacy_attachment_id,

        thumbnailUrl: attachment.large_image.uri, // @Legacy

        previewUrl: attachment.large_image.uri,
        previewWidth: attachment.large_image.width,
        previewHeight: attachment.large_image.height,

        url: attachment.playable_url,
        width: attachment.original_dimensions.x,
        height: attachment.original_dimensions.y,

        duration: attachment.playable_duration_in_ms,
        videoType: attachment.video_type.toLowerCase()
      };
    case "MessageFile":
      return {
        type: "file",
        filename: attachment.filename,
        ID: attachment.message_file_fbid,

        url: attachment.url,
        isMalicious: attachment.is_malicious,
        contentType: attachment.content_type,

        name: attachment.filename, // @Legacy
        mimeType: "", // @Legacy
        fileSize: -1 // @Legacy
      };
    case "MessageAudio":
      return {
        type: "audio",
        filename: attachment.filename,
        ID: attachment.url_shimhash, // Not fowardable

        audioType: attachment.audio_type,
        duration: attachment.playable_duration_in_ms,
        url: attachment.playable_url,

        isVoiceMail: attachment.is_voicemail
      };
    default:
      return {
        error: "Don't know about attachment type " + attachment.__typename
      };
  }
}

function formatExtensibleAttachment(attachment) {
  if (attachment.story_attachment) {
    return {
      type: "share",
      ID: attachment.legacy_attachment_id,
      url: attachment.story_attachment.url,

      title: attachment.story_attachment.title_with_entities.text,
      description:
        attachment.story_attachment.description &&
        attachment.story_attachment.description.text,
      source:
        attachment.story_attachment.source == null
          ? null
          : attachment.story_attachment.source.text,

      image:
        attachment.story_attachment.media == null
          ? null
          : attachment.story_attachment.media.animated_image == null &&
            attachment.story_attachment.media.image == null
            ? null
            : (
                attachment.story_attachment.media.animated_image ||
                attachment.story_attachment.media.image
              ).uri,
      width:
        attachment.story_attachment.media == null
          ? null
          : attachment.story_attachment.media.animated_image == null &&
            attachment.story_attachment.media.image == null
            ? null
            : (
                attachment.story_attachment.media.animated_image ||
                attachment.story_attachment.media.image
              ).width,
      height:
        attachment.story_attachment.media == null
          ? null
          : attachment.story_attachment.media.animated_image == null &&
            attachment.story_attachment.media.image == null
            ? null
            : (
                attachment.story_attachment.media.animated_image ||
                attachment.story_attachment.media.image
              ).height,
      playable:
        attachment.story_attachment.media == null
          ? null
          : attachment.story_attachment.media.is_playable,
      duration:
        attachment.story_attachment.media == null
          ? null
          : attachment.story_attachment.media.playable_duration_in_ms,
      playableUrl:
        attachment.story_attachment.media == null
          ? null
          : attachment.story_attachment.media.playable_url,

      subattachments: attachment.story_attachment.subattachments,

      // Format example:
      //
      //   [{
      //     key: "width",
      //     value: { text: "1280" }
      //   }]
      //
      // That we turn into:
      //
      //   {
      //     width: "1280"
      //   }
      //
      properties: attachment.story_attachment.properties.reduce(function(
        obj,
        cur
      ) {
        obj[cur.key] = cur.value.text;
        return obj;
      },
      {}),

      // Deprecated fields
      animatedImageSize: "", // @Legacy
      facebookUrl: "", // @Legacy
      styleList: "", // @Legacy
      target: "", // @Legacy
      thumbnailUrl:
        attachment.story_attachment.media == null
          ? null
          : attachment.story_attachment.media.animated_image == null &&
            attachment.story_attachment.media.image == null
            ? null
            : (
                attachment.story_attachment.media.animated_image ||
                attachment.story_attachment.media.image
              ).uri, // @Legacy
      thumbnailWidth:
        attachment.story_attachment.media == null
          ? null
          : attachment.story_attachment.media.animated_image == null &&
            attachment.story_attachment.media.image == null
            ? null
            : (
                attachment.story_attachment.media.animated_image ||
                attachment.story_attachment.media.image
              ).width, // @Legacy
      thumbnailHeight:
        attachment.story_attachment.media == null
          ? null
          : attachment.story_attachment.media.animated_image == null &&
            attachment.story_attachment.media.image == null
            ? null
            : (
                attachment.story_attachment.media.animated_image ||
                attachment.story_attachment.media.image
              ).height // @Legacy
    };
  } else {
    return { error: "Don't know what to do with extensible_attachment." };
  }
}

function formatReactionsGraphQL(reaction) {
  return {
    reaction: reaction.reaction,
    userID: reaction.user.id
  };
}

function formatEventData(event) {
  if (event == null) {
    return {};
  }

  switch (event.__typename) {
    case "ThemeColorExtensibleMessageAdminText":
      return {
        color: event.theme_color
      };
    case "ThreadNicknameExtensibleMessageAdminText":
      return {
        nickname: event.nickname,
        participantID: event.participant_id
      };
    case "ThreadIconExtensibleMessageAdminText":
      return {
        threadIcon: event.thread_icon
      };
    case "InstantGameUpdateExtensibleMessageAdminText":
      return {
        gameID: (event.game == null ? null : event.game.id),
        update_type: event.update_type,
        collapsed_text: event.collapsed_text,
        expanded_text: event.expanded_text,
        instant_game_update_data: event.instant_game_update_data
      };
    case "GameScoreExtensibleMessageAdminText":
      return {
        game_type: event.game_type
      };
    case "RtcCallLogExtensibleMessageAdminText":
      return {
        event: event.event,
        is_video_call: event.is_video_call,
        server_info_data: event.server_info_data
      };
    case "GroupPollExtensibleMessageAdminText":
      return {
        event_type: event.event_type,
        total_count: event.total_count,
        question: event.question
      };
    case "AcceptPendingThreadExtensibleMessageAdminText":
      return {
        accepter_id: event.accepter_id,
        requester_id: event.requester_id
      };
    case "ConfirmFriendRequestExtensibleMessageAdminText":
      return {
        friend_request_recipient: event.friend_request_recipient,
        friend_request_sender: event.friend_request_sender
      };
    case "AddContactExtensibleMessageAdminText":
      return {
        contact_added_id: event.contact_added_id,
        contact_adder_id: event.contact_adder_id
      };
    case "AdExtensibleMessageAdminText":
      return {
        ad_client_token: event.ad_client_token,
        ad_id: event.ad_id,
        ad_preferences_link: event.ad_preferences_link,
        ad_properties: event.ad_properties
      };
    // never data
    case "ParticipantJoinedGroupCallExtensibleMessageAdminText":
    case "ThreadEphemeralTtlModeExtensibleMessageAdminText":
    case "StartedSharingVideoExtensibleMessageAdminText":
    case "LightweightEventCreateExtensibleMessageAdminText":
    case "LightweightEventNotifyExtensibleMessageAdminText":
    case "LightweightEventNotifyBeforeEventExtensibleMessageAdminText":
    case "LightweightEventUpdateTitleExtensibleMessageAdminText":
    case "LightweightEventUpdateTimeExtensibleMessageAdminText":
    case "LightweightEventUpdateLocationExtensibleMessageAdminText":
    case "LightweightEventDeleteExtensibleMessageAdminText":
      return {};
    default:
      return {
        error: "Don't know what to with event data type " + event.__typename
      };
  }
}

function formatMessagesGraphQLResponse(data) {
  var messageThread = data.o0.data.message_thread;
  var threadID = messageThread.thread_key.thread_fbid
    ? messageThread.thread_key.thread_fbid
    : messageThread.thread_key.other_user_id;

  var messages = messageThread.messages.nodes.map(function(d) {
    switch (d.__typename) {
      case "UserMessage":
        // Give priority to stickers. They're seen as normal messages but we've
        // been considering them as attachments.
        var maybeStickerAttachment;
        if (d.sticker && d.sticker.pack) {
          maybeStickerAttachment = [
            {
              type: "sticker",
              ID: d.sticker.id,
              url: d.sticker.url,

              packID: d.sticker.pack ? d.sticker.pack.id : null,
              spriteUrl: d.sticker.sprite_image,
              spriteUrl2x: d.sticker.sprite_image_2x,
              width: d.sticker.width,
              height: d.sticker.height,

              caption: d.snippet, // Not sure what the heck caption was.
              description: d.sticker.label, // Not sure about this one either.

              frameCount: d.sticker.frame_count,
              frameRate: d.sticker.frame_rate,
              framesPerRow: d.sticker.frames_per_row,
              framesPerCol: d.sticker.frames_per_col,

              stickerID: d.sticker.id, // @Legacy
              spriteURI: d.sticker.sprite_image, // @Legacy
              spriteURI2x: d.sticker.sprite_image_2x // @Legacy
            }
          ];
        }

        var mentionsObj = {};
        if (d.message !== null) {
          d.message.ranges.forEach(e => {
            mentionsObj[e.entity.id] = d.message.text.substr(e.offset, e.length);
          });
        }

        return {
          type: "message",
          attachments: maybeStickerAttachment
            ? maybeStickerAttachment
            : d.blob_attachments && d.blob_attachments.length > 0
              ? d.blob_attachments.map(formatAttachmentsGraphQLResponse)
              : d.extensible_attachment
                ? [formatExtensibleAttachment(d.extensible_attachment)]
                : [],
          body: d.message !== null ? d.message.text : '',
          isGroup: messageThread.thread_type === "GROUP",
          messageID: d.message_id,
          senderID: d.message_sender.id,
          threadID: threadID,
          timestamp: d.timestamp_precise,

          mentions: mentionsObj,
          isUnread: d.unread,

          // New
          messageReactions: d.message_reactions
            ? d.message_reactions.map(formatReactionsGraphQL)
            : null,
          isSponsored: d.is_sponsored,
          snippet: d.snippet
        };
      case "ThreadNameMessage":
        return {
          type: "event",
          messageID: d.message_id,
          threadID: threadID,
          isGroup: messageThread.thread_type === "GROUP",
          senderID: d.message_sender.id,
          timestamp: d.timestamp_precise,
          eventType: "change_thread_name",
          snippet: d.snippet,
          eventData: {
            threadName: d.thread_name
          },

          // @Legacy
          author: d.message_sender.id,
          logMessageType: "log:thread-name",
          logMessageData: { name: d.thread_name }
        };
      case "ThreadImageMessage":
        return {
          type: "event",
          messageID: d.message_id,
          threadID: threadID,
          isGroup: messageThread.thread_type === "GROUP",
          senderID: d.message_sender.id,
          timestamp: d.timestamp_precise,
          eventType: "change_thread_image",
          snippet: d.snippet,
          eventData:
            d.image_with_metadata == null
              ? {} /* removed image */
              : {
                  /* image added */
                  threadImage: {
                    attachmentID: d.image_with_metadata.legacy_attachment_id,
                    width: d.image_with_metadata.original_dimensions.x,
                    height: d.image_with_metadata.original_dimensions.y,
                    url: d.image_with_metadata.preview.uri
                  }
                },

          // @Legacy
          logMessageType: "log:thread-icon",
          logMessageData: {
            thread_icon: d.image_with_metadata
              ? d.image_with_metadata.preview.uri
              : null
          }
        };
      case "ParticipantLeftMessage":
        return {
          type: "event",
          messageID: d.message_id,
          threadID: threadID,
          isGroup: messageThread.thread_type === "GROUP",
          senderID: d.message_sender.id,
          timestamp: d.timestamp_precise,
          eventType: "remove_participants",
          snippet: d.snippet,
          eventData: {
            // Array of IDs.
            participantsRemoved: d.participants_removed.map(function(p) {
              return p.id;
            })
          },

          // @Legacy
          logMessageType: "log:unsubscribe",
          logMessageData: {
            leftParticipantFbId: d.participants_removed.map(function(p) {
              return p.id;
            })
          }
        };
      case "ParticipantsAddedMessage":
        return {
          type: "event",
          messageID: d.message_id,
          threadID: threadID,
          isGroup: messageThread.thread_type === "GROUP",
          senderID: d.message_sender.id,
          timestamp: d.timestamp_precise,
          eventType: "add_participants",
          snippet: d.snippet,
          eventData: {
            // Array of IDs.
            participantsAdded: d.participants_added.map(function(p) {
              return p.id;
            })
          },

          // @Legacy
          logMessageType: "log:subscribe",
          logMessageData: {
            addedParticipants: d.participants_added.map(function(p) {
              return p.id;
            })
          }
        };
      case "VideoCallMessage":
        return {
          type: "event",
          messageID: d.message_id,
          threadID: threadID,
          isGroup: messageThread.thread_type === "GROUP",
          senderID: d.message_sender.id,
          timestamp: d.timestamp_precise,
          eventType: "video_call",
          snippet: d.snippet,

          // @Legacy
          logMessageType: "other"
        };
      case "VoiceCallMessage":
        return {
          type: "event",
          messageID: d.message_id,
          threadID: threadID,
          isGroup: messageThread.thread_type === "GROUP",
          senderID: d.message_sender.id,
          timestamp: d.timestamp_precise,
          eventType: "voice_call",
          snippet: d.snippet,

          // @Legacy
          logMessageType: "other"
        };
      case "GenericAdminTextMessage":
        return {
          type: "event",
          messageID: d.message_id,
          threadID: threadID,
          isGroup: messageThread.thread_type === "GROUP",
          senderID: d.message_sender.id,
          timestamp: d.timestamp_precise,
          snippet: d.snippet,
          eventType: d.extensible_message_admin_text_type.toLowerCase(),
          eventData: formatEventData(d.extensible_message_admin_text),

          // @Legacy
          logMessageType: utils.getAdminTextMessageType(
            d.extensible_message_admin_text_type
          ),
          logMessageData: d.extensible_message_admin_text // Maybe different?
        };
      default:
        return { error: "Don't know about message type " + d.__typename };
    }
  });
  return messages;
}

module.exports = function(defaultFuncs, api, ctx) {
  return function getThreadHistoryGraphQL(
    threadID,
    amount,
    timestamp,
    callback
  ) {
    if (!callback) {
      throw { error: "getThreadHistoryGraphQL: need callback" };
    }

    // `queries` has to be a string. I couldn't tell from the dev console. This
    // took me a really long time to figure out. I deserve a cookie for this.
    var form = {
      "av": ctx.globalOptions.pageID,
      queries: JSON.stringify({
        o0: {
          // This doc_id was valid on February 2nd 2017.
          doc_id: "1498317363570230",
          query_params: {
            id: threadID,
            message_limit: amount,
            load_messages: 1,
            load_read_receipts: false,
            before: timestamp
          }
        }
      })
    };

    defaultFuncs
      .post("https://www.facebook.com/api/graphqlbatch/", ctx.jar, form)
      .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
      .then(function(resData) {
        if (resData.error) {
          throw resData;
        }
        // This returns us an array of things. The last one is the success /
        // failure one.
        if (
          !Array.isArray(resData) ||
          resData.length === 0 ||
          !resData[resData.length - 1]
        ) {
          throw {
            error: "getThreadHistory: invalid GraphQL response",
            res: resData
          };
        }

        var summary = resData[resData.length - 1];
        if (summary.error_results !== 0) {
          throw {
            error: "getThreadHistory: Facebook returned error_results",
            res: resData
          };
        }
        if (summary.successful_results === 0) {
          throw {
            error: "getThreadHistory: there were no successful_results",
            res: resData
          };
        }

        var data = resData[0] && resData[0].o0 && resData[0].o0.data;
        if (!data || data.message_thread == null) {
          // The thread was not found, or Facebook moved it to end-to-end
          // encryption after which it no longer exposes it through GraphQL.
          return readBackupE2EEHistory(
            ctx,
            defaultFuncs,
            threadID,
            amount,
            timestamp,
            function(backupError, backupMessages) {
              if (backupError) {
                log.error("getThreadHistoryGraphQL", backupError);
              }
              if (backupMessages && backupMessages.length > 0) {
                return callback(null, backupMessages);
              }
              var local = readLocalE2EEHistory(ctx, threadID, amount, timestamp);
              if (local.length > 0) {
                return callback(null, local);
              }
              if (timestamp != null) {
                // Paging past the end of the backup history is not an error.
                return callback(null, []);
              }
              log.error("getThreadHistoryGraphQL", {
                error: "no message_thread in GraphQL response"
              });
              callback({
                error:
                  "getThreadHistory: no message_thread in GraphQL response. " +
                  "The thread does not exist or is end-to-end encrypted, in " +
                  "which case Facebook has no plaintext history for it. " +
                  "Messages sent through this library are cached locally and " +
                  "will appear here."
              });
            }
          );
        }

        callback(null, formatMessagesGraphQLResponse(resData[0]));
      })
      .catch(function(err) {
        log.error("getThreadHistoryGraphQL", err);
        return callback(err);
      });
  };
};
