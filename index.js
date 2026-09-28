"use strict";

var utils = require("./utils");
var log = require("npmlog");
var fs = require("fs");

var defaultLogRecordSize = 100;
log.maxRecordSize = defaultLogRecordSize;

// cheerio takes ~0.4s to load and only the password/approval forms need it, so
// appState logins (the common case) never pay for it.
function loadHTML(html) {
  return require("cheerio").load(html);
}

function setOptions(globalOptions, options) {
  Object.keys(options).map(function(key) {
    switch (key) {
      case 'logLevel':
        log.level = options.logLevel;
        globalOptions.logLevel = options.logLevel;
        break;
      case 'logRecordSize':
        log.maxRecordSize = options.logRecordSize;
        globalOptions.logRecordSize = options.logRecordSize;
        break;
      case 'selfListen':
        globalOptions.selfListen = options.selfListen;
        break;
      case 'listenEvents':
        globalOptions.listenEvents = options.listenEvents;
        break;
      case 'pageID':
        globalOptions.pageID = options.pageID.toString();
        break;
      case 'updatePresence':
        globalOptions.updatePresence = options.updatePresence;
        break;
      case 'forceLogin':
        globalOptions.forceLogin = options.forceLogin;
        break;
      case 'userAgent':
        globalOptions.userAgent = options.userAgent;
        break;
      case 'autoMarkDelivery':
        globalOptions.autoMarkDelivery = options.autoMarkDelivery;
        break;
      case 'autoMarkRead':
        globalOptions.autoMarkRead = options.autoMarkRead;
        break;
      case 'e2eeDevicePath':
        globalOptions.e2eeDevicePath = options.e2eeDevicePath;
        break;
      case 'e2eeFrameLog':
        globalOptions.e2eeFrameLog = options.e2eeFrameLog;
        break;
      case 'frameEncryptionWasmPath':
        globalOptions.frameEncryptionWasmPath = options.frameEncryptionWasmPath;
        break;
      case 'mobileDevicePath':
        globalOptions.mobileDevicePath = options.mobileDevicePath;
        break;
      case 'opusBitrate':
        // Default Opus bitrate (bps) for calls with real media; overridable
        // per call with options.media.opusBitrate. Opus caps at 510000.
        globalOptions.opusBitrate = options.opusBitrate;
        break;
      default:
        log.warn("setOptions", "Unrecognized option given to setOptions: " + key);
        break;
    }
  });
}

