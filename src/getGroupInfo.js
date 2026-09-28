"use strict";

var utils = require("../utils");
var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var DOC_ID = "28847195208215631";

function collectGroupNodes(objects, groupID) {
  var nodes = [];
  function walk(obj) {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach(walk);
      return;
    }
    if (
      (obj.__typename === "Group" || obj.id !== undefined) &&
      String(obj.id) === String(groupID)
    ) {
      nodes.push(obj);
    }
    Object.keys(obj).forEach(function(key) {
      walk(obj[key]);
    });
  }
  objects.forEach(walk);
  return nodes;
}

function firstDefined(nodes, key) {
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i][key] !== undefined && nodes[i][key] !== null) {
      return nodes[i][key];
    }
  }
  return null;
}

function hasValue(nodes, key) {
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i][key] !== undefined && nodes[i][key] !== null) return true;
  }
  return false;
}

// Turns "353,212 total members" or "353.2K" into a number.
function parseMemberCount(text) {
  if (!text) return null;
  var match = /([\d.,]+)\s*([KMB])?/i.exec(text);
  if (!match) return null;
  var value = parseFloat(match[1].replace(/,/g, ""));
  if (isNaN(value)) return null;
  var suffix = (match[2] || "").toUpperCase();
  if (suffix === "K") value *= 1000;
  else if (suffix === "M") value *= 1000000;
  else if (suffix === "B") value *= 1000000000;
  return Math.round(value);
}

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function getGroupInfo(groupID, callback) {
    if (!callback) throw { error: "getGroupInfo: need callback" };

    var variables = {
      groupID: String(groupID),
      inviteShortLinkKey: null,
      isChainingRecommendationUnit: false,
      scale: 1
    };

    var layoutQuery = postGraphql(
      "GroupsCometDiscussionLayoutRootQuery",
      "37987594904187885",
      { groupID: String(groupID), scale: 1 }
    ).catch(function(err) {
      log.warn(
        "getGroupInfo",
        "layout query failed: " + (err.error || err.message || err)
      );
      return [];
    });

    Promise.all([
      postGraphql("CometGroupRootQuery", DOC_ID, variables),
      layoutQuery
    ])
      .then(function(results) {
        var nodes = collectGroupNodes(results[0], groupID).concat(
          collectGroupNodes(results[1], groupID)
        );
        if (nodes.length === 0) {
          throw {
            error: "getGroupInfo: no group in response",
            res: results
          };
        }
        var privacyInfo = firstDefined(nodes, "privacy_info") || {};
        var discoverabilityInfo =
          firstDefined(nodes, "discoverability_info") || {};
        var descriptionEntities = firstDefined(
          nodes,
          "description_with_entities"
        );
        var info = {
          groupID: String(groupID),
          name: firstDefined(nodes, "name"),
          url: firstDefined(nodes, "url"),
          description:
            firstDefined(nodes, "description") ||
            (descriptionEntities ? descriptionEntities.text : null),
          privacy: privacyInfo.title
            ? privacyInfo.title.text
            : privacyInfo.label
              ? privacyInfo.label.text
              : null,
          privacyDescription: privacyInfo.description
            ? privacyInfo.description.text
            : null,
          discoverability: discoverabilityInfo.title
            ? discoverabilityInfo.title.text
            : discoverabilityInfo.label
              ? discoverabilityInfo.label.text
              : null,
          discoverabilityDescription: discoverabilityInfo.description
            ? discoverabilityInfo.description.text
            : null,
          memberCount:
            firstDefined(nodes, "approximate_member_count") ||
            firstDefined(nodes, "member_count"),
          isMember:
            firstDefined(nodes, "is_viewer_member") != null
              ? firstDefined(nodes, "is_viewer_member")
              : firstDefined(nodes, "viewer_join_state") === "MEMBER",
          viewerJoinState: firstDefined(nodes, "viewer_join_state"),
          isAdmin:
            hasValue(nodes, "if_viewer_can_see_admin_home") ||
            hasValue(nodes, "if_viewer_can_see_admin_left_hand_rail"),
          subscribeStatus: firstDefined(nodes, "subscribe_status"),
          isPinned: firstDefined(nodes, "has_viewer_pinned")
        };

        // None of the GraphQL payloads used above expose the member count, so
        // fall back to the About page, whose server-rendered payload contains
        // both an exact count and a formatted one.
        if (info.memberCount == null) {
          utils
            .get(
              "https://www.facebook.com/groups/" + groupID + "/about/",
              ctx.jar,
              null,
              Object.assign({}, ctx.globalOptions, {
                headers: {
                  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                  "accept-language": "en-US,en;q=0.9"
                }
              })
            )
            .then(function(res) {
              var html = res.body || "";
              var exact =
                /"group_total_members_info_text":"([^"]+)"/.exec(html) ||
                /"member_count_text":"([^"]+)"/.exec(html);
              var formatted = /"formatted_count_text":"([^"]+)"/.exec(
                html
              );
              if (exact || formatted) {
                info.memberCountText = exact ? exact[1] : formatted[1];
                info.memberCount = parseMemberCount(info.memberCountText);
              }
              callback(null, info);
            })
            .catch(function(err) {
              log.warn(
                "getGroupInfo",
                "member count fallback failed: " + (err.error || err.message || err)
              );
              callback(null, info);
            });
        } else {
          callback(null, info);
        }
      })
      .catch(function(err) {
        log.error("getGroupInfo", err.error || err.message || err);
        callback(err);
      });
  };
};
