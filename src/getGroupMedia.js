"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "26680580074858996";

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function getGroupMedia(groupID, amount, callback) {
    if (!callback) {
      if (typeof amount === "function") {
        callback = amount;
        amount = 8;
      } else {
        throw { error: "getGroupMedia: need callback" };
      }
    }
    if (typeof amount !== "number" || amount <= 0) amount = 8;

    var variables = {
      count: amount,
      cursor: null,
      scale: 1,
      id: String(groupID)
    };

    postGraphql("GroupsCometMediaPhotosTabGridQuery", DOC_ID, variables)
      .then(function(objects) {
        var items = [];
        var seen = {};
        function walk(obj) {
          if (!obj || typeof obj !== "object") return;
          if (Array.isArray(obj)) {
            obj.forEach(walk);
            return;
          }
          if (
            (obj.__typename === "Photo" || obj.__typename === "Video") &&
            obj.id &&
            !seen[obj.id]
          ) {
            seen[obj.id] = true;
            items.push({
              id: String(obj.id),
              type: obj.__typename === "Video" ? "video" : "photo",
              url: obj.url || null,
              image:
                (obj.image && obj.image.uri) ||
                (obj.large_preview && obj.large_preview.uri) ||
                (obj.preferred_thumbnail && obj.preferred_thumbnail.image && obj.preferred_thumbnail.image.uri) ||
                null,
              width:
                (obj.image && obj.image.width) ||
                (obj.large_preview && obj.large_preview.width) ||
                null,
              height:
                (obj.image && obj.image.height) ||
                (obj.large_preview && obj.large_preview.height) ||
                null
            });
          }
          Object.keys(obj).forEach(function(key) {
            walk(obj[key]);
          });
        }
        objects.forEach(walk);
        callback(null, items);
      })
      .catch(function(err) {
        log.error("getGroupMedia", err.error || err.message || err);
        callback(err);
      });
  };
};