function buildAPI(globalOptions, html, jar) {
  var maybeCookie = jar.getCookies("https://www.facebook.com").filter(function(val) {
    return val.cookieString().split("=")[0] === "c_user";
  });

  if(maybeCookie.length === 0) {
    throw {error: "Error retrieving userID. This can be caused by a lot of things, including getting blocked by Facebook for logging in from an unknown location. Try logging in with a browser to verify."};
  }

  var userID = maybeCookie[0].cookieString().split("=")[1].toString();
  log.info("login", "Logged in");

  var clientID = (Math.random() * 2147483648 | 0).toString(16);

  // All data available to api functions
  var ctx = {
    userID: userID,
    jar: jar,
    clientID: clientID,
    globalOptions: globalOptions,
    loggedIn: true,
    access_token: 'NONE',
    clientMutationId: 0,
    mqttClient: undefined,
    lastSeqId: 0,
    syncToken: undefined,
    // CSRF token used by Facebook's GraphQL endpoint (see src/relayGraphql.js).
    lsd: utils.getFrom(html, '"LSD",[],{"token":"', '"'),
    // Feature-flag variables declared by the queries Facebook's web app uses.
    relayProviders: utils.getRelayProviders(html)
  };

  var api = {
    setOptions: setOptions.bind(null, globalOptions),
    getAppState: function getAppState() {
      return utils.getAppState(jar);
    },
  };

  const apiFuncNames = [
    'acceptCall',
    'addUserToGroup',
    'approveJoinRequest',
    'blockGroupMember',
    'call',
    'changeAdminStatus',
    'changeArchivedStatus',
    'changeBlockedStatus',
    'changeGroupImage',
    'changeNickname',
    'changeThreadColor',
    'changeThreadEmoji',
    'connectCalls',
    'connectE2EE',
    'createComment',
    'createGroup',
    'createGroupPost',
    'createPoll',
    'declineJoinRequest',
    'deleteComment',
    'deleteGroupPost',
    'declineCall',
    'deleteMessage',
    'deleteThread',
    'downloadE2EEAttachment',
    'editComment',
    'endCall',
    'editGroupPost',
    'followGroup',
    'forwardAttachment',
    'getCalls',
    'getCurrentUserID',
    'getEmojiUrl',
    'getFeed',
    'getFriendsList',
    'getGroupEvents',
    'getGroupFiles',
    'getGroupInfo',
    'getGroupMedia',
    'getGroupMembers',
    'getGroupPosts',
    'getGroupRules',
    'getPostComments',
    'getPostReactions',
    'getThreadHistory',
    'getThreadInfo',
    'getThreadList',
    'getThreadPictures',
    'getUserID',
    'getUserInfo',
    'handleMessageRequest',
    'inviteToGroup',
    'joinGroup',
    'leaveGroup',
    'likePost',
    'listenMqtt',
    'logout',
    'markAsDelivered',
    'markAsRead',
    'markAsReadAll',
    'markGroupVisited',
    'muteThread',
    'pinGroupPost',
    'removeGroupMember',
    'removeUserFromGroup',
    'resolvePhotoUrl',
    'restoreE2EEBackup',
    'searchForThread',
    'searchGroupMembers',
    'searchMessages',
    'searchGroupPosts',
    'sendMessage',
    'sendTypingIndicator',
    'setCommentReaction',
    'setMessageReaction',
    'setPostReaction',
    'setTitle',
    'threadColors',
    'unfollowGroup',
    'unpinGroupPost',
    'unsendMessage',
    'updateGroup',
    'updateGroupDiscoverability',

    // Deprecated features
    "getThreadListDeprecated",
    'getThreadHistoryDeprecated',
    'getThreadInfoDeprecated',
    'listen'
  ];

  var defaultFuncs = utils.makeDefaults(html, userID, ctx);

  // Each api function is loaded the first time it's used. Requiring all of
  // src/ (and the E2EE/call stacks behind it) up front was most of login's
  // CPU time, and a script usually only needs a few of them. Assigning
  // api.<name> still replaces the function, as before.
  apiFuncNames.map(function(v) {
    Object.defineProperty(api, v, {
      configurable: true,
      enumerable: true,
      get: function() {
        var fn = require('./src/' + v)(defaultFuncs, api, ctx);
        Object.defineProperty(api, v, {value: fn, writable: true, configurable: true, enumerable: true});
        return fn;
      },
      set: function(fn) {
        Object.defineProperty(api, v, {value: fn, writable: true, configurable: true, enumerable: true});
      }
    });
  });

  return [ctx, defaultFuncs, api];
}

