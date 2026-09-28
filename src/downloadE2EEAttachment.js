"use strict";

var log = require("npmlog");
var E2EEClient = require("./e2ee/client").E2EEClient;

module.exports = function(defaultFuncs, api, ctx) {
  return function downloadE2EEAttachment(attachment, callback) {
    if (!callback) {
      callback = function() {};
    }
    if (!attachment || typeof attachment !== "object") {
      return callback({
        error: "downloadE2EEAttachment: pass an attachment object."
      });
    }
    if (!attachment.e2ee) {
      return callback({
        error:
          "downloadE2EEAttachment: the attachment has no `e2ee` media " +
          "metadata. This only works for attachments received from " +
          "listenMqtt on an end-to-end encrypted one-to-one chat."
      });
    }
    if (!ctx.e2eeClient) {
      ctx.e2eeClient = new E2EEClient(ctx, defaultFuncs);
    }
    ctx.e2eeClient.downloadMedia(attachment, function(err, buffer) {
      if (err) {
        log.error("downloadE2EEAttachment", err);
        return callback(err);
      }
      callback(null, buffer);
    });
  };
};
