"use strict";

var utils = require("../utils");
var log = require("npmlog");

// Facebook's persisted ("Relay") GraphQL queries declare hidden feature-flag
// variables whose names start with `__relay_internal__pv__`. The server
// rejects a request when a declared one is missing ("missing_required_variable_value"),
// so every call made through here merges this table first. Values parsed from
// the login page (ctx.relayProviders) and per-call variables override them.
var relayProviders = {
  "__relay_internal__pv__CometAdsSlotFillLoggingEnabledrelayprovider": false,
  "__relay_internal__pv__CometComposerPPEAddCollaboratorsEnabledrelayprovider": false,
  "__relay_internal__pv__CometFeedShareMedia_shouldPrefetchShareImagerelayprovider": false,
  "__relay_internal__pv__CometFeedStory_enable_post_permalink_white_space_clickrelayprovider": false,
  "__relay_internal__pv__CometFeedStory_enable_reactor_facepilerelayprovider": false,
  "__relay_internal__pv__CometFeedStory_enable_social_bubblesrelayprovider": false,
  "__relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider": false,
  "__relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider": true,
  "__relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider": "AUTO_TRANSLATE",
  "__relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider": false,
  "__relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider": false,
  "__relay_internal__pv__CometUFIShareActionMigrationrelayprovider": true,
  "__relay_internal__pv__CometUFISingleLineUFIrelayprovider": true,
  "__relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider": true,
  "__relay_internal__pv__ContentLibraryHighQualityPillGKrelayprovider": false,
  "__relay_internal__pv__ContentLibraryStatusColumnGKrelayprovider": false,
  "__relay_internal__pv__ContentLibraryUnifiedContentStatusGKrelayprovider": true,
  "__relay_internal__pv__FBReelsIFUTileContent_reelsIFUPlayOnHoverrelayprovider": true,
  "__relay_internal__pv__FBReelsMediaFooter_comet_enable_reels_ads_gkrelayprovider": true,
  "__relay_internal__pv__FBReels_deprecate_short_form_video_context_gkrelayprovider": true,
  "__relay_internal__pv__FBReels_enable_view_dubbed_audio_type_gkrelayprovider": true,
  "__relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider": true,
  "__relay_internal__pv__GHLShouldChangeSponsoredAuctionDistanceFieldNamerelayprovider": true,
  "__relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider": true,
  "__relay_internal__pv__GHLShouldUseSponsoredAuctionLabelFieldNameV1relayprovider": true,
  "__relay_internal__pv__GHLShouldUseSponsoredAuctionLabelFieldNameV2relayprovider": false,
  "__relay_internal__pv__GroupsCometGYSJFeedItemHeightrelayprovider": 206,
  "__relay_internal__pv__GroupsCometGroupChatLazyLoadLastMessageSnippetrelayprovider": false,
  "__relay_internal__pv__IsMergQAPollsrelayprovider": false,
  "__relay_internal__pv__IsWorkUserrelayprovider": false,
  "__relay_internal__pv__ShouldEnableBakedInTextStoriesrelayprovider": false,
  "__relay_internal__pv__StoriesShouldEnablePhotosensitiveContentWarningrelayprovider": false,
  "__relay_internal__pv__StoriesShouldIncludeFbNotesrelayprovider": true,
  "__relay_internal__pv__TestPilotShouldIncludeDemoAdUseCaserelayprovider": false,
  "__relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider": false,
  "__relay_internal__pv__ProdashWebIGContentGKrelayprovider": false,
  "__relay_internal__pv__enableProdashWebCrossPostInsightsrelayprovider": true,
  "__relay_internal__pv__groups_comet_use_glvrelayprovider": false,
  "__relay_internal__pv__relay_provider_comet_ufi_ssr_seo_deferrelayprovider": true
};

