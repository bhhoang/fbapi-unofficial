"use strict";

var utils = require("../utils");
var log = require("npmlog");
var bluebird = require("bluebird");
var stream = require("stream");
var path = require("path");
var E2EEClient = require("./e2ee/client").E2EEClient;
var mediaLib = require("./e2ee/media");

// Version of Facebook's LightSpeed client schema, sent with /ls_req requests.
// It only appears in the web client's JS bundles ("LSVersion" module), so it
// is hard-coded; when Facebook bumps it, sends fail with forceWebClientRefresh.
var LS_VERSION_ID = "28546705091657348";

var allowedProperties = {
  attachment: true,
  url: true,
  sticker: true,
  emoji: true,
  emojiSize: true,
  body: true,
  mentions: true,
  filename: true,
  mimeType: true
};

function bufferToStream(buffer) {
  var pass = new stream.PassThrough();
  pass.end(buffer);
  return pass;
}

function readAttachmentBuffer(source) {
  if (Buffer.isBuffer(source)) return bluebird.resolve(source);
  if (!utils.isReadableStream(source)) {
    return bluebird.reject({
      error:
        "Attachment should be a readable stream and not " +
        utils.getType(source) +
        "."
    });
  }
  return new bluebird(function(resolve, reject) {
    var chunks = [];
    source.on("data", function(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    source.on("end", function() {
      resolve(Buffer.concat(chunks));
    });
    source.on("error", reject);
  });
}

module.exports = function(defaultFuncs, api, ctx) {
  function uploadAttachment(attachments, callback) {
    var uploads = [];

    // create an array of promises
    for (var i = 0; i < attachments.length; i++) {
      var item = attachments[i];
      var partOptions = {};
      if (
        item &&
        typeof item === "object" &&
        !Buffer.isBuffer(item) &&
        !utils.isReadableStream(item) &&
        "value" in item
      ) {
        partOptions = item.options || {};
        item = item.value;
      }
      if (!utils.isReadableStream(item)) {
        throw {
          error:
            "Attachment should be a readable stream and not " +
            utils.getType(item) +
            "."
        };
      }

      var form = {
        upload_1024: { value: item, options: partOptions },
        voice_clip: "true"
      };

      uploads.push(
        defaultFuncs
          .postFormData(
            "https://www.facebook.com/ajax/mercury/upload.php",
            ctx.jar,
            form,
            {}
          )
          .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
          .then(function(resData) {
            if (resData.error) {
              throw resData;
            }

            var metadata = resData.payload && resData.payload.metadata;
            var file = metadata && metadata[0];
            if (!file) {
              throw {
                error:
                  "Facebook did not accept the attachment upload. The file " +
                  "may be blocked (e.g. executable/script files) or too large."
              };
            }

            // We have to return the data unformatted unless we want to change it
            // back in sendMessage.
            return file;
          })
      );
    }

    // resolve all promises
    bluebird
      .all(uploads)
      .then(function(resData) {
        callback(null, resData);
      })
      .catch(function(err) {
        log.error("uploadAttachment", err);
        return callback(err);
      });
  }

  function getUrl(url, callback) {
    var form = {
      image_height: 960,
      image_width: 960,
      uri: url
    };

    defaultFuncs
      .post(
        "https://www.facebook.com/message_share_attachment/fromURI/",
        ctx.jar,
        form
      )
      .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
      .then(function(resData) {
        if (resData.error) {
          return callback(resData);
        }

        if (!resData.payload) {
          return callback({ error: "Invalid url" });
        }

        callback(null, resData.payload.share_data.share_params);
      })
      .catch(function(err) {
        log.error("getUrl", err);
        return callback(err);
      });
  }

  function sendContent(form, threadID, isSingleUser, messageAndOTID, callback) {
    // There are three cases here:
    // 1. threadID is of type array, where we're starting a new group chat with users
    //    specified in the array.
    // 2. User is sending a message to a specific user.
    // 3. No additional form params and the message goes to an existing group chat.
    if (utils.getType(threadID) === "Array") {
      for (var i = 0; i < threadID.length; i++) {
        form["specific_to_list[" + i + "]"] = "fbid:" + threadID[i];
      }
      form["specific_to_list[" + threadID.length + "]"] = "fbid:" + ctx.userID;
      form["client_thread_id"] = "root:" + messageAndOTID;
      log.info("sendMessage", "Sending message to multiple users: " + threadID);
    } else {
      // This means that threadID is the id of a user, and the chat
      // is a single person chat
      if (isSingleUser) {
        form["specific_to_list[0]"] = "fbid:" + threadID;
        form["specific_to_list[1]"] = "fbid:" + ctx.userID;
        form["other_user_fbid"] = threadID;
      } else {
        form["thread_fbid"] = threadID;
      }
    }

    if (ctx.globalOptions.pageID) {
      form["author"] = "fbid:" + ctx.globalOptions.pageID;
      form["specific_to_list[1]"] = "fbid:" + ctx.globalOptions.pageID;
      form["creator_info[creatorID]"] = ctx.userID;
      form["creator_info[creatorType]"] = "direct_admin";
      form["creator_info[labelType]"] = "sent_message";
      form["creator_info[pageID]"] = ctx.globalOptions.pageID;
      form["request_user_id"] = ctx.globalOptions.pageID;
      form["creator_info[profileURI]"] =
        "https://www.facebook.com/profile.php?id=" + ctx.userID;
    }

    defaultFuncs
      .post("https://www.facebook.com/messaging/send/", ctx.jar, form)
      .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
      .then(function(resData) {
        if (!resData) {
          return callback({ error: "Send message failed." });
        }

        if (resData.error) {
          if (resData.error === 1545012) {
            log.warn(
              "sendMessage",
              "Got error 1545012. This might mean that you're not part of the conversation " +
                threadID
            );
            if (
              isSingleUser &&
              !ctx.globalOptions.pageID &&
              utils.getType(threadID) !== "Array"
            ) {
              log.info(
                "sendMessage",
                "Retrying thread " +
                  threadID +
                  " as a group chat (15-digit group ids look like user ids)."
              );
              var groupForm = Object.assign({}, form);
              delete groupForm["specific_to_list[0]"];
              delete groupForm["specific_to_list[1]"];
              delete groupForm.other_user_fbid;
              groupForm.thread_fbid = threadID;
              return sendContent(groupForm, threadID, false, messageAndOTID, callback);
            }
          }
          return callback(resData);
        }

        var messageInfo = resData.payload.actions.reduce(function(p, v) {
          return (
            {
              threadID: v.thread_fbid,
              messageID: v.message_id,
              timestamp: v.timestamp
            } || p
          );
        }, null);

        return callback(null, messageInfo);
      })
      .catch(function(err) {
        log.error("sendMessage", err);
        return callback(err);
      });
  }

  // Facebook removed /messaging/send/; the web client now sends messages as
  // "LightSpeed" tasks published to /ls_req over the MQTT connection opened by
  // listenMqtt, and gets the result back on /ls_resp. Only plain text is
  // supported here. One-to-one chats are end-to-end encrypted by default;
  // when Facebook rejects a plaintext send with cutoverHandleInvalidSendToOpen
  // the message is retried through the native E2EE (Signal/Noise) client in
  // src/e2ee, which registers its own E2EE device for the logged-in account.
  function sendViaMqtt(body, threadID, messageAndOTID, callback) {
    var mqttClient = ctx.mqttClient;
    ctx.wsReqNumber = (ctx.wsReqNumber || 0) + 1;
    var requestID = ctx.wsReqNumber;
    threadID = threadID.toString();

    var task = {
      label: "46",
      payload: JSON.stringify({
        thread_id: threadID,
        otid: messageAndOTID,
        source: 0,
        send_type: 1,
        sync_group: 1,
        text: body,
        initiating_source: 1,
        skip_url_preview_gen: 0
      }),
      queue_name: threadID,
      task_id: 0,
      failure_count: null
    };
    var request = {
      app_id: "2220391788200892",
      payload: JSON.stringify({
        tasks: [task],
        epoch_id: utils.generateOfflineThreadingID(),
        version_id: LS_VERSION_ID,
        data_trace_id: null
      }),
      request_id: requestID,
      type: 3
    };

    var timeout = setTimeout(function() {
      finish({ error: "sendMessage: timed out waiting for a response." });
    }, 30000);

    function finish(err, info) {
      clearTimeout(timeout);
      mqttClient.removeListener("message", onMessage);
      callback(err, info);
    }

    function onMessage(topic, message) {
      if (topic !== "/ls_resp") {
        return;
      }
      var res;
      try {
        res = JSON.parse(message);
      } catch (e) {
        return;
      }
      if (res.request_id !== requestID) {
        return;
      }
      var payload = res.payload || "";
      var mid = /"(mid\.\$[^"]+)"/.exec(payload);
      if (payload.indexOf("replaceOptimsiticMessage") > -1 && mid) {
        return finish(null, {
          threadID: threadID,
          messageID: mid[1],
          timestamp: Date.now()
        });
      }
      // Sent when the thread has been moved to end-to-end encryption.
      if (payload.indexOf("cutoverHandleInvalidSendToOpen") > -1) {
        return finish({
          error:
            "sendMessage: this is an end-to-end encrypted chat, which this " +
            "library can't send to.",
          e2eeRequired: true
        });
      }
      if (payload.indexOf("forceWebClientRefresh") > -1) {
        return finish({
          error:
            "sendMessage: Facebook rejected the client version (" +
            LS_VERSION_ID +
            "); LS_VERSION_ID in src/sendMessage.js needs updating."
        });
      }
      finish({ error: "sendMessage: message failed to send.", res: res });
    }

    mqttClient.on("message", onMessage);
    mqttClient.publish(
      "/ls_req",
      JSON.stringify(request),
      { qos: 1, retain: false },
      function(err) {
        if (err) {
          finish({ error: "sendMessage: failed to publish request.", err: err });
        }
      }
    );
  }

  function getE2EEClient() {
    if (!ctx.e2eeClient) {
      ctx.e2eeClient = new E2EEClient(ctx, defaultFuncs);
    }
    return ctx.e2eeClient;
  }

  function sendViaE2EE(body, threadID, callback) {
    var client = getE2EEClient();
    client.sendText(threadID, body, function(err, info) {
      if (err) {
        log.error("sendMessageE2EE", err);
        return callback(err);
      }
      ctx.e2eeThreads = ctx.e2eeThreads || {};
      ctx.e2eeThreads[threadID.toString()] = true;
      callback(null, info);
    });
  }

  function sendViaE2EEAttachment(threadID, prepared, callback) {
    if (!prepared || prepared.buffers.length === 0) {
      return callback({
        error: "sendMessage: no attachment data available for an E2EE send."
      });
    }
    if (prepared.buffers.length > 1) {
      return callback({
        error:
          "sendMessage: E2EE attachments support one attachment per message."
      });
    }
    var attachment = buildE2EEAttachment(
      prepared.msg,
      prepared.sources[0],
      prepared.buffers[0]
    );
    var client = getE2EEClient();
    client.sendAttachment(threadID, attachment, function(err, info) {
      if (err) {
        log.error("sendMessageE2EE", err);
        var message =
          (err && err.message) ||
          (err && err.error) ||
          String(err);
        if (/No E2EE devices found/i.test(String(message))) {
          return callback({
            error:
              "sendMessage: no end-to-end encryption devices were found for " +
              "this chat. Group E2EE threads use sender keys, which this " +
              "library does not implement, and some chats are not E2EE."
          });
        }
        return callback(err);
      }
      ctx.e2eeThreads = ctx.e2eeThreads || {};
      ctx.e2eeThreads[threadID.toString()] = true;
      callback(null, info);
    });
  }

  function isKnownE2EEThread(threadID) {
    if (ctx.e2eeThreads && ctx.e2eeThreads[threadID.toString()]) return true;
    return getE2EEClient().isKnownE2EEThread(threadID);
  }

  function isPlainText(form) {
    return (
      !form.has_attachment &&
      !form.replied_to_message_id &&
      !form["tags[0]"] &&
      form["profile_xmd[0][id]"] === undefined
    );
  }

  function isE2EEAttachment(form) {
    return (
      form.has_attachment &&
      !form.url &&
      !form.sticker &&
      !form.replied_to_message_id &&
      form["tags[0]"] === undefined &&
      form["profile_xmd[0][id]"] === undefined
    );
  }

  function looksLikeE2EEError(err) {
    if (!err) return false;
    var text;
    try {
      text = JSON.stringify(err);
    } catch (e) {
      text = String(err);
    }
    return /cutover|e2ee|end-to-end/i.test(text);
  }

  function looksLikeBlockedError(err) {
    if (!err) return false;
    var text;
    try {
      text = JSON.stringify(err);
    } catch (e) {
      text = String(err);
    }
    return /checkpoint|limit how often|try closing and re-opening|unsupportedbrowser|error":1357004/i.test(
      text
    );
  }

  function describeError(err) {
    if (err == null) return "unknown error";
    if (typeof err === "string") return err;
    if (err.message) return err.message;
    if (err.error) {
      return typeof err.error === "string" ? err.error : JSON.stringify(err.error);
    }
    try {
      return JSON.stringify(err);
    } catch (e) {
      return String(err);
    }
  }

  function buildE2EEAttachment(msg, source, buffer) {
    var sourceMime = source && typeof source.mimeType === "string" ? source.mimeType : null;
    var mimeType = msg.mimeType || sourceMime || mediaLib.sniffMimeType(buffer) || "";
    var classified = mediaLib.classifyMedia(mimeType);
    var filename = msg.filename || null;
    if (!filename && source && typeof source.path === "string") {
      filename = path.basename(source.path);
    }
    if (!filename && classified.kind === "document") filename = "document";
    return {
      buffer: buffer,
      kind: classified.kind,
      serverMediaType: classified.serverMediaType,
      mimetype: classified.mimetype,
      filename: filename,
      caption: msg.body != null && msg.body !== "" ? String(msg.body) : null
    };
  }

  function send(form, threadID, messageAndOTID, callback) {
    if (
      utils.getType(threadID) !== "Array" &&
      !ctx.globalOptions.pageID &&
      isPlainText(form)
    ) {
      if (isKnownE2EEThread(threadID)) {
        return sendViaE2EE(form.body, threadID, callback);
      }
      if (ctx.mqttClient && ctx.mqttClient.connected) {
        return sendViaMqtt(form.body, threadID, messageAndOTID, function(err, info) {
          if (err && err.e2eeRequired) {
            return sendViaE2EE(form.body, threadID, callback);
          }
          callback(err, info);
        });
      }
      log.warn(
        "sendMessage",
        "No listenMqtt connection; falling back to the legacy send endpoint, " +
          "which Facebook has removed. Call api.listenMqtt() first."
      );
    }

    // We're doing a query to this to check if the given id is the id of
    // a user or of a group chat. The form will be different depending
    // on that.
    if (utils.getType(threadID) === "Array") {
      sendContent(form, threadID, false, messageAndOTID, callback);
    } else {
      sendContent(
        form,
        threadID,
        threadID.length === 15,
        messageAndOTID,
        callback
      );
    }
  }

  function handleUrl(msg, form, callback, cb) {
    if (msg.url) {
      form["shareable_attachment[share_type]"] = "100";
      getUrl(msg.url, function(err, params) {
        if (err) {
          return callback(err);
        }

        form["shareable_attachment[share_params]"] = params;
        cb();
      });
    } else {
      cb();
    }
  }

  function handleSticker(msg, form, callback, cb) {
    if (msg.sticker) {
      form["sticker_id"] = msg.sticker;
    }
    cb();
  }

  function handleEmoji(msg, form, callback, cb) {
    if (msg.emojiSize != null && msg.emoji == null) {
      return callback({ error: "emoji property is empty" });
    }
    if (msg.emoji) {
      if (msg.emojiSize == null) {
        msg.emojiSize = "medium";
      }
      if (
        msg.emojiSize != "small" &&
        msg.emojiSize != "medium" &&
        msg.emojiSize != "large"
      ) {
        return callback({ error: "emojiSize property is invalid" });
      }
      if (form["body"] != null && form["body"] != "") {
        return callback({ error: "body is not empty" });
      }
      form["body"] = msg.emoji;
      form["tags[0]"] = "hot_emoji_size:" + msg.emojiSize;
    }
    cb();
  }

  function handleAttachment(msg, form, callback, cb, prepared) {
    if (msg.attachment) {
      form["image_ids"] = [];
      form["gif_ids"] = [];
      form["file_ids"] = [];
      form["video_ids"] = [];
      form["audio_ids"] = [];

      var attachments = msg.attachment;
      if (utils.getType(attachments) !== "Array") {
        attachments = [attachments];
      }
      if (prepared) {
        attachments = prepared.buffers.map(function(buffer, i) {
          var source = prepared.sources[i];
          var mimeType =
            msg.mimeType ||
            (source && typeof source.mimeType === "string" ? source.mimeType : null) ||
            mediaLib.sniffMimeType(buffer) ||
            "application/octet-stream";
          var filename = msg.filename || null;
          if (!filename && source && typeof source.path === "string") {
            filename = path.basename(source.path);
          }
          if (!filename) filename = "upload" + mediaLib.mimeExtension(mimeType);
          return {
            value: bufferToStream(buffer),
            options: { filename: filename, contentType: mimeType }
          };
        });
      }

      uploadAttachment(attachments, function(err, files) {
        if (err) {
          return callback(err);
        }

        files.forEach(function(file) {
          var key = Object.keys(file);
          var type = key[0]; // image_id, file_id, etc
          form["" + type + "s"].push(file[type]); // push the id
        });
        cb();
      });
    } else {
      cb();
    }
  }

  function handleMention(msg, form, callback, cb) {
    if (msg.mentions) {
      for (let i = 0; i < msg.mentions.length; i++) {
        const mention = msg.mentions[i];

        const tag = mention.tag;
        if (typeof tag !== "string") {
          return callback({ error: "Mention tags must be strings." });
        }

        const offset = msg.body.indexOf(tag, mention.fromIndex || 0);

        if (offset < 0) {
          log.warn(
            "handleMention",
            'Mention for "' + tag + '" not found in message string.'
          );
        }

        if (mention.id == null) {
          log.warn("handleMention", "Mention id should be non-null.");
        }

        const id = mention.id || 0;
        form["profile_xmd[" + i + "][offset]"] = offset;
        form["profile_xmd[" + i + "][length]"] = tag.length;
        form["profile_xmd[" + i + "][id]"] = id;
        form["profile_xmd[" + i + "][type]"] = "p";
      }
    }
    cb();
  }

  return function sendMessage(msg, threadID, callback, replyToMessage) {
    if (
      !callback &&
      (utils.getType(threadID) === "Function" ||
        utils.getType(threadID) === "AsyncFunction")
    ) {
      return callback({ error: "Pass a threadID as a second argument." });
    }
    if (
      !replyToMessage &&
      utils.getType(callback) === "String"
    ) {
      replyToMessage = callback;
      callback = function() {};
    }
      
    if (!callback) {
      callback = function() {};
    }

    var msgType = utils.getType(msg);
    var threadIDType = utils.getType(threadID);
    var messageIDType = utils.getType(replyToMessage);

    if (msgType !== "String" && msgType !== "Object") {
      return callback({
        error:
          "Message should be of type string or object and not " + msgType + "."
      });
    }

    // Changing this to accomodate an array of users
    if (
      threadIDType !== "Array" &&
      threadIDType !== "Number" &&
      threadIDType !== "String"
    ) {
      return callback({
        error:
          "ThreadID should be of type number, string, or array and not " +
          threadIDType +
          "."
      });
    }
    
    if (replyToMessage && messageIDType !== 'String') {
      return callback({
        error:
          "MessageID should be of type string and not " +
          threadIDType +
          "."
      });
    }

    if (msgType === "String") {
      msg = { body: msg };
    }

    var disallowedProperties = Object.keys(msg).filter(
      prop => !allowedProperties[prop]
    );
    if (disallowedProperties.length > 0) {
      return callback({
        error: "Dissallowed props: `" + disallowedProperties.join(", ") + "`"
      });
    }

    var messageAndOTID = utils.generateOfflineThreadingID();

    var form = {
      client: "mercury",
      action_type: "ma-type:user-generated-message",
      author: "fbid:" + ctx.userID,
      timestamp: Date.now(),
      timestamp_absolute: "Today",
      timestamp_relative: utils.generateTimestampRelative(),
      timestamp_time_passed: "0",
      is_unread: false,
      is_cleared: false,
      is_forward: false,
      is_filtered_content: false,
      is_filtered_content_bh: false,
      is_filtered_content_account: false,
      is_filtered_content_quasar: false,
      is_filtered_content_invalid_app: false,
      is_spoof_warning: false,
      source: "source:chat:web",
      "source_tags[0]": "source:chat",
      body: msg.body ? msg.body.toString() : "",
      html_body: false,
      ui_push_phase: "V3",
      status: "0",
      offline_threading_id: messageAndOTID,
      message_id: messageAndOTID,
      threading_id: utils.generateThreadingID(ctx.clientID),
      "ephemeral_ttl_mode:": "0",
      manual_retry_cnt: "0",
      has_attachment: !!(msg.attachment || msg.url || msg.sticker),
      signatureID: utils.getSignatureID(),
      replied_to_message_id: replyToMessage
    };

    var canPrepareAttachment =
      !!msg.attachment &&
      !msg.url &&
      !msg.sticker &&
      threadIDType !== "Array" &&
      !ctx.globalOptions.pageID;

    function proceed(prepared, cb) {
      handleSticker(msg, form, cb, () =>
        handleAttachment(
          msg,
          form,
          cb,
          () =>
            handleUrl(msg, form, cb, () =>
              handleEmoji(msg, form, cb, () =>
                handleMention(msg, form, cb, () =>
                  send(form, threadID, messageAndOTID, cb)
                )
              )
            ),
          prepared
        )
      );
    }

    if (!canPrepareAttachment) {
      return proceed(null, callback);
    }

    var attachmentSources =
      utils.getType(msg.attachment) === "Array"
        ? msg.attachment
        : [msg.attachment];

    bluebird
      .all(attachmentSources.map(readAttachmentBuffer))
      .then(function(buffers) {
        var prepared = { msg: msg, sources: attachmentSources, buffers: buffers };
        var e2eeEligible =
          threadIDType !== "Array" &&
          !ctx.globalOptions.pageID &&
          !msg.url &&
          !msg.sticker &&
          !replyToMessage &&
          !msg.mentions &&
          isE2EEAttachment(form);
        if (!e2eeEligible) {
          return proceed(prepared, callback);
        }
        if (isKnownE2EEThread(threadID)) {
          return sendViaE2EEAttachment(threadID, prepared, callback);
        }
        var retried = false;
        proceed(prepared, function(err, info) {
          if (retried || info || !err) return callback(err, info);
          retried = true;
          if (looksLikeBlockedError(err)) {
            log.warn(
              "sendMessage",
              "Facebook refused the plaintext attachment send (checkpoint or " +
                "rate limit); not retrying over E2EE."
            );
            return callback(err);
          }
          log.warn(
            "sendMessage",
            "Plaintext attachment send failed" +
              (looksLikeE2EEError(err)
                ? " (end-to-end encrypted thread)"
                : "") +
              "; retrying through the E2EE client."
          );
          sendViaE2EEAttachment(threadID, prepared, function(e2eeErr, e2eeInfo) {
            if (!e2eeErr) return callback(null, e2eeInfo);
            callback({
              error:
                "sendMessage: attachment send failed. Plaintext: " +
                describeError(err) +
                ". E2EE fallback: " +
                describeError(e2eeErr) +
                ". Non-E2EE group threads need the plaintext path; group " +
                "E2EE (sender keys) is not implemented.",
              plaintextError: err,
              e2eeError: e2eeErr
            });
          });
        });
      })
      .catch(function(err) {
        log.error("sendMessage", err);
        callback(err);
      });
  };
};