function makeLogin(jar, email, password, loginOptions, callback) {
  return function(res) {
    var html = res.body;
    var $ = loadHTML(html);
    var arr = [];

    // This will be empty, but just to be sure we leave it
    $("#login_form input").map(function(i, v){
      arr.push({val: $(v).val(), name: $(v).attr("name")});
    });

    arr = arr.filter(function(v) {
      return v.val && v.val.length;
    });

    var form = utils.arrToForm(arr);

    // Current homepages don't render the classic #login_form inputs anymore.
    // The login parameters live in a JSON blob on the page and the password is
    // encrypted with a public key before being submitted (headerless login).
    var lsd =
      utils.getFrom(html, '"lsd":{"name":"lsd","value":"', '"') ||
      utils.getFrom(html, "[\"LSD\",[],{\"token\":\"", "\"}") ||
      form.lsd;
    var jazoest =
      utils.getFrom(html, '"jazoest":{"name":"jazoest","value":"', '"') ||
      form.jazoest;
    var lgnrnd =
      utils.getFrom(html, '"lgnrnd":"', '"') ||
      utils.getFrom(html, "name=\"lgnrnd\" value=\"", "\"");
    var encryption = getPasswordEncryptionKey(html);

    // If none of the tokens the login request needs are present we aren't
    // looking at the login page at all, so fail fast with an honest message
    // instead of reporting a wrong password later.
    if (!lsd && !lgnrnd && arr.length === 0) {
      throw {
        error:
          "Could not find the login form parameters on the Facebook homepage. " +
          "Facebook may have changed the login page again. As a fallback, use " +
          "appState (cookie) login: log in with a browser, export your " +
          "cookies, and pass them as `appState`. This is not a wrong-password " +
          "error."
      };
    }

    // The page's JavaScript injects session cookies (datr, sb, ...) that the
    // login request is expected to carry; replay them from the page data.
    utils.saveDeferredCookies(jar, html);


    log.info("login", "Logging in...");

    // Current login form: a GraphQL mutation whose password is encrypted with
    // the public key embedded in the page (see getPasswordEncryptionKey).
    if (lsd && lgnrnd && encryption) {
      var encpass = utils.encryptPassword(encryption.publicKey, encryption.keyId, password);
      var lgnjs = ~~(Date.now() / 1000);
      var variables = {
        input: {
          actor_id: "0",
          client_mutation_id: "1",
          access_flow_version: "pre_mt_behavior",
          account_recovery_entry_point: null,
          app: "facebook",
          auth_domain_data_key: null,
          caa_login_request_extra_info: {
            ab_test_data: "",
            shared_prefs_data: "",
            cuid: "",
            guid: utils.getGUID(),
            jazoest: jazoest,
            lgndim: Buffer.from("{\"w\":1440,\"h\":900,\"aw\":1440,\"ah\":834,\"c\":24}").toString("base64"),
            lgnjs: String(lgnjs),
            lgnrnd: lgnrnd,
            locale: "en_US",
            login_source: "comet_headerless_login",
            lsd: lsd,
            next: "",
            prefill_contact_point: "",
            prefill_source: "",
            prefill_type: "",
            skstamp: "",
            timezone: String(-new Date().getTimezoneOffset())
          },
          credential_type: "password",
          dyi_job_id: "",
          enc_password: { sensitive_string_value: encpass },
          event_request_id: utils.getGUID(),
          identifier: email,
          ig_web_device_id: null,
          initial_request_id: "1",
          lids: null,
          login_source: "COMET_HEADERLESS_LOGIN",
          next: null,
          passkey_payload: null,
          password: { sensitive_string_value: encpass },
          persistent: true,
          query_params: "{}",
          trusted_device_records: "{}",
          use_uid_to_login: false,
          waterfall_id: utils.getGUID()
        },
        scale: 1
      };
      var request = {
        av: "0",
        __user: "0",
        __a: "1",
        __req: "1",
        __rev: utils.getFrom(html, '"revision":', ","),
        lsd: lsd,
        jazoest: jazoest,
        __comet_req: "15",
        fb_api_caller_class: "RelayModern",
        fb_api_req_friendly_name: "useCDSWebLoginMutation",
        server_timestamps: "true",
        doc_id: webLoginDocID,
        variables: JSON.stringify(variables)
      };

      return utils
        .post("https://www.facebook.com/api/graphql/", jar, request, loginOptions)
        .then(utils.saveCookies(jar))
        .then(function(res) {
          return handleWebLoginResponse(res, jar, email, password, loginOptions, callback);
        });
    }

    // Legacy fallback for pages that still expect the classic form POST.
    form.lsd = lsd;
    form.jazoest = jazoest;
    form.lgnrnd = lgnrnd;
    form.locale = 'en_US';
    form.timezone = '240';
    form.lgnjs = ~~(Date.now() / 1000);
    form.email = email;
    form.pass = password;
    form.default_persistent = '0';
    form.login_source = 'comet_headerless_login';
    var loginURL = "https://www.facebook.com/login/device-based/regular/login/?login_attempt=1&lwv=110";
    return utils
      .post(loginURL, jar, form, loginOptions)
      .then(utils.saveCookies(jar))
      .then(function(res) {
        var headers = res.headers;
        if (!headers.location) {
          throw {error: "Wrong username/password."};
        }

        // This means the account has login approvals turned on.
        if (headers.location.indexOf('https://www.facebook.com/checkpoint/') > -1) {
          log.info("login", "You have login approvals turned on.");
          var nextURL = 'https://www.facebook.com/checkpoint/?next=https%3A%2F%2Fwww.facebook.com%2Fhome.php';

          return utils
            .get(headers.location, jar, null, loginOptions)
            .then(utils.saveCookies(jar))
            .then(function(res) {
              var html = res.body;
              // Make the form in advance which will contain the fb_dtsg and nh
              var $ = loadHTML(html);
              var arr = [];
              $("form input").map(function(i, v){
                arr.push({val: $(v).val(), name: $(v).attr("name")});
              });

              arr = arr.filter(function(v) {
                return v.val && v.val.length;
              });

              var form = utils.arrToForm(arr);

              function continueLogin(code) {
                form.approvals_code = code;
                form['submit[Continue]'] = 'Continue';
                return utils
                  .post(nextURL, jar, form, loginOptions)
                  .then(utils.saveCookies(jar))
                  .then(function() {
                    // Use the same form (safe I hope)
                    form.name_action_selected = 'save_device';

                    return utils
                      .post(nextURL, jar, form, loginOptions)
                      .then(utils.saveCookies(jar));
                  })
                  .then(function(res) {
                    var headers = res.headers;
                    if (!headers.location && res.body.indexOf('Review Recent Login') > -1) {
                      throw {error: "Something went wrong with login approvals."};
                    }

                    var appState = utils.getAppState(jar);

                    // Simply call loginHelper because all it needs is the jar
                    // and will then complete the login process
                    return loginHelper(appState, email, password, loginOptions, callback);
                  })
                  .catch(function(err) {
                    callback(err);
                  });
              }

              if (html.indexOf("checkpoint/?next") > -1) {
                if (loginOptions.twoFactorSecret) {
                  log.info("login", "Login approval required, generating a 2FA code.");
                  return continueLogin(utils.generateTOTP(loginOptions.twoFactorSecret));
                }
                throw {
                  error: 'login-approval',
                  continue: continueLogin
                };
              } else {
                if (!loginOptions.forceLogin) {
                  throw {error: "Couldn't login. Facebook might have blocked this account. Please login with a browser or enable the option 'forceLogin' and try again."};
                }
                if (html.indexOf("Suspicious Login Attempt") > -1) {
                  form['submit[This was me]'] = "This was me";
                } else {
                  form['submit[This Is Okay]'] = "This Is Okay";
                }

                return utils
                  .post(nextURL, jar, form, loginOptions)
                  .then(utils.saveCookies(jar))
                  .then(function() {
                    // Use the same form (safe I hope)
                    form.name_action_selected = 'save_device';

                    return utils
                      .post(nextURL, jar, form, loginOptions)
                      .then(utils.saveCookies(jar));
                  })
                  .then(function(res) {
                    var headers = res.headers;

                    if (!headers.location && res.body.indexOf('Review Recent Login') > -1) {
                      throw {error: "Something went wrong with review recent login."};
                    }

                    var appState = utils.getAppState(jar);

                    // Simply call loginHelper because all it needs is the jar
                    // and will then complete the login process
                    return loginHelper(appState, email, password, loginOptions, callback);
                  })
                  .catch(function(e) {
                    callback(e);
                  });
              }
            });
        }

        return utils
          .get('https://www.facebook.com/', jar, null, loginOptions)
          .then(utils.saveCookies(jar));
      });
  };
}

