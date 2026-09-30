"use strict";

var log = require("npmlog");

// Facebook retired /ajax/messaging/attachments/sharedphotos.php. Shared
// pictures are reconstructed from the thread's message history instead: every
// history attachment of type "photo" (or "animated_image") already carries the
// image URLs, exactly as getThreadHistory returns them. offset/limit page over
// that list, newest first (the history's own order).
module.exports = function(defaultFuncs, api, ctx) {
  return function getThreadPictures(threadID, offset, limit, callback) {
    if (typeof offset === "function") {
      callback = offset;
      offset = 0;
      limit = 10;
    } else if (typeof limit === "function") {
      callback = limit;
      limit = 10;
    }
    if (!callback) {
      throw { error: "getThreadPictures: need callback" };
    }
    if (threadID == null) {
      return callback({ error: "getThreadPictures: need threadID" });
    }
    offset = Math.max(0, parseInt(offset, 10) || 0);
    limit = Math.max(1, parseInt(limit, 10) || 10);
    var wanted = offset + limit;

    var pictures = [];
    var seen = {};
    var before = null;
    var pages = 0;
    var done = false;

    function finish(err) {
      if (done) return;
      done = true;
      if (err) {
        log.error("Error in getThreadPictures", err);
        return callback(err);
      }
      callback(null, pictures.slice(offset, wanted));
    }

    function collect(message) {
      var attachments = (message && message.attachments) || [];
      attachments.forEach(function(attachment) {
        if (!attachment) return;
        if (attachment.type !== "photo" && attachment.type !== "animated_image") return;
        var uri = attachment.url || attachment.largePreviewUrl ||
          attachment.previewUrl || attachment.thumbnailUrl;
        if (!uri || seen[uri]) return;
        seen[uri] = true;
        pictures.push({
          uri: attachment.url || uri,
          url: attachment.url || uri,
          previewUrl: attachment.previewUrl || attachment.thumbnailUrl || uri,
          thumbnailUrl: attachment.thumbnailUrl || attachment.previewUrl || uri,
          width: attachment.width != null ? attachment.width : attachment.previewWidth,
          height: attachment.height != null ? attachment.height : attachment.previewHeight,
          ID: attachment.ID,
          messageID: message.messageID,
          timestamp: message.timestamp,
          senderID: message.senderID
        });
      });
    }

    function pull() {
      if (done) return;
      if (pictures.length >= wanted || pages >= 30) return finish();
      api.getThreadHistory(threadID, 100, before, function(err, history) {
        if (done) return;
        if (err) {
          // Paging can run past the end of the available history; an error
          // after a successful page just ends the scan.
          if (pages > 0 || pictures.length) return finish();
          return finish(err);
        }
        if (!Array.isArray(history) || !history.length) return finish();
        var oldest = null;
        history.forEach(function(message) {
          if (message && typeof message.timestamp === "number" &&
            (oldest == null || message.timestamp < oldest)) {
            oldest = message.timestamp;
          }
          collect(message);
        });
        if (oldest == null || (before != null && oldest >= before)) return finish();
        before = oldest;
        pages++;
        setImmediate(pull);
      });
    }

    pull();
  };
};
