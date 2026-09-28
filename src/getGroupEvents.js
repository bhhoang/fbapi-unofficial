"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var ROOT_DOC_ID = "27816091738021206";
var UPCOMING_DOC_ID = "28557944680471926";
var PAST_DOC_ID = "27298101413222386";

function collectEvents(objects) {
  var events = [];
  var seen = {};
  function add(node) {
    if (!node || !node.id || seen[node.id]) return;
    seen[node.id] = true;
    var place = relayGraphql.findByKey(node, "event_place");
    var start = relayGraphql.findByKey(node, "start_timestamp");
    if (start == null) start = relayGraphql.findByKey(node, "start_time");
    var end = relayGraphql.findByKey(node, "end_timestamp");
    if (end == null) end = relayGraphql.findByKey(node, "end_time");
    events.push({
      eventID: String(node.id),
      name: node.name || null,
      url: node.url || "https://www.facebook.com/events/" + node.id,
      startTimestamp: start != null ? Number(start) * 1000 : null,
      endTimestamp: end != null ? Number(end) * 1000 : null,
      place: place && place.name ? place.name : null,
      isPast: false
    });
  }
  function walk(obj) {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach(walk);
      return;
    }
    ["upcoming_events", "past_events"].forEach(function(key) {
      var conn = obj[key];
      if (conn && Array.isArray(conn.edges)) {
        conn.edges.forEach(function(edge) {
          if (!edge || !edge.node) return;
          add(edge.node);
          var last = events[events.length - 1];
          if (last) last.isPast = key === "past_events";
        });
      }
    });
    if (obj.all_past_events && Array.isArray(obj.all_past_events.nodes)) {
      obj.all_past_events.nodes.forEach(function(node) {
        add(node);
        var last = events[events.length - 1];
        if (last) last.isPast = true;
      });
    }
    Object.keys(obj).forEach(function(key) {
      walk(obj[key]);
    });
  }
  objects.forEach(walk);
  return events;
}

function sectionPageInfos(objects) {
  var infos = { upcoming: null, past: null };
  function toInfo(pageInfo) {
    return {
      endCursor: pageInfo.end_cursor != null ? pageInfo.end_cursor : null,
      hasNextPage: !!pageInfo.has_next_page
    };
  }
  function walk(obj) {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach(walk);
      return;
    }
    ["upcoming_events", "past_events"].forEach(function(key) {
      var target = key === "upcoming_events" ? "upcoming" : "past";
      if (!infos[target] && obj[key] && obj[key].page_info) {
        infos[target] = toInfo(obj[key].page_info);
      }
    });
    Object.keys(obj).forEach(function(key) {
      walk(obj[key]);
    });
  }
  objects.forEach(walk);
  return infos;
}

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function getGroupEvents(groupID, amount, options, callback) {
    if (!callback) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      } else if (typeof amount === "function") {
        callback = amount;
        options = {};
        amount = 3;
      } else {
        throw { error: "getGroupEvents: need callback" };
      }
    }
    options = options || {};
    if (typeof amount !== "number" || amount <= 0) amount = 3;

    var section = String(options.section || "upcoming").toLowerCase();
    if (section !== "upcoming" && section !== "past") {
      throw { error: "getGroupEvents: section must be upcoming or past" };
    }

    if (options.cursor != null) {
      var pageVariables = {
        count: amount,
        cursor: String(options.cursor),
        groupID: String(groupID),
        id: String(groupID),
        scale: 1
      };
      postGraphql(
        section === "past"
          ? "GroupsCometEventPastSectionPaginationQuery"
          : "GroupsCometEventUpcomingSectionPaginationQuery",
        section === "past" ? PAST_DOC_ID : UPCOMING_DOC_ID,
        pageVariables
      )
        .then(function(objects) {
          callback(
            null,
            collectEvents(objects),
            relayGraphql.firstPageInfo(objects, null)
          );
        })
        .catch(function(err) {
          log.error("getGroupEvents", err.error || err.message || err);
          callback(err);
        });
      return;
    }

    var variables = {
      count: amount,
      groupID: String(groupID),
      scale: 1
    };
    postGraphql("CometGroupEventsRootQuery", ROOT_DOC_ID, variables)
      .then(function(objects) {
        callback(null, collectEvents(objects), sectionPageInfos(objects));
      })
      .catch(function(err) {
        log.error("getGroupEvents", err.error || err.message || err);
        callback(err);
      });
  };
};