// The current login form submits a GraphQL mutation instead of POSTing the
// classic form. As with the doc_ids in src/getThread*.js, this id is tied to a
// Facebook revision and may need to be updated when they ship a new one.
var webLoginDocID = "28077768681846394";

// Returns the public key the login form encrypts the password with. The
// homepage embeds several unrelated keys, so only trust the one inside
// `caa_password_encryption_data`.
function getPasswordEncryptionKey(html) {
  var index = html.indexOf('"caa_password_encryption_data"');
  if (index === -1) return null;

  var blob = html.slice(index, index + 400);
  var key = /"public_?[kK]ey":"([0-9a-fA-F]+)"/.exec(blob);
  var id = /"key_?[iI]d":\s*"?(\d+)"?/.exec(blob);
  if (!key || !id) return null;

  return { keyId: id[1], publicKey: key[1] };
}

// Handles the response of the login mutation: either the new session is
// already in the jar, or Facebook wants login approvals / two-step
// verification before it will let us in.
function handleWebLoginResponse(res, jar, email, password, loginOptions, callback) {
  var data;
  try {
    data = JSON.parse(res.body).data.caa_login_web;
  } catch (e) {
    throw {error: "Received an unexpected response from Facebook while logging in."};
  }

  var redirect = data.redirect_uri || "";
  var loggedIn = jar.getCookies("https://www.facebook.com").some(function(c) {
    return c.key === "c_user";
  });

  // Note: the two-step/checkpoint response also carries error_code 1348009,
  // so the redirect has to win over the error code.
  var approvalRequired =
    redirect.indexOf("two_step_verification") > -1 ||
    redirect.indexOf("checkpoint") > -1;
  if (approvalRequired && !loggedIn) {
    log.info("login", "You have login approvals turned on.");
    return handleLoginApproval(redirect, jar, email, password, loginOptions, callback);
  }

  if (loggedIn || !data.error_code) {
    return utils
      .get("https://www.facebook.com/", jar, null, loginOptions)
      .then(utils.saveCookies(jar));
  }

  if (data.error_code === 1348009) {
    throw {error: "Wrong username/password."};
  }

  throw {
    error:
      (data.error_message && data.error_message.text) ||
      ("Login failed with error " + data.error_code + ".")
  };
}

