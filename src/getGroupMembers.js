"use strict";

var log = require("npmlog");

// Facebook's group UI no longer exposes a plain "next page" member list:
// the People tab searches members through a search backend. An empty search
// string returns a sample of members (recently joined/active) and a name
// returns the matching members, which is what this helper is built on.
module.exports = function(defaultFuncs, api, ctx) {
  return function getGroupMembers(groupID, amount, callback) {
    if (!callback) {
      if (typeof amount === "function") {
        callback = amount;
        amount = 20;
      } else {
        throw { error: "getGroupMembers: need callback" };
      }
    }
    return api.searchGroupMembers(groupID, "", amount, callback);
  };
};
