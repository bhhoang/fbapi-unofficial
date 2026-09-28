"use strict";

var relayGraphql = require("./relayGraphql");
var log = require("npmlog");

var ROOT_DOC_ID = "23889300290699369";
var PAGE_DOC_ID = "9641873415921590";

function collectFiles(objects) {
  var files = [];
  var seen = {};
  function add(node) {
    if (!node || !node.id || seen[node.id]) return;
    seen[node.id] = true;
    var uploader = relayGraphql.findByKey(node, "uploader");
    var modified =
      relayGraphql.findByKey(node, "modified_time") ||
      relayGraphql.findByKey(node, "last_modified_time");
    files.push({
      fileID: String(node.id),
      name:
        node.title || node.name || node.file_name || node.filename || null,
      url: node.url || node.download_url || null,
      type: node.file_type || node.mime_type || node.__typename || null,
      modifiedTime:
        modified != null && !isNaN(Number(modified))
          ? Number(modified) * 1000
          : null,
      uploader:
        uploader && uploader.id
          ? { userID: String(uploader.id), name: uploader.name || null }
          : null
    });
  }
  function walk(obj) {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach(walk);
      return;
    }
    Object.keys(obj).forEach(function(key) {
      var value = obj[key];
      if (/files/i.test(key) && value && Array.isArray(value.edges)) {
        value.edges.forEach(function(edge) {
          if (edge && edge.node) add(edge.node);
        });
      }
      if (/files/i.test(key) && value && Array.isArray(value.nodes)) {
        value.nodes.forEach(add);
      }
      walk(value);
    });
  }
  objects.forEach(walk);
  return files;
}

module.exports = function(defaultFuncs, api, ctx) {
  var postGraphql = relayGraphql(defaultFuncs, api, ctx);

  return function getGroupFiles(groupID, options, callback) {
    if (!callback) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      } else {
        throw { error: "getGroupFiles: need callback" };
      }
    }
    options = options || {};

    if (options.cursor != null) {
      var pageVariables = {
        count:
          typeof options.amount === "number" && options.amount > 0
            ? options.amount
            : 15,
        cursor: String(options.cursor),
        groupDocsFileName: options.name != null ? String(options.name) : null,
        groupID: String(groupID),
        id: String(groupID),
        orderby: options.orderby != null ? options.orderby : null,
        scale: 1
      };
      postGraphql("GroupsCometFilesTabPaginationQuery", PAGE_DOC_ID, pageVariables)
        .then(function(objects) {
          callback(
            null,
            collectFiles(objects),
            relayGraphql.firstPageInfo(objects, null)
          );
        })
        .catch(function(err) {
          log.error("getGroupFiles", err.error || err.message || err);
          callback(err);
        });
      return;
    }

    var variables = {
      groupDocsFileName: options.name != null ? String(options.name) : null,
      groupID: String(groupID),
      orderby: options.orderby != null ? options.orderby : null,
      scale: 1
    };
    postGraphql("GroupsCometFilesTabRootQuery", ROOT_DOC_ID, variables)
      .then(function(objects) {
        callback(
          null,
          collectFiles(objects),
          relayGraphql.firstPageInfo(objects, null)
        );
      })
      .catch(function(err) {
        log.error("getGroupFiles", err.error || err.message || err);
        callback(err);
      });
  };
};