// Best-effort handling of the two-step verification / checkpoint page.
// Facebook now renders that page as a React app whose code submission cannot
// be replayed with plain requests (it can require an interactive security
// check first), so if the approval code does not produce a session we report a
// clear error instead of pretending the two-factor code was rejected.
function handleLoginApproval(approvalURL, jar, email, password, loginOptions, callback) {
  return utils
    .get(approvalURL, jar, null, loginOptions)
    .then(utils.saveCookies(jar))
    .then(function(res) {
      var html = res.body;
      var $ = loadHTML(html);
      var arr = [];
      $("form input").map(function(i, v) {
        arr.push({ val: $(v).val(), name: $(v).attr("name") });
      });
      arr = arr.filter(function(v) {
        return v.val && v.val.length;
      });
      var form = utils.arrToForm(arr);

      function submitApproval(code) {
        form.approvals_code = code;
        form["submit[Continue]"] = "Continue";
        return utils
          .post(approvalURL, jar, form, loginOptions)
          .then(utils.saveCookies(jar))
          .then(function() {
            var appState = utils.getAppState(jar);
            var loggedIn = appState.some(function(c) {
              return c.key === "c_user";
            });
            if (!loggedIn) {
              throw {
                error:
                  "Facebook is asking for an interactive security check " +
                  "(CAPTCHA) before it accepts the two-factor code, so the " +
                  "login cannot be completed automatically. Log in once with " +
                  "a browser and use appState, or retry from a trusted " +
                  "network/device.",
                twoFactorRequired: true
              };
            }
            return loginHelper(appState, email, password, loginOptions, callback);
          });
      }

      if (loginOptions.twoFactorSecret) {
        log.info("login", "Login approval required, generating a 2FA code.");
        return submitApproval(utils.generateTOTP(loginOptions.twoFactorSecret));
      }

      throw {
        error: "login-approval",
        continue: submitApproval
      };
    });
}

// Reads the persisted mobile device identity, if any. The mobile endpoint
// binds two-factor challenges and "approve this login" prompts to a device, so
// reusing it makes approvals survive between runs.
function loadMobileDevice(loginOptions) {
  if (!loginOptions.mobileDevicePath) return {};
  try {
    if (fs.existsSync(loginOptions.mobileDevicePath)) {
      return JSON.parse(fs.readFileSync(loginOptions.mobileDevicePath, "utf8"));
    }
  } catch (e) {
    log.warn("login", "Could not read mobile device file: " + e.message);
  }
  return {};
}

function saveMobileDevice(device, loginOptions) {
  if (!loginOptions.mobileDevicePath) return;
  try {
    // Owner-only, like e2ee_device.json: the ids let this client pass as an
    // already-approved device.
    fs.writeFileSync(loginOptions.mobileDevicePath, JSON.stringify(device, null, 2), { mode: 384 });
    // `mode` only applies when the file is created; tighten older files too.
    fs.chmodSync(loginOptions.mobileDevicePath, 384);
  } catch (e) {
    log.warn("login", "Could not save mobile device file: " + e.message);
  }
}

