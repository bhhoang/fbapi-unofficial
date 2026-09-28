"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "27355772140698547";

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function getGroupRules(groupID, callback) {
    if (!callback) throw { error: "getGroupRules: need callback" };

    var variables = {
      groupID: String(groupID),
      scale: 1
    };

    postGraphql("GroupsCometRulesDialogQuery", DOC_ID, variables)
      .then(function(objects) {
        var rules = [];
        var seen = {};
        function walk(obj) {
          if (!obj || typeof obj !== "object") return;
          if (Array.isArray(obj)) {
            obj.forEach(walk);
            return;
          }
          if (obj.__typename === "GroupRule" && obj.id && !seen[obj.id]) {
            seen[obj.id] = true;
            rules.push({
              ruleID: String(obj.id),
              position:
                obj.rule_position != null ? obj.rule_position : null,
              title: obj.rule_title || null,
              description: obj.description || null
            });
          }
          Object.keys(obj).forEach(function(key) {
            walk(obj[key]);
          });
        }
        objects.forEach(walk);
        rules.sort(function(a, b) {
          return (a.position || 0) - (b.position || 0);
        });
        callback(null, rules);
      })
      .catch(function(err) {
        log.error("getGroupRules", err.error || err.message || err);
        callback(err);
      });
  };
};