function mergeProviders(ctx, variables) {
  var merged = {};
  Object.keys(relayProviders).forEach(function(key) {
    merged[key] = relayProviders[key];
  });
  var fromHtml = (ctx && ctx.relayProviders) || {};
  Object.keys(fromHtml).forEach(function(key) {
    merged[key] = fromHtml[key];
  });
  var vars = variables || {};
  Object.keys(vars).forEach(function(key) {
    merged[key] = vars[key];
  });
  return merged;
}

// Facebook answers `/api/graphql/` with either one JSON document or a stream
// of newline-delimited JSON documents (the first holds the bulk of the data,
// later ones carry incremental patches).
function parseResponse(body, statusCode, headers) {
  var clean = String(body || "");
  clean = clean.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, "");

  var objects = [];
  try {
    objects.push(JSON.parse(clean));
  } catch (e) {
    clean.split(/\r?\n/).forEach(function(line) {
      if (!line.trim()) return;
      try {
        objects.push(JSON.parse(line.replace(/^for\(;;\);/, "")));
      } catch (e2) {
        // ignore unparsable fragments
      }
    });
  }

  if (objects.length === 0) {
    throw {
      error:
        "relayGraphql: could not parse response (status " +
        statusCode +
        ", body length " +
        clean.length +
        ")",
      res: clean,
      statusCode: statusCode,
      headers: headers
    };
  }
  return objects;
}

// A request that Facebook answers with a legacy empty payload (or no data at
// all) usually means the CSRF tokens went stale, so fetch fresh ones from the
// homepage before retrying.
function looksEmpty(objects) {
  return !objects.some(function(o) {
    return o && (o.data || o.errors || o.label);
  });
}

function refreshTokens(ctx) {
  return utils
    .get("https://www.facebook.com/", ctx.jar, null, ctx.globalOptions)
    .then(function(res) {
      var html = res.body || "";
      var dtsg = utils.getFrom(html, '"DTSGInitialData",[],{"token":"', '"');
      var lsd = utils.getFrom(html, '"LSD",[],{"token":"', '"');
      if (dtsg) {
        ctx.fb_dtsg = dtsg;
        ctx.ttstamp = "2";
        for (var i = 0; i < dtsg.length; i++) {
          ctx.ttstamp += dtsg.charCodeAt(i);
        }
      }
      if (lsd) ctx.lsd = lsd;
      var providers = utils.getRelayProviders(html);
      if (providers && Object.keys(providers).length > 0) {
        ctx.relayProviders = providers;
      }
    });
}

function checkObjects(objects, options) {
  var tolerateFieldErrors = !!(options && options.tolerateFieldErrors);
  var critical = [];
  var tolerated = [];
  objects.forEach(function(o) {
    if (o.error === 1357001) {
      throw { error: "Not logged in." };
    }
    (o.errors || []).forEach(function(e) {
      if (e.severity === "WARNING") return;
      // Facebook occasionally fails to resolve unrelated response fields
      // (field_type_no_match) while the mutation itself is applied; the web
      // client renders the partial response and carries on. Mutations that
      // know this can opt in to the same behaviour.
      if (tolerateFieldErrors && /field_type_no_match/.test(e.message || "")) {
        tolerated.push(e);
        return;
      }
      critical.push(e);
    });
  });
  if (tolerated.length > 0) {
    log.warn(
      "relayGraphql",
      "ignored " + tolerated.length + " response-field error(s): " +
        (tolerated[0].message || "").slice(0, 120)
    );
  }
  if (critical.length > 0) {
    throw {
      error: critical[0].message || "relayGraphql: request failed",
      errors: critical
    };
  }
  return objects;
}