// Copies cookies from an appState into the jar, optionally skipping some
// names (e.g. the auth cookies when a fresh password login is wanted while the
// device cookies should be kept).
function setAppStateCookies(jar, appState, skip) {
  appState.forEach(function(c) {
    var key = c.key || c.name;
    if (!key || c.value == undefined) return;
    if (skip && skip.indexOf(key) > -1) return;
    var domain = c.domain || ".facebook.com";
    var url = domain.indexOf("messenger.com") > -1
      ? "https://www.messenger.com"
      : "https://www.facebook.com";
    try {
      jar.setCookie(
        key + "=" + c.value + "; domain=" + domain + "; path=" + (c.path || "/") + ";",
        url
      );
    } catch (e) {
      log.warn("login", "Skipping cookie " + key + ": " + e.message);
    }
  });
}

// Logs in through the mobile app's auth endpoint, which — unlike the web
// login — reports a pending two-factor challenge explicitly and accepts a TOTP
// code as a parameter. On success the returned session cookies are stored in
// the jar and the homepage is loaded so the normal login flow can continue.
function mobileLogin(jar, email, password, loginOptions) {
  function describeMobileError(err) {
    return {
      error: err.error_user_msg || err.message || "Mobile login failed.",
      code: err.code,
      subcode: err.error_subcode
    };
  }

  function storeSessionCookies(res) {
    var cookies = res.session_cookies;
    if (typeof cookies === "string") {
      try {
        cookies = JSON.parse(cookies);
      } catch (e) { /* leave it as-is and fail below */ }
    }
    if (!Array.isArray(cookies) || cookies.length === 0) {
      throw {
        error:
          "Facebook reported a successful mobile login but returned no " +
          "session cookies."
      };
    }

    cookies.forEach(function(c) {
      var name = c.name || c.key;
      if (!name || c.value == undefined) return;
      jar.setCookie(
        name + "=" + c.value + "; domain=" + (c.domain || ".facebook.com") +
          "; path=" + (c.path || "/") + ";",
        "https://www.facebook.com"
      );
    });

    var hasLoginCookie = jar.getCookies("https://www.facebook.com").some(function(c) {
      return c.key === "c_user";
    });
    if (!hasLoginCookie) {
      throw { error: "The mobile login response did not contain a usable session." };
    }

    return utils
      .get("https://www.facebook.com/", jar, null, loginOptions)
      .then(utils.saveCookies(jar));
  }

  // The mobile endpoint ties two-factor challenges and "approve this login"
  // prompts to a device identity, so the same one must be used for the
  // password request, the two-factor retry and future logins. It is persisted
  // to `mobileDevicePath` (default ./mobile_device.json).
  var device = loadMobileDevice(loginOptions);

  log.info("login", "Logging in through the mobile login endpoint...");
  var passwordRequest = utils.mobileAuth(email, password, null, null, device);
  saveMobileDevice(device, loginOptions);
  return passwordRequest.then(function(res) {
    if (!res.error) {
      return storeSessionCookies(res);
    }

    var err = res.error;
    if (err.code === 406 || err.error_subcode === 1348162) {
      log.info("login", "You have login approvals turned on.");
      var context = err.error_data || {};

      var submitCode = function(code) {
        return utils.mobileAuth(email, password, code, context, device).then(function(res2) {
          if (res2.error) {
            throw describeMobileError(res2.error);
          }
          return storeSessionCookies(res2);
        });
      };

      if (loginOptions.twoFactorSecret) {
        log.info("login", "Generating a 2FA code from twoFactorSecret.");
        return submitCode(utils.generateTOTP(loginOptions.twoFactorSecret));
      }
      throw { error: "login-approval", continue: submitCode };
    }

    if (err.code === 401 || err.error_subcode === 1348131) {
      throw { error: "Wrong username/password." };
    }
    throw describeMobileError(err);
  });
}

