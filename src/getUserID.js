"use strict";

var https = require("https");
var utils = require("../utils");
var log = require("npmlog");

function formatData(data) {
  return {
    userID: utils.formatID(data.uid.toString()),
    photoUrl: data.photo,
    indexRank: data.index_rank,
    name: data.text,
    isVerified: data.is_verified,
    profileUrl: data.path,
    category: data.category,
    score: data.score,
    type: data.type
  };
}

// The profile page is fetched directly: the library's default request helper
// comes back empty for HTML pages, and the browser-shaped headers below are
// what makes Facebook return the full page for this session.
function fetchProfilePath(path, jar, redirects, callback) {
  var cookies = jar.getCookies("https://www.facebook.com")
    .map(function(cookie) { return cookie.cookieString(); }).join("; ");
  var request = https.get({
    hostname: "www.facebook.com",
    path: path,
    headers: {
      "Cookie": cookies,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Upgrade-Insecure-Requests": "1"
    }
  }, function(res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
      res.resume();
      var next = res.headers.location.replace(/^https?:\/\/[^/]+/, "");
      return fetchProfilePath(next, jar, redirects - 1, callback);
    }
    var chunks = [];
    res.on("data", function(chunk) { chunks.push(chunk); });
    res.on("end", function() { callback(null, Buffer.concat(chunks).toString("utf8")); });
  });
  request.on("error", callback);
}

module.exports = function(defaultFuncs, api, ctx) {
  // Facebook retired the typeahead endpoint the old lookup used (it answers
  // with error 1357004 now). The profile page still carries the mapping
  // `"userVanity":"<username>","userID":"<id>"` for logged-in users, so the
  // fallback reads it from there.
  function resolveFromProfile(name, callback) {
    var escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    fetchProfilePath("/" + encodeURIComponent(name) + "/", ctx.jar, 3, function(err, html) {
      if (err) {
        log.error("getUserID", err);
        return callback(err);
      }
      var match = new RegExp('"userVanity":"' + escaped + '","userID":"(\\d+)"', "i").exec(html);
      if (!match) {
        match = new RegExp('"vanity":"' + escaped + '"[^}]{0,200}?"userID":"(\\d+)"', "i").exec(html);
      }
      if (!match) {
        match = /"userVanity":"[^"]+","userID":"(\d+)"/.exec(html);
      }
      if (!match) {
        log.error("getUserID", "could not resolve " + name + " from a " + html.length + " byte profile page");
        return callback({ error: "getUserID: could not resolve the username " + name });
      }
      var title = /<meta property="og:title" content="([^"]+)"/.exec(html);
      callback(null, [formatData({ uid: match[1], text: title ? title[1] : name })]);
    });
  }

  return function getUserID(name, callback) {
    if (!callback) {
      throw { error: "getUserID: need callback" };
    }

    var form = {
      value: name.toLowerCase(),
      viewer: ctx.userID,
      rsp: "search",
      context: "search",
      path: "/home.php",
      request_id: utils.getGUID()
    };

    defaultFuncs
      .get("https://www.facebook.com/ajax/typeahead/search.php", ctx.jar, form)
      .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
      .then(function(resData) {
        if (resData.error) {
          throw resData;
        }

        var data = resData.payload.entries;
        if (!data || !data.length) {
          return resolveFromProfile(name, callback);
        }

        callback(null, data.map(formatData));
      })
      .catch(function(err) {
        if (err && err.error === 1357004) {
          // The retired endpoint answers with this code; the profile page
          // fallback still resolves plain usernames.
          return resolveFromProfile(name, callback);
        }
        log.error("getUserID", err);
        return callback(err);
      });
  };
};
