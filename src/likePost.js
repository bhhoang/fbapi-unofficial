"use strict";

module.exports = function(defaultFuncs, api, ctx) {
  return function likePost(postID, callback) {
    return api.setPostReaction(postID, "LIKE", callback);
  };
};