// Helps the login
function loginHelper(appState, email, password, globalOptions, callback) {
  var mainPromise = null;
  var jar = utils.getJar();

  // appState + credentials: refresh the login on the *same* browser device.
  // The device cookies (datr, sb, ...) make Facebook recognize the client as
  // an existing browser instead of a brand-new device, while the auth cookies
  // (c_user, xs, fr) are dropped so the password login re-authenticates. This
  // avoids the "unrecognized device" checkpoint/lock that a fresh client hits.
  if (appState && email && password) {
    if (!Array.isArray(appState)) {
      return callback({
        error:
          "appState must be an array of cookie objects (e.g. the array " +
          "returned by api.getAppState() or exported from your browser). " +
          "Received type: " + utils.getType(appState) + "."
      });
    }

    log.info("login", "Refreshing login for the appState's browser device...");
    setAppStateCookies(jar, appState, ["c_user", "xs", "fr"]);
    mainPromise = utils
      .get("https://www.facebook.com/", jar, null, globalOptions)
      .then(utils.saveCookies(jar))
      .then(makeLogin(jar, email, password, globalOptions, callback))
      .then(function() {
        return utils
          .get("https://www.facebook.com/", jar, null, globalOptions)
          .then(utils.saveCookies(jar));
      })
      .catch(function(err) {
        if (globalOptions.mobileLogin && (err.twoFactorRequired || err.error === "login-approval")) {
          log.info("login", "Device login needs a two-factor check; falling back to the mobile endpoint.");
          return mobileLogin(jar, email, password, globalOptions);
        }
        throw err;
      });
  } else if(appState) {
    // Validate/normalize the appState before trusting it, so a malformed or
    // expired export fails with a clear message instead of silently building
    // a jar that isn't actually logged in (which surfaces much later as a
    // confusing "Not logged in." from parseAndCheckLogin).
    if (!Array.isArray(appState)) {
      return callback({
        error:
          "appState must be an array of cookie objects (e.g. the array " +
          "returned by api.getAppState() or exported from your browser). " +
          "Received type: " + utils.getType(appState) + "."
      });
    }

    // Browser cookie exporters use `name`; api.getAppState() uses `key`.
    // Accept both by normalizing `name` -> `key`, then require the essentials.
    var normalizeErr = null;
    appState = appState.map(function(c) {
      if ((c.key === undefined || c.key === null) && c.name != undefined) {
        c.key = c.name;
      }
      if (c.key == undefined || c.value == undefined || c.domain == undefined) {
        normalizeErr = {
          error:
            "appState contains a cookie missing key/value/domain. Re-export " +
            "a fresh appState and try again."
        };
      }
      return c;
    });
    if (normalizeErr) return callback(normalizeErr);

    var hasLoginCookie = appState.some(function(c) {
      return c.key === "c_user" || c.key === "i_user";
    });
    if (!hasLoginCookie) {
      return callback({
        error:
          "appState is missing the `c_user` login cookie, so it does not " +
          "represent a logged-in session. Log in with a browser, export a " +
          "fresh appState (after clearing any 2FA/checkpoint there), and try " +
          "again."
      });
    }

    appState.map(function(c) {
      var str = c.key + "=" + c.value + "; expires=" + c.expires + "; domain=" + c.domain + "; path=" + (c.path || "/") + ";";
      jar.setCookie(str, "http://" + c.domain);
    });

    // Load the main page.
    mainPromise = utils
      .get('https://www.facebook.com/', jar, null, globalOptions)
      .then(utils.saveCookies(jar));
  } else if (globalOptions.mobileLogin) {
    // The mobile endpoint reports the two-factor challenge explicitly and
    // accepts the TOTP code, so it is used whenever one is available.
    mainPromise = mobileLogin(jar, email, password, globalOptions);
  } else {
    // Open the main page, then we login with the given credentials and finally
    // load the main page again (it'll give us some IDs that we need)
    mainPromise = utils
      .get("https://www.facebook.com/", null, null, globalOptions)
      .then(utils.saveCookies(jar))
      .then(makeLogin(jar, email, password, globalOptions, callback))
      .then(function() {
        return utils
          .get('https://www.facebook.com/', jar, null, globalOptions)
          .then(utils.saveCookies(jar));
      });
  }

  var ctx = null;
  var defaultFuncs = null;
  var api = null;

  mainPromise = mainPromise
    .then(function(res) {
      // Hacky check for the redirection that happens on some ISPs, which doesn't return statusCode 3xx
      var reg = /<meta http-equiv="refresh" content="0;url=([^"]+)[^>]+>/;
      var redirect = reg.exec(res.body);
      if (redirect && redirect[1]) {
        return utils
          .get(redirect[1], jar, null, globalOptions)
          .then(utils.saveCookies(jar));
      }
      return res;
    })
    .then(function(res) {
      var html = res.body;
      var stuff = buildAPI(globalOptions, html, jar);
      ctx = stuff[0];
      defaultFuncs = stuff[1];
      api = stuff[2];
      return res;
    })
    .then(function() {
      // Legacy presence ping. Its response is empty and nothing reads it, so
      // send it in the background instead of adding a round trip to login.
      log.info("login", 'Request to reconnect');
      defaultFuncs
        .get("https://www.facebook.com/ajax/presence/reconnect.php", ctx.jar, {reason: 6})
        .then(utils.saveCookies(ctx.jar))
        .catch(function(err) {
          log.verbose("login", "Presence reconnect failed: " + (err && err.message || err));
        });
    })
    .then(function() {
      var presence = utils.generatePresence(ctx.userID);
      ctx.jar.setCookie("presence=" + presence + "; path=/; domain=.facebook.com; secure", "https://www.facebook.com");
      ctx.jar.setCookie("presence=" + presence + "; path=/; domain=.messenger.com; secure", "https://www.messenger.com");
      ctx.jar.setCookie("locale=en_US; path=/; domain=.facebook.com; secure", "https://www.facebook.com");
      ctx.jar.setCookie("locale=en_US; path=/; domain=.messenger.com; secure", "https://www.messenger.com");
      ctx.jar.setCookie("a11y=" + utils.generateAccessiblityCookie() + "; path=/; domain=.facebook.com; secure", "https://www.facebook.com");
      return true;
    });

  // given a pageID we log in as a page
  if (globalOptions.pageID) {
    mainPromise = mainPromise
      .then(function() {
        return utils
          .get('https://www.facebook.com/' + ctx.globalOptions.pageID + '/messages/?section=messages&subsection=inbox', ctx.jar, null, globalOptions);
      })
      .then(function(resData) {
        var url = utils.getFrom(resData.body, 'window.location.replace("https:\\/\\/www.facebook.com\\', '");').split('\\').join('');
        url = url.substring(0, url.length - 1);

        return utils
          .get('https://www.facebook.com' + url, ctx.jar, null, globalOptions);
      });
  }

  // At the end we call the callback or catch an exception
  mainPromise
    .then(function() {
      log.info("login", 'Done logging in.');
      return callback(null, api);
    })
    .catch(function(e) {
      log.error("login", e.error || e);
      callback(e);
    });
}