module.exports = function(defaultFuncs, api, ctx) {
  function buildForm(friendlyName, docId, variables) {
    var form = {
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: friendlyName,
      server_timestamps: true,
      doc_id: docId,
      variables: JSON.stringify(mergeProviders(ctx, variables))
    };
    if (ctx.lsd) form.lsd = ctx.lsd;
    return form;
  }

  function request(friendlyName, docId, variables) {
    return defaultFuncs
      .post(
        "https://www.facebook.com/api/graphql/",
        ctx.jar,
        buildForm(friendlyName, docId, variables)
      )
      .then(function(res) {
        if (res.statusCode !== 200) {
          throw {
            error: "relayGraphql: HTTP " + res.statusCode,
            res: res.body,
            statusCode: res.statusCode
          };
        }
        return parseResponse(res.body, res.statusCode, res.headers);
      });
  }

  return function postGraphql(friendlyName, docId, variables, options) {
    return request(friendlyName, docId, variables)
      .then(function(objects) {
        if (!looksEmpty(objects)) return checkObjects(objects, options);

        // Facebook answers automated bursts with silent empty payloads instead
        // of an error; don't hammer it with a refresh+retry on every call.
        if (
          ctx.relayGraphqlThrottledUntil &&
          Date.now() < ctx.relayGraphqlThrottledUntil
        ) {
          return checkObjects(objects, options);
        }

        // Tokens may have rotated; refresh and try once more.
        return refreshTokens(ctx)
          .then(function() {
            return request(friendlyName, docId, variables);
          })
          .then(function(retryObjects) {
            if (looksEmpty(retryObjects)) {
              ctx.relayGraphqlThrottledUntil = Date.now() + 5 * 60 * 1000;
            }
            return checkObjects(retryObjects, options);
          });
      })
      .catch(function(err) {
        log.error(
          "relayGraphql",
          err && (err.error || err.message) ? err.error || err.message : err
        );
        throw err;
      });
  };
};

// Recursively finds the first value stored under `key` in a parsed payload.
function findByKey(obj, key) {
  if (!obj || typeof obj !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var found = findByKey(obj[keys[i]], key);
    if (found !== undefined) return found;
  }
  return undefined;
}

// Collects feed story nodes from every parsed document, in the order Facebook
// returned them, skipping duplicates.
function collectFeedStories(objects) {
  var stories = [];
  var seen = {};
  function walk(obj) {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach(walk);
      return;
    }
    if (obj.__isFeedUnit === "Story" && obj.post_id && !seen[obj.post_id]) {
      seen[obj.post_id] = true;
      stories.push(obj);
    }
    Object.keys(obj).forEach(function(key) {
      walk(obj[key]);
    });
  }
  objects.forEach(walk);
  return stories;
}

module.exports.findByKey = findByKey;
module.exports.collectFeedStories = collectFeedStories;

// Finds the pagination cursor of a connection. Facebook streams `page_info`
// either inside the connection payload or as a separate deferred object whose
// `path` names the connection, so `pathHint` is checked first.
function firstPageInfo(objects, pathHint) {
  var byPath = null;
  var byWalk = null;
  function walk(obj) {
    if (byWalk || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach(walk);
      return;
    }
    if (
      obj.page_info &&
      (obj.page_info.end_cursor !== undefined ||
        obj.page_info.has_next_page !== undefined)
    ) {
      byWalk = obj.page_info;
      return;
    }
    Object.keys(obj).forEach(function(key) {
      walk(obj[key]);
    });
  }
  objects.forEach(function(o) {
    if (
      !byPath &&
      pathHint &&
      Array.isArray(o && o.path) &&
      o.path.indexOf(pathHint) >= 0 &&
      o.data &&
      o.data.page_info
    ) {
      byPath = o.data.page_info;
    }
    walk(o);
  });
  var info = byPath || byWalk;
  if (!info) return null;
  return {
    endCursor: info.end_cursor != null ? info.end_cursor : null,
    hasNextPage: !!info.has_next_page
  };
}

module.exports.firstPageInfo = firstPageInfo;

// The web client sends a telemetry string in `attribution_id_v2` with most
// group mutations. The exact contents are not validated by the server, but the
// shape is `<component>,<surface>,via_cold_start,<timestamp>,<random>,<actor>,,`.
module.exports.attributionID = function(entryPoint, surface) {
  return (
    entryPoint +
    (surface ? "," + surface : "") +
    ",via_cold_start," +
    Date.now() +
    "," +
    ((Math.random() * 1000000) | 0) +
    ",2361831622,,"
  );
};