function login(loginData, options, callback) {
  if(utils.getType(options) === 'Function' || utils.getType(options) === 'AsyncFunction') {
    callback = options;
    options = {};
  }

  var globalOptions = {
    selfListen: false,
    listenEvents: false,
    updatePresence: false,
    forceLogin: false,
    autoMarkDelivery: true,
    autoMarkRead: false,
    logRecordSize: defaultLogRecordSize,
    e2eeDevicePath: require("path").join(process.cwd(), "e2ee_device.json"),
    // Device identity used for the mobile login endpoint, persisted so
    // Facebook's "approve this login" prompts stay bound to one device.
    mobileDevicePath: require("path").join(process.cwd(), "mobile_device.json"),
    // Facebook redirects old browsers (e.g. Safari 8) to /unsupportedbrowser,
    // which has no usable session data, so keep this reasonably current.
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"
  };

  setOptions(globalOptions, options);

  // Optional: base32 TOTP secret (the one authenticator apps are set up with)
  // so login approvals can be answered automatically.
  if (loginData.twoFactorSecret) {
    globalOptions.twoFactorSecret = loginData.twoFactorSecret;
  }

  // The mobile login endpoint is the only credential flow that can complete a
  // two-factor login programmatically, so it is the default whenever a
  // twoFactorSecret is given. Pass `mobileLogin: false` to force the web flow
  // (which then reports `login-approval` / `twoFactorRequired` instead).
  globalOptions.mobileLogin =
    loginData.mobileLogin === true ||
    (loginData.mobileLogin !== false && !!loginData.twoFactorSecret);

  loginHelper(loginData.appState, loginData.email, loginData.password, globalOptions, callback);
}

module.exports = login;

