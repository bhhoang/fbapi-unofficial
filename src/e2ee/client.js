"use strict";

/* global BigInt */

var http = require("../http");
var fs = require("fs");
var log = require("npmlog");
var utils = require("../../utils");

var proto = require("./proto");
var binary = require("./binary");
var cryptoUtils = require("./crypto");
var noise = require("./noise");
var signal = require("./signal");
var mediaLib = require("./media");
var DeviceStore = require("./store").DeviceStore;

var CAT_DOC_ID = "23999698219677129";
var ICDC_HOST = "https://reg-e2ee.facebook.com/v2";
var ICDC_APP_ID = "2220391788200892";
var E2EE_ENDPOINT = "wss://web-chat-e2ee.facebook.com/ws/chat";
var ICDC_USER_AGENT =
  "Facebook Messenger/441.1.0.32.115 (Android 13; 480dpi; 1080x2236; Xiaomi; 2210132G; cupid; qcom; en_US; 555627749)";
var WS_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
var FB_MESSAGE_APPLICATION_VERSION = 2;
var FB_CONSUMER_MESSAGE_VERSION = 1;
var MIN_PREKEY_COUNT = 5;
var PREKEY_UPLOAD_COUNT = 50;

function encodeClientPayload(opts) {
  var appVersion = new proto.ProtoWriter().varint(1, 301).varint(2, 0).varint(3, 2).build();
  var userAgent = new proto.ProtoWriter()
    .varint(1, 32)
    .bytes(2, appVersion)
    .string(3, "000")
    .string(4, "000")
    .string(5, "")
    .string(6, "Linux")
    .string(7, "Chrome")
    .string(8, "")
    .varint(10, 3)
    .string(11, "en")
    .string(12, "en")
    .build();
  return new proto.ProtoWriter()
    .uint64(1, BigInt(opts.username))
    .bool(3, false)
    .bytes(5, userAgent)
    .varint(12, 1)
    .varint(13, 1)
    .varint(18, opts.deviceId)
    .varint(20, 1)
    .bytes(21, Buffer.from(opts.fbCatBase64 || ""))
    .bytes(22, Buffer.from(WS_USER_AGENT))
    .bool(33, true)
    .build();
}

function encodeTextMessage(text) {
  var msgText = new proto.ProtoWriter().string(1, text).build();
  var content = new proto.ProtoWriter().bytes(1, msgText).build();
  var payload = new proto.ProtoWriter().bytes(1, content).build();
  return new proto.ProtoWriter().bytes(1, payload).build();
}

function generatePadding() {
  var len = require("crypto").randomBytes(1)[0] & 255 || 1;
  var pad = require("crypto").randomBytes(len);
  pad[len - 1] = len;
  return pad;
}

function encodeMessageTransport(opts) {
  var padding = generatePadding();
  var payload;
  if (opts.messageApp) {
    var appPayload = new proto.ProtoWriter()
      .bytes(1, opts.messageApp)
      .varint(2, FB_MESSAGE_APPLICATION_VERSION)
      .build();
    payload = new proto.ProtoWriter().bytes(1, appPayload).varint(3, 0).build();
  }
  var integral = new proto.ProtoWriter().bytes(1, padding);
  if (opts.dsm) {
    var dsm = new proto.ProtoWriter()
      .string(1, opts.dsm.destinationJid)
      .string(2, opts.dsm.phash || "")
      .build();
    integral.bytes(2, dsm);
  }
  var protocol = new proto.ProtoWriter().bytes(1, integral.build()).bytes(2, Buffer.alloc(0)).build();
  var transport = new proto.ProtoWriter();
  if (payload) transport.bytes(1, payload);
  return transport.bytes(2, protocol).build();
}

function encodeMessageApplication(consumerApp) {
  var frankingKey = require("crypto").randomBytes(32);
  var subProtocol = new proto.ProtoWriter()
    .bytes(1, consumerApp)
    .varint(2, FB_CONSUMER_MESSAGE_VERSION)
    .build();
  var payloadSubProto = new proto.ProtoWriter().varint(1, 0).bytes(2, subProtocol).build();
  var appPayload = new proto.ProtoWriter().bytes(4, payloadSubProto).build();
  var metadata = new proto.ProtoWriter().bytes(8, frankingKey).varint(9, 0).build();
  var messageApp = new proto.ProtoWriter().bytes(1, appPayload).bytes(2, metadata).build();
  var frankingTag = cryptoUtils.hmacSha256(frankingKey, messageApp);
  return { messageApp: messageApp, frankingTag: frankingTag };
}

function encodePreKeyNode(key, tag) {
  var idBuf = Buffer.alloc(4);
  idBuf.writeUInt32BE(key.id);
  var children = [
    binary.encodeNode("id", {}, idBuf.subarray(1)),
    binary.encodeNode("value", {}, key.pub)
  ];
  if (key.signature) children.push(binary.encodeNode("signature", {}, key.signature));
  return binary.encodeNode(tag, {}, children);
}

function encodePreKeyUpload(id, registrationId, identityPub, signedPreKey, preKeys) {
  var regBuf = Buffer.alloc(4);
  regBuf.writeUInt32BE(registrationId);
  var iq = binary.encodeNode(
    "iq",
    { id: id, to: "s.whatsapp.net", type: "set", xmlns: "encrypt" },
    [
      binary.encodeNode("registration", {}, regBuf),
      binary.encodeNode("type", {}, Buffer.from([5])),
      binary.encodeNode("identity", {}, identityPub),
      binary.encodeNode(
        "list",
        {},
        preKeys.map(function(key) {
          return encodePreKeyNode(key, "key");
        })
      ),
      encodePreKeyNode(signedPreKey, "skey")
    ]
  );
  return binary.marshal(iq);
}

function normalizeThreadJid(threadId) {
  var id = String(threadId);
  if (id.indexOf("@") !== -1) return id;
  if (id.indexOf(".") !== -1 || id.indexOf(":") !== -1) return id + "@msgr";
  return id + ".0@msgr";
}

function protocolMediaType(kind) {
  switch (kind) {
    case "image":
    case "sticker":
    case "gif":
    case "video":
    case "ptt":
    case "audio":
    case "document":
      return kind;
    default:
      return "document";
  }
}

function bareJid(jid) {
  var at = jid.indexOf("@");
  var userPart = at === -1 ? jid : jid.slice(0, at);
  var server = at === -1 ? "" : jid.slice(at + 1);
  var cut = userPart.indexOf(".");
  if (cut === -1) cut = userPart.indexOf(":");
  if (cut === -1) cut = userPart.length;
  return userPart.slice(0, cut) + ".0@" + server;
}

function summarizeNode(node) {
  if (node === null || node === undefined) return String(node);
  if (Buffer.isBuffer(node)) return "<" + node.length + " bytes>";
  return {
    tag: node.tag,
    attrs: node.attrs,
    content: Array.isArray(node.content) ? node.content.map(summarizeNode) : summarizeNode(node.content)
  };
}

function decodeConsumerContent(bytes) {
  try {
    var transport = proto.decodeFields(bytes);
    var payload = transport[1] ? proto.decodeFields(transport[1]) : null;
    var applicationPayload = payload && payload[1] ? proto.decodeFields(payload[1]) : null;
    if (!applicationPayload || !applicationPayload[1]) return null;
    var messageApp = proto.decodeFields(applicationPayload[1]);
    var appPayloadContainer = messageApp[1] ? proto.decodeFields(messageApp[1]) : null;
    var payloadSubProtocol = appPayloadContainer && appPayloadContainer[4]
      ? proto.decodeFields(appPayloadContainer[4])
      : null;
    var subProtocol = payloadSubProtocol && payloadSubProtocol[2]
      ? proto.decodeFields(payloadSubProtocol[2])
      : null;
    var consumerApp = subProtocol && subProtocol[1] ? proto.decodeFields(subProtocol[1]) : null;
    if (!consumerApp) return null;
    var consumerPayload = consumerApp[1] ? proto.decodeFields(consumerApp[1]) : null;
    if (!consumerPayload || !consumerPayload[1]) return null;
    var content = proto.decodeFields(consumerPayload[1]);
    if (content[1]) {
      var messageText = proto.decodeFields(content[1]);
      return {
        kind: "text",
        text: messageText[1] ? Buffer.from(messageText[1]).toString("utf8") : ""
      };
    }
    var media = mediaLib.parseConsumerMedia(consumerApp);
    if (media) return { kind: "media", media: media };
    return { kind: "other" };
  } catch (e) {
    return null;
  }
}

function decodeConsumerText(bytes) {
  var decoded = decodeConsumerContent(bytes);
  return decoded ? decoded : null;
}

var ATTACHMENT_TYPES = {
  image: "photo",
  video: "video",
  ptt: "audio",
  audio: "audio",
  document: "file",
  sticker: "sticker"
};

function toBase64(buffer) {
  if (!buffer) return null;
  return Buffer.from(buffer).toString("base64");
}

function buildAttachment(parsed) {
  var media = parsed.media;
  var attachment = {
    type: ATTACHMENT_TYPES[parsed.kind] || "file",
    filename: parsed.filename || null,
    mimeType: media.mimetype || null,
    size: media.fileLength || 0,
    e2ee: {
      kind: parsed.kind,
      serverMediaType: media.serverMediaType,
      directPath: media.directPath,
      mediaKey: toBase64(media.mediaKey),
      fileSha256: toBase64(media.fileSha256),
      fileEncSha256: toBase64(media.fileEncSha256),
      mediaKeyTimestamp: media.mediaKeyTimestamp,
      objectId: media.objectId,
      mimetype: media.mimetype,
      size: media.fileLength || 0
    }
  };
  if (media.width != null) attachment.width = media.width;
  if (media.height != null) attachment.height = media.height;
  if (media.duration != null) attachment.duration = media.duration;
  if (media.animated != null) attachment.animated = media.animated;
  if (media.gifPlayback != null) attachment.gifPlayback = media.gifPlayback;
  if (media.jpegThumbnail && media.jpegThumbnail.length) {
    attachment.preview = "data:image/jpeg;base64," + media.jpegThumbnail.toString("base64");
  }
  return attachment;
}

function decodeDsmDestination(bytes) {
  try {
    var transport = proto.decodeFields(bytes);
    var protocol = transport[2] ? proto.decodeFields(transport[2]) : null;
    var integral = protocol && protocol[1] ? proto.decodeFields(protocol[1]) : null;
    var dsm = integral && integral[2] ? proto.decodeFields(integral[2]) : null;
    return dsm && dsm[1] ? Buffer.from(dsm[1]).toString("utf8") : null;
  } catch (e) {
    return null;
  }
}

function findNode(node, tag) {
  if (!node) return null;
  if (node.tag === tag) return node;
  if (!Array.isArray(node.content)) return null;
  for (var i = 0; i < node.content.length; i++) {
    var found = findNode(node.content[i], tag);
    if (found) return found;
  }
  return null;
}

function E2EEClient(ctx, defaultFuncs) {
  this.ctx = ctx;
  this.defaultFuncs = defaultFuncs;
  this.store = null;
  this.socket = null;
  this.cat = null;
  this.connected = false;
  this.pendingIQs = {};
  this.connectPromise = null;
  this.heartbeatTimer = null;
  this.prekeyTimer = null;
  this.requestCounter = 0;
  this.mediaConn = null;
  this.mediaConnPromise = null;
}

E2EEClient.prototype.nextId = function(prefix) {
  this.requestCounter += 1;
  return prefix + Date.now() + "-" + this.requestCounter;
};

// Message IDs in the format Messenger's own clients use: milliseconds since
// the epoch shifted left 22 bits, plus 22 random bits. The server's message
// timestamp only has one-second resolution, so recipients order messages sent
// in the same second by this ID; random IDs made quick sends show up out of
// order. IDs also never repeat or go backwards within one client.
E2EEClient.prototype.nextMessageId = function() {
  var id = (BigInt(Date.now()) << BigInt(22)) | BigInt(require("crypto").randomInt(4194304));
  if (this.lastMessageId !== undefined && id <= this.lastMessageId) {
    id = this.lastMessageId + BigInt(1);
  }
  this.lastMessageId = id;
  return id.toString();
};

E2EEClient.prototype.cookieString = function() {
  return this.ctx.jar.getCookies("https://www.facebook.com").join("; ");
};

// When `e2eeFrameLog` is set, every decrypted incoming frame is appended to
// that file as JSONL ({ts, bytes, hex}), before it is parsed. This is a
// debugging aid for reverse-engineering server-side E2EE traffic (for example
// history-sync notifications), which cannot be reproduced from the source.
E2EEClient.prototype.recordFrame = function(frame) {
  var logPath = this.ctx.globalOptions && this.ctx.globalOptions.e2eeFrameLog;
  if (!logPath || !frame || !frame.length) return;
  var entry = { ts: Date.now(), bytes: frame.length, hex: frame.toString("hex") };
  try {
    var node = binary.unmarshal(frame);
    entry.tag = node.tag;
    entry.attrs = node.attrs;
    entry.children = Array.isArray(node.content)
      ? node.content.map(function(child) { return child && child.tag ? child.tag : typeof child; })
      : node.content && node.content.tag
        ? [node.content.tag]
        : undefined;
  } catch (e) { /* keep the raw hex only */ }
  try {
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", { mode: 384 });
  } catch (e) { /* ignore */ }
};

E2EEClient.prototype.isKnownE2EEThread = function(threadId) {
  if (!this.store) {
    try {
      this.store = DeviceStore.fromFile(this.ctx.globalOptions.e2eeDevicePath);
    } catch (e) {
      return false;
    }
  }
  return !!(this.store.threads && this.store.threads[String(threadId)]);
};

E2EEClient.prototype.fetchCat = function() {
  var userId = this.ctx.userID;
  var form = {
    fb_dtsg: this.ctx.fb_dtsg,
    variables: "{}",
    doc_id: CAT_DOC_ID,
    __user: userId,
    __a: "1",
    __jssesw: "1",
    server_timestamps: "true"
  };
  return this.defaultFuncs
    .post("https://www.facebook.com/api/graphql/", this.ctx.jar, form)
    .then(utils.parseAndCheckLogin(this.ctx, this.defaultFuncs))
    .then(function(resData) {
    var cat =
      resData &&
      resData.data &&
      resData.data.secure_message_over_wa_cat_query &&
      resData.data.secure_message_over_wa_cat_query.encrypted_serialized_cat;
    if (!cat) {
      throw new Error(
        "Could not fetch E2EE CAT token from Facebook: " + JSON.stringify(resData).slice(0, 500)
      );
    }
    return cat;
  });
};

E2EEClient.prototype.icdcPost = function(endpoint, form) {
  var self = this;
  return http
    .request({
      method: "POST",
      url: ICDC_HOST + "/" + endpoint,
      form: form,
      jar: self.ctx.jar,
      headers: {
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": ICDC_USER_AGENT,
        Origin: "https://www.messenger.com",
        Referer: "https://www.messenger.com/messages/"
      }
    })
    .then(function(res) {
      if (res.statusCode !== 200) {
        throw new Error("ICDC " + endpoint + " failed with HTTP " + res.statusCode + ": " + res.body);
      }
      try {
        return JSON.parse(res.body);
      } catch (err) {
        throw new Error("ICDC " + endpoint + " returned invalid JSON.", { cause: err });
      }
    });
};

E2EEClient.prototype.registerDevice = function(fbCat) {
  var self = this;
  var store = this.store;
  var fetchForm = {
    fbid: this.ctx.userID,
    device_id: store.facebookUUID,
    app_id: ICDC_APP_ID,
    fb_cat: fbCat
  };
  return this.icdcPost("fb_icdc_fetch", fetchForm).then(function(fetchResp) {
    if (fetchResp.status !== 200) {
      throw new Error("ICDC fetch failed with status " + fetchResp.status);
    }
    var identities = (fetchResp.device_identities || []).map(function(id) {
      return Buffer.from(id, "base64");
    });
    var ownIdentity = store.identityPublic();
    var ownIndex = -1;
    for (var i = 0; i < identities.length; i++) {
      if (Buffer.compare(identities[i], ownIdentity) === 0) {
        ownIndex = i;
        break;
      }
    }
    var seq = fetchResp.icdc_seq;
    if (ownIndex === -1) {
      ownIndex = identities.length;
      identities.push(ownIdentity);
      seq += 1;
    }
    var timestamp = Math.floor(Date.now() / 1000);
    var details = new proto.ProtoWriter()
      .varint(1, seq)
      .uint64(2, BigInt(timestamp));
    identities.forEach(function(identity) {
      details.bytes(3, identity);
    });
    details.varint(4, ownIndex);
    var unsignedList = details.build();
    var signature = cryptoUtils.xeddsaSign(store.identityKeyPair.priv, unsignedList);
    var signedList = new proto.ProtoWriter().bytes(1, unsignedList).bytes(2, signature).build();

    var sorted = identities.slice().sort(Buffer.compare);
    var hash = cryptoUtils.sha256(Buffer.concat(sorted)).subarray(0, 10);

    var regBuf = Buffer.alloc(4);
    regBuf.writeUInt32BE(store.registrationId);
    var skeyId = Buffer.alloc(4);
    skeyId.writeUInt32BE(store.signedPreKey.id);
    var registerForm = {
      fbid: self.ctx.userID,
      fb_cat: fbCat,
      app_id: ICDC_APP_ID,
      device_id: store.facebookUUID,
      e_regid: regBuf.toString("base64"),
      e_keytype: Buffer.from([5]).toString("base64"),
      e_ident: ownIdentity.toString("base64"),
      e_skey_id: skeyId.subarray(1).toString("base64"),
      e_skey_val: store.signedPreKey.pub,
      e_skey_sig: store.signedPreKey.signature,
      icdc_list: signedList.toString("base64"),
      icdc_ts: String(timestamp),
      icdc_seq: String(seq),
      ihash: hash.toString("base64")
    };
    return self.icdcPost("fb_register_v2", registerForm).then(function(registerResp) {
      if (registerResp.status !== 200) {
        throw new Error("ICDC register failed with status " + registerResp.status);
      }
      return registerResp.wa_device_id;
    });
  });
};

E2EEClient.prototype.sendNode = function(node) {
  var self = this;
  var body = Buffer.isBuffer(node) ? node : binary.encodeNode(node.tag, node.attrs, node.content);
  var buf = Buffer.concat([Buffer.from([0]), body]);
  return new Promise(function(resolve, reject) {
    try {
      self.socket.sendFrame(buf);
      resolve();
    } catch (err) {
      reject(err);
    }
  });
};

E2EEClient.prototype.requestIQ = function(iq, timeoutMs) {
  var self = this;
  var id = iq.attrs.id;
  return new Promise(function(resolve, reject) {
    var timer = setTimeout(function() {
      delete self.pendingIQs[id];
      reject(new Error("E2EE IQ timeout: " + id));
    }, timeoutMs || 10000);
    self.pendingIQs[id] = {
      resolve: function(node) {
        clearTimeout(timer);
        resolve(node);
      },
      reject: function(err) {
        clearTimeout(timer);
        reject(err);
      }
    };
    self.sendNode(iq).catch(function(err) {
      clearTimeout(timer);
      delete self.pendingIQs[id];
      reject(err);
    });
  });
};

E2EEClient.prototype.getDeviceList = function(userJids) {
  var id = this.nextId("");
  var iq = {
    tag: "iq",
    attrs: { id: id, to: "s.whatsapp.net", type: "get", xmlns: "fbid:devices" },
    content: [
      {
        tag: "users",
        attrs: {},
        content: userJids.map(function(jid) {
          return { tag: "user", attrs: { jid: jid } };
        })
      }
    ]
  };
  return this.requestIQ(iq).then(function(res) {
    var usersNode = binary.findChild(res, "users");
    var deviceJids = [];
    if (!usersNode || !Array.isArray(usersNode.content)) return deviceJids;
    usersNode.content.forEach(function(userNode) {
      if (!userNode || userNode.tag !== "user" || !Array.isArray(userNode.content)) return;
      var devicesNode = binary.findChild(userNode, "devices");
      if (!devicesNode || !Array.isArray(devicesNode.content)) return;
      var parsed = signal.parseJid(userNode.attrs.jid);
      devicesNode.content.forEach(function(deviceNode) {
        if (deviceNode && deviceNode.tag === "device" && deviceNode.attrs.id) {
          deviceJids.push(parsed.user + "." + deviceNode.attrs.id + "@" + parsed.server);
        }
      });
    });
    return deviceJids;
  });
};

// Optional cache of users' device lists (globalOptions.e2eeDeviceListCacheMs).
// Fetching the list is a server round trip on every encrypted send. Caching
// it makes repeat sends much faster, but a device the recipient adds while
// its list is cached won't get those messages, so it is off by default.
function deviceListKey(jid) {
  var parsed = signal.parseJid(jid);
  return parsed.user + "@" + parsed.server;
}

E2EEClient.prototype.getDeviceListCached = function(userJids) {
  var self = this;
  var ttl = Number(this.ctx.globalOptions && this.ctx.globalOptions.e2eeDeviceListCacheMs) || 0;
  if (ttl <= 0) return this.getDeviceList(userJids);
  this.deviceListCache = this.deviceListCache || {};
  var now = Date.now();
  var cached = [];
  var missing = [];
  userJids.forEach(function(jid) {
    var entry = self.deviceListCache[deviceListKey(jid)];
    if (entry && now - entry.at < ttl) cached = cached.concat(entry.devices);
    else missing.push(jid);
  });
  if (missing.length === 0) return Promise.resolve(cached);
  return this.getDeviceList(missing).then(function(devices) {
    var at = Date.now();
    missing.forEach(function(jid) {
      var key = deviceListKey(jid);
      self.deviceListCache[key] = {
        at: at,
        devices: devices.filter(function(device) { return deviceListKey(device) === key; })
      };
    });
    return cached.concat(devices);
  });
};

E2EEClient.prototype.forgetDeviceList = function(jid) {
  if (this.deviceListCache) delete this.deviceListCache[deviceListKey(jid)];
};

E2EEClient.prototype.getPreKeyBundle = function(jid) {
  var id = this.nextId("pkb-");
  var iq = {
    tag: "iq",
    attrs: { id: id, to: "s.whatsapp.net", type: "get", xmlns: "encrypt" },
    content: [{ tag: "key", attrs: {}, content: [{ tag: "user", attrs: { jid: jid } }] }]
  };
  return this.requestIQ(iq).then(function(res) {
    var userNode = binary.findDescendant(res, "user");
    if (!userNode) {
      throw new Error("Missing user node in prekey bundle for " + jid + ": " + JSON.stringify(summarizeNode(res)));
    }
    return parsePreKeyBundle(userNode, jid, res);
  });
};

// Fetches the prekey bundles of several devices with one request, the way the
// WhatsApp protocol allows. The server answers per-device requests one after
// another (about a second each), so opening sessions to a contact's devices
// one request at a time was the slowest part of a first message. Resolves to
// {jid: bundle | Error}. Devices missing from the answer, or the whole batch
// failing, fall back to the per-device request.
E2EEClient.prototype.getPreKeyBundles = function(jids) {
  var self = this;
  if (jids.length === 1) {
    return this.getPreKeyBundle(jids[0]).then(
      function(bundle) { var r = {}; r[jids[0]] = bundle; return r; },
      function(err) { var r = {}; r[jids[0]] = err; return r; }
    );
  }
  var iq = {
    tag: "iq",
    attrs: { id: this.nextId("pkb-"), to: "s.whatsapp.net", type: "get", xmlns: "encrypt" },
    content: [{
      tag: "key",
      attrs: {},
      content: jids.map(function(jid) { return { tag: "user", attrs: { jid: jid } }; })
    }]
  };
  var byAddress = {};
  jids.forEach(function(jid) { byAddress[signal.addressKey(jid)] = jid; });
  return this.requestIQ(iq).then(
    function(res) {
      var results = {};
      collectNodes(res, "user").forEach(function(userNode) {
        var jid = userNode.attrs && userNode.attrs.jid && byAddress[signal.addressKey(userNode.attrs.jid)];
        if (!jid) return;
        try {
          results[jid] = parsePreKeyBundle(userNode, jid);
        } catch (err) {
          results[jid] = err;
        }
      });
      return results;
    },
    function(err) {
      log.verbose("e2ee", "Batched prekey fetch failed, fetching per device: " + (err && err.message));
      return {};
    }
  ).then(function(results) {
    var missing = jids.filter(function(jid) { return !results[jid]; });
    return Promise.all(missing.map(function(jid) {
      return self.getPreKeyBundle(jid).then(
        function(bundle) { results[jid] = bundle; },
        function(err) { results[jid] = err; }
      );
    })).then(function() { return results; });
  });
};

function collectNodes(node, tag, out) {
  out = out || [];
  if (!node || typeof node !== "object") return out;
  if (node.tag === tag) {
    out.push(node);
    return out;
  }
  if (Array.isArray(node.content)) {
    node.content.forEach(function(child) { collectNodes(child, tag, out); });
  }
  return out;
}

function parsePreKeyBundle(userNode, jid, keyScope) {
  var keyNode = binary.findDescendant(keyScope || userNode, "key");
  if (!keyNode) {
    throw new Error("Missing key node in prekey bundle for " + jid + ": " + JSON.stringify(summarizeNode(userNode)));
  }
  var registration = binary.findChild(userNode, "registration");
  var identity = binary.findChild(userNode, "identity");
  var skey = binary.findChild(userNode, "skey");
  if (!registration || !identity || !skey) {
    throw new Error(
      "Incomplete prekey bundle for " + jid + ": " + JSON.stringify(summarizeNode(userNode))
    );
  }
  var key = binary.findChild(keyNode, "key") || keyNode;
  var preKeyId = binary.findChild(key, "id");
  var preKeyValue = binary.findChild(key, "value");
  var signedId = binary.findChild(skey, "id");
  var signedValue = binary.findChild(skey, "value");
  var signedSig = binary.findChild(skey, "signature");
  var readId = function(node) {
    if (!node || !Buffer.isBuffer(node.content) || node.content.length === 0) return 0;
    return node.content.readUIntBE(0, Math.min(node.content.length, 3));
  };
  var prefixed = function(node) {
    var buf = Buffer.from(node.content);
    return buf.length === 32 ? Buffer.concat([Buffer.from([5]), buf]) : buf;
  };
  var parsed = signal.parseJid(jid);
  var bundle = {
    registrationId: registration.content.readUInt32BE(0),
    deviceId: parsed.device,
    identityKey: Buffer.from(identity.content),
    signedPreKey: {
      keyId: readId(signedId),
      publicKey: prefixed(signedValue),
      signature: Buffer.from(signedSig.content)
    }
  };
  if (preKeyValue && Buffer.isBuffer(preKeyValue.content)) {
    bundle.preKey = {
      keyId: readId(preKeyId),
      publicKey: prefixed(preKeyValue)
    };
  }
  return bundle;
}

E2EEClient.prototype.getServerPreKeyCount = function() {
  var id = this.nextId("pkc-");
  var iq = {
    tag: "iq",
    attrs: { id: id, to: "s.whatsapp.net", type: "get", xmlns: "encrypt" },
    content: [{ tag: "count", attrs: {} }]
  };
  return this.requestIQ(iq, 5000).then(
    function(res) {
      var count = binary.findDescendant(res, "count");
      return count ? parseInt(count.attrs.value || "0", 10) : 0;
    },
    function() {
      return 0;
    }
  );
};

E2EEClient.prototype.uploadPreKeys = function(count) {
  var preKeys = this.store.generatePreKeys(count);
  var signed = this.store.rotateSignedPreKey();
  var payload = encodePreKeyUpload(
    this.nextId("pk-"),
    this.store.registrationId,
    this.store.identityPublic(),
    { id: signed.id, pub: Buffer.from(signed.pub, "base64"), signature: Buffer.from(signed.signature, "base64") },
    preKeys.map(function(key) {
      return { id: key.id, pub: key.pub };
    })
  );
  return this.socket.sendFrame(payload);
};

E2EEClient.prototype.syncPreKeys = function() {
  var self = this;
  return self
    .getServerPreKeyCount()
    .then(function(count) {
      if (count < MIN_PREKEY_COUNT) return self.uploadPreKeys(PREKEY_UPLOAD_COUNT);
    })
    .catch(function(err) {
      log.warn("e2ee", "Prekey sync failed: " + err.message);
    });
};

E2EEClient.prototype.handleFrame = function(frame) {
  if (!frame || frame.length === 0) return;
  this.recordFrame(frame);
  var node;
  try {
    node = binary.unmarshal(frame);
  } catch (e) {
    return;
  }
  if (node.tag === "success") {
    if (node.attrs.jid) {
      var parsed = signal.parseJid(node.attrs.jid);
      if (parsed.user) this.store.jidUser = parsed.user;
      if (parsed.device) this.store.jidDevice = parsed.device;
      this.store.save();
    }
    return;
  }
  if (node.tag === "iq") {
    this.handleIQ(node);
    return;
  }
  if (node.tag === "failure") {
    log.warn("e2ee", "E2EE socket reported a failure: " + (node.attrs.reason || "unknown"));
    return;
  }
  if (node.tag === "message" || node.tag === "appdata") {
    this.handleEncryptedMessage(node);
    return;
  }
  if (node.tag === "notification") {
    this.handleNotification(node);
    return;
  }
  if (node.tag === "receipt") {
    this.handleReceipt(node);
    return;
  }
  this.sendAck(node);
};

E2EEClient.prototype.handleEncryptedMessage = function(node) {
  var senderJid = node.attrs.participant || node.attrs.from;
  var enc = null;
  if (Array.isArray(node.content)) {
    node.content.forEach(function(child) {
      if (child && child.tag === "enc" && !enc) enc = child;
    });
  } else if (node.content && node.content.tag === "enc") {
    enc = node.content;
  }
  if (!enc || !Buffer.isBuffer(enc.content)) {
    // Group / SKDM distribution frames are not supported; just acknowledge.
    this.sendAck(node);
    return;
  }

  var plaintext;
  try {
    if (enc.attrs.type === "pkmsg") {
      plaintext = signal.decryptPreKey(this.store, senderJid, enc.content);
    } else if (enc.attrs.type === "msg") {
      plaintext = signal.decryptMessage(this.store, senderJid, enc.content);
    } else {
      this.sendAck(node);
      return;
    }
  } catch (err) {
    log.warn("e2ee", "Could not decrypt E2EE message from " + senderJid + ": " + err.message);
    this.sendRetryReceipt(node);
    this.sendAck(node);
    return;
  }

  var payload = decodeConsumerContent(plaintext);
  var chatJid = decodeDsmDestination(plaintext) || node.attrs.from;
  var threadId = signal.parseJid(chatJid).user;
  var senderId = signal.parseJid(senderJid).user;
  var messageId = node.attrs.id || null;

  if (payload && (payload.kind === "text" || payload.kind === "media") && threadId) {
    var body = payload.kind === "text" ? payload.text : payload.media.caption || "";
    var attachments = payload.kind === "media" ? [buildAttachment(payload.media)] : [];
    var message = {
      type: "message",
      attachments: attachments,
      body: body,
      isGroup: false,
      messageID: messageId,
      senderID: senderId,
      threadID: String(threadId),
      timestamp: Date.now(),
      mentions: {},
      isUnread: false
    };
    if (payload.kind === "media") {
      message.isMedia = true;
      message.e2eeMedia = attachments[0].e2ee;
    }
    this.store.threads[String(threadId)] = true;
    this.store.appendHistory(threadId, {
      messageID: messageId,
      threadID: String(threadId),
      senderID: senderId,
      timestamp: message.timestamp,
      body: body
    });
    this.store.save();
    if (
      this.ctx.globalCallback &&
      (senderId !== this.ctx.userID || this.ctx.globalOptions.selfListen)
    ) {
      this.ctx.globalCallback(null, message);
    }
  }

  this.sendAck(node);
};

E2EEClient.prototype.sendRetryReceipt = function(node) {
  if (!node.attrs || !node.attrs.id || !node.attrs.from) return;
  var self = this;
  var regBuf = Buffer.alloc(4);
  regBuf.writeUInt32BE(this.store.registrationId);
  var receiptAttrs = { id: node.attrs.id, to: node.attrs.from, type: "retry" };
  if (node.attrs.participant) receiptAttrs.participant = node.attrs.participant;
  this.buildRetryKeysNode()
    .then(function(keysNode) {
      return self.sendNode(
        binary.encodeNode("receipt", receiptAttrs, [
          binary.encodeNode("retry", {
            count: "1",
            id: node.attrs.id,
            t: String(Math.floor(Date.now() / 1000)),
            v: "1"
          }),
          binary.encodeNode("registration", {}, regBuf),
          keysNode
        ])
      );
    })
    .catch(function(err) {
      log.warn("e2ee", "Could not send retry receipt: " + err.message);
    });
};

function keyIdBytes(id) {
  var buf = Buffer.alloc(4);
  buf.writeUInt32BE(id);
  return buf.subarray(1);
}

E2EEClient.prototype.buildRetryKeysNode = function() {
  var preKey = this.store.generatePreKeys(1)[0];
  var signed = this.store.signedPreKey;
  var deviceIdentity = new proto.ProtoWriter()
    .bytes(1, Buffer.alloc(0))
    .bytes(2, Buffer.alloc(32))
    .bytes(3, Buffer.alloc(64))
    .bytes(4, Buffer.alloc(64))
    .build();
  return Promise.resolve(
    binary.encodeNode("keys", {}, [
      binary.encodeNode("type", {}, Buffer.from([5])),
      binary.encodeNode("identity", {}, this.store.identityPublic()),
      binary.encodeNode("key", {}, [
        binary.encodeNode("id", {}, keyIdBytes(preKey.id)),
        binary.encodeNode("value", {}, preKey.pub)
      ]),
      binary.encodeNode("skey", {}, [
        binary.encodeNode("id", {}, keyIdBytes(signed.id)),
        binary.encodeNode("value", {}, Buffer.from(signed.pub, "base64")),
        binary.encodeNode("signature", {}, Buffer.from(signed.signature, "base64"))
      ]),
      binary.encodeNode("device-identity", {}, deviceIdentity)
    ])
  );
};

E2EEClient.prototype.handleNotification = function(node) {
  var type = node.attrs && node.attrs.type;
  if (type === "encrypt") {
    var children = Array.isArray(node.content) ? node.content : node.content ? [node.content] : [];
    var countNode = null;
    var identityNode = null;
    children.forEach(function(child) {
      if (!child) return;
      if (child.tag === "count") countNode = child;
      if (child.tag === "identity") identityNode = child;
    });
    if (countNode) {
      var count = parseInt(countNode.attrs.value || "0", 10);
      if (count < MIN_PREKEY_COUNT) {
        this.uploadPreKeys(PREKEY_UPLOAD_COUNT).catch(function(err) {
          log.warn("e2ee", "Prekey upload failed: " + err.message);
        });
      }
    } else if (identityNode && node.attrs.from) {
      log.warn("e2ee", "Identity changed for " + node.attrs.from + "; dropping its session.");
      delete this.store.sessions[signal.addressKey(node.attrs.from)];
      this.store.save();
    }
  } else if (type === "devices" && node.attrs.from) {
    // A user's device list changed; don't send from a cached copy of it.
    this.forgetDeviceList(node.attrs.from);
  }
  this.sendAck(node);
};

E2EEClient.prototype.handleReceipt = function(node) {
  if (node.attrs && node.attrs.type === "retry") {
    this.resendForRetry(node);
  }
  this.sendAck(node);
};

E2EEClient.prototype.resendForRetry = function(node) {
  var self = this;
  var retryNode = findNode(node, "retry");
  var messageId = (retryNode && retryNode.attrs && retryNode.attrs.id) || node.attrs.id;
  var cached = messageId && this.outboundCache && this.outboundCache[messageId];
  if (!cached) {
    log.warn("e2ee", "Retry requested for unknown message " + messageId);
    return;
  }
  var requester = node.attrs.participant || node.attrs.from;
  if (!requester) return;
  var retryCount = Number((retryNode && retryNode.attrs && retryNode.attrs.count) || "1") || 1;
  if (retryCount >= 10) {
    log.warn("e2ee", "Ignoring retry #" + retryCount + " for " + messageId);
    return;
  }
  var requesterParsed = signal.parseJid(requester);
  var sameUser = requesterParsed.user === this.ctx.userID;
  var transport = encodeMessageTransport({
    messageApp: cached.messageApp,
    dsm: sameUser ? { destinationJid: cached.threadJid, phash: "" } : undefined
  });
  Promise.resolve()
    .then(function() {
      var keysNode = findNode(node, "keys");
      var bundle = keysNode ? bundleFromRetryKeys(node, keysNode, requesterParsed.device) : null;
      if (bundle) {
        signal.establishSession(self.store, requester, bundle);
      } else if (!signal.hasSession(self.store, requester)) {
        return self.getPreKeyBundle(requester).then(function(fetched) {
          signal.establishSession(self.store, requester, fetched);
        });
      }
      var encrypted = signal.encrypt(self.store, requester, transport);
      var attrs = { to: cached.threadJid, type: "text", id: messageId, device_fanout: "false" };
      var t = (retryNode && retryNode.attrs && retryNode.attrs.t) || String(Math.floor(Date.now() / 1000));
      attrs.t = String(t);
      var encAttrs = { v: "3", type: encrypted.type, count: String(retryCount) };
      var messageNode = binary.encodeNode("message", attrs, [
        binary.encodeNode("enc", encAttrs, encrypted.ciphertext),
        binary.encodeNode("franking", {}, [
          binary.encodeNode("franking_tag", {}, cached.frankingTag)
        ])
      ]);
      return self.sendNode(messageNode);
    })
    .catch(function(err) {
      log.warn("e2ee", "Retry resend failed for " + messageId + ": " + err.message);
    });
};

function bundleFromRetryKeys(node, keysNode, deviceId) {
  var registration = findNode(node, "registration");
  var identity = findNode(keysNode, "identity");
  var keyNode = findNode(keysNode, "key");
  var skeyNode = findNode(keysNode, "skey");
  if (!identity || !skeyNode) return null;
  var signedValue = findNode(skeyNode, "value");
  var signedSignature = findNode(skeyNode, "signature");
  if (!signedValue || !signedSignature) return null;
  var readId = function(keyNodeValue) {
    if (!keyNodeValue || !Buffer.isBuffer(keyNodeValue.content) || !keyNodeValue.content.length) return 0;
    return keyNodeValue.content.readUIntBE(0, Math.min(keyNodeValue.content.length, 3));
  };
  var prefixed = function(keyNodeValue) {
    var buf = Buffer.from(keyNodeValue.content);
    return buf.length === 32 ? Buffer.concat([Buffer.from([5]), buf]) : buf;
  };
  var bundle = {
    registrationId:
      registration && Buffer.isBuffer(registration.content) && registration.content.length === 4
        ? registration.content.readUInt32BE(0)
        : 0,
    deviceId: deviceId,
    identityKey: Buffer.from(identity.content),
    signedPreKey: {
      keyId: readId(findNode(skeyNode, "id")),
      publicKey: prefixed(signedValue),
      signature: Buffer.from(signedSignature.content)
    }
  };
  var keyValue = keyNode && findNode(keyNode, "value");
  if (keyValue && Buffer.isBuffer(keyValue.content)) {
    bundle.preKey = {
      keyId: readId(findNode(keyNode, "id")),
      publicKey: prefixed(keyValue)
    };
  }
  return bundle;
}

E2EEClient.prototype.handleIQ = function(node) {
  var id = node.attrs && node.attrs.id;
  if (node.attrs && node.attrs.type === "get" && node.attrs.xmlns === "urn:xmpp:ping") {
    this.sendNode(binary.encodeNode("iq", { id: id, to: node.attrs.from, type: "result" })).catch(function() { /* ignore */ });
    return;
  }
  var pending = id && this.pendingIQs[id];
  if (!pending) return;
  delete this.pendingIQs[id];
  if (node.attrs && node.attrs.type === "error") {
    pending.reject(new Error("E2EE IQ error: " + JSON.stringify(node.content && node.content.attrs) + " id=" + id));
  } else {
    pending.resolve(node);
  }
};

E2EEClient.prototype.sendAck = function(node) {
  if (!node.attrs || !node.attrs.id) return;
  var attrs = { class: node.tag, id: node.attrs.id, to: node.attrs.from };
  if (node.attrs.participant) attrs.participant = node.attrs.participant;
  if (node.attrs.recipient) attrs.recipient = node.attrs.recipient;
  if (node.tag !== "message" && node.attrs.type) attrs.type = node.attrs.type;
  this.sendNode(binary.encodeNode("ack", attrs)).catch(function() { /* ignore */ });
};

E2EEClient.prototype.startHeartbeat = function() {
  var self = this;
  this.stopHeartbeat();
  this.heartbeatTimer = setInterval(function() {
    if (!self.socket) return;
    self
      .sendNode(
        binary.encodeNode("iq", {
          id: String(Date.now() % 1000),
          to: "s.whatsapp.net",
          type: "get",
          xmlns: "w:p"
        })
      )
      .catch(function() { /* ignore */ });
    self.rawHeartbeat();
  }, 30000);
  this.rawHeartbeat();
  this.prekeyTimer = setInterval(function() {
    self.syncPreKeys();
  }, 1800000);
};

E2EEClient.prototype.rawHeartbeat = function() {
  if (this.socket && this.socket.rawSocket) this.socket.rawSocket.write(Buffer.from([0, 0, 0]));
};

E2EEClient.prototype.stopHeartbeat = function() {
  if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  if (this.prekeyTimer) clearInterval(this.prekeyTimer);
  this.heartbeatTimer = null;
  this.prekeyTimer = null;
};

E2EEClient.prototype.readLoop = function() {
  var self = this;
  function pump() {
    if (!self.socket) return;
    self.socket.readFrame().then(
      function(frame) {
        try {
          self.handleFrame(frame);
        } catch (err) {
          log.warn("e2ee", "Frame handling failed: " + err.message);
        }
        pump();
      },
      function(err) {
        if (self.connected) {
          self.connected = false;
          self.connectPromise = null;
          self.socket = null;
          self.stopHeartbeat();
          log.warn("e2ee", "E2EE socket closed: " + err.message);
        }
      }
    );
  }
  pump();
};

E2EEClient.prototype.connect = function(callback) {
  var self = this;
  if (this.connected && this.socket) {
    if (callback) callback(null, { userId: this.ctx.userID, deviceId: this.store ? this.store.jidDevice : 0 });
    return Promise.resolve({ userId: this.ctx.userID });
  }
  if (this.connectPromise) {
    if (callback) {
      this.connectPromise.then(
        function(result) {
          callback(null, result);
        },
        function(err) {
          callback(err);
        }
      );
    }
    return this.connectPromise;
  }
  this.connectPromise = this._connect().catch(function(err) {
    self.connectPromise = null;
    throw err;
  });
  if (callback) {
    this.connectPromise.then(
      function(result) {
        callback(null, result);
      },
      function(err) {
        callback(err);
      }
    );
  }
  return this.connectPromise;
};

E2EEClient.prototype._connect = function() {
  var self = this;
  var storePath = this.ctx.globalOptions.e2eeDevicePath;
  if (!this.store) this.store = DeviceStore.fromFile(storePath);
  return this.fetchCat().then(function(cat) {
    self.cat = cat;
    var register = self.store.jidDevice
      ? Promise.resolve(self.store.jidDevice)
      : self.registerDevice(cat).then(function(deviceId) {
          self.store.jidDevice = deviceId;
          self.store.jidUser = self.ctx.userID;
          self.store.save();
          return deviceId;
        });
    return register.then(function(deviceId) {
      var payload = encodeClientPayload({
        username: self.ctx.userID,
        deviceId: deviceId,
        fbCatBase64: cat
      });
      var endpoint = E2EE_ENDPOINT + "?cid=client-" + Date.now();
      var options = {
        headers: {
          Origin: "https://www.facebook.com",
          "User-Agent": WS_USER_AGENT,
          Cookie: self.cookieString()
        },
        perMessageDeflate: true
      };
      return noise.connectNoiseSocket(endpoint, options, self.store.noiseKeyPriv, payload);
    });
  }).then(function(socket) {
    self.socket = socket;
    return new Promise(function(resolve, reject) {
      var settled = false;
      var timeout = setTimeout(function() {
        if (settled) return;
        settled = true;
        reject(new Error("E2EE login timed out waiting for success frame."));
      }, 15000);
      var originalHandler = self.handleFrame;
      self.handleFrame = function(frame) {
        var node = null;
        try {
          node = binary.unmarshal(frame);
        } catch (e) { /* ignore */ }
        if (node && node.tag === "success" && !settled) {
          settled = true;
          clearTimeout(timeout);
          self.handleFrame = originalHandler;
          originalHandler.call(self, frame);
          resolve();
          return;
        }
        if (node && node.tag === "failure" && !settled) {
          settled = true;
          clearTimeout(timeout);
          self.handleFrame = originalHandler;
          reject(new Error("E2EE login failure: " + (node.attrs.reason || "unknown")));
          return;
        }
        originalHandler.call(self, frame);
      };
      self.readLoop();
    });
  }).then(function() {
    self.connected = true;
    return self.sendNode(
      binary.encodeNode("presence", { type: "available", passive: "false" })
    );
  }).then(function() {
    var sessionId = String((Date.now() + 3 * 24 * 60 * 60 * 1000) % (7 * 24 * 60 * 60 * 1000));
    return self.sendNode(
      binary.encodeNode("ib", {}, [
        binary.encodeNode("unified_session", { id: sessionId }),
        binary.encodeNode("offline"),
        binary.encodeNode("dirty", { type: "account_sync" })
      ])
    );
  }).then(function() {
    return self.sendNode(
      binary.encodeNode("iq", { id: "active-stream", to: "s.whatsapp.net", type: "set", xmlns: "passive" }, [
        binary.encodeNode("active")
      ])
    );
  }).then(function() {
    // Prekeys only matter for sessions other devices open to us, so sending
    // doesn't wait for the count check (and a possible upload). Failures are
    // logged inside syncPreKeys, and the heartbeat timer retries it.
    self.syncPreKeys();
    self.startHeartbeat();
    return { userId: self.ctx.userID, deviceId: self.store.jidDevice };
  });
};

E2EEClient.prototype.sendText = function(threadId, text, callback) {
  var self = this;
  this.connect()
    .then(function() {
      return self._sendMessageApp(threadId, encodeTextMessage(text), "text", text);
    })
    .then(
      function(info) {
        callback(null, info);
      },
      function(err) {
        callback(err);
      }
    );
};

E2EEClient.prototype.sendAttachment = function(threadId, attachment, callback) {
  var self = this;
  if (String(threadId).indexOf("@g.us") !== -1) {
    return callback({
      error:
        "sendMessage: E2EE attachments are only supported in one-to-one " +
        "chats; group E2EE threads need sender keys, which this library " +
        "does not implement."
    });
  }
  this.connect()
    .then(function() {
      return self.uploadMedia(attachment.buffer, attachment.serverMediaType);
    })
    .then(function(entry) {
      entry.mimetype = attachment.mimetype;
      var consumerApp = mediaLib.encodeConsumerMediaApp(attachment.kind, entry, {
        caption: attachment.caption,
        filename: attachment.filename,
        width: attachment.width,
        height: attachment.height,
        duration: attachment.duration,
        gifPlayback: attachment.gifPlayback
      });
      return self._sendMessageApp(
        threadId,
        consumerApp,
        "media",
        attachment.caption || "",
        protocolMediaType(attachment.kind)
      );
    })
    .then(
      function(info) {
        callback(null, info);
      },
      function(err) {
        callback(err);
      }
    );
};

E2EEClient.prototype._sendMessageApp = function(threadId, consumerApp, nodeType, historyBody, protocolMediaType) {
  var self = this;
  var store = this.store;
  var toJid = normalizeThreadJid(threadId);
  var selfJid = this.ctx.userID + "." + (store.jidDevice || 0) + "@msgr";
  var selfBare = bareJid(selfJid);
  var messageId = this.nextMessageId();

  var app = encodeMessageApplication(consumerApp);
  var devicePayload = encodeMessageTransport({ messageApp: app.messageApp });
  var selfDevicePayload = encodeMessageTransport({
    messageApp: app.messageApp,
    dsm: { destinationJid: toJid, phash: "" }
  });

  this.outboundCache = this.outboundCache || {};
  var cacheIds = Object.keys(this.outboundCache);
  if (cacheIds.length >= 200) {
    var oldest = cacheIds.sort(function(a, b) {
      return (this.outboundCache[a].createdAt || 0) - (this.outboundCache[b].createdAt || 0);
    }.bind(this))[0];
    delete this.outboundCache[oldest];
  }
  this.outboundCache[messageId] = {
    threadJid: toJid,
    messageApp: app.messageApp,
    frankingTag: app.frankingTag,
    createdAt: Date.now()
  };

  return this.getDeviceListCached([toJid, selfBare]).then(function(deviceJids) {
    var seen = {};
    var unique = [];
    deviceJids.forEach(function(jid) {
      var key = signal.addressKey(jid);
      if (seen[key] || key === signal.addressKey(selfJid)) return;
      seen[key] = true;
      unique.push(jid);
    });
    if (unique.length === 0) {
      throw new Error("No E2EE devices found for " + threadId);
    }
    var failures = [];
    var needSession = unique.filter(function(deviceJid) {
      return !signal.hasSession(store, deviceJid);
    });
    var bundles = needSession.length ? self.getPreKeyBundles(needSession) : Promise.resolve({});
    return bundles.then(function(results) {
      var usable = unique.filter(function(deviceJid) {
        if (needSession.indexOf(deviceJid) === -1) return true;
        var bundle = results[deviceJid];
        if (bundle instanceof Error || !bundle) {
          failures.push(deviceJid + ": " + (bundle && bundle.message ? bundle.message : "no prekey bundle"));
          return false;
        }
        signal.establishSession(store, deviceJid, bundle);
        return true;
      });
      if (usable.length === 0) {
        throw new Error(
          "Could not establish an E2EE session for " + threadId + " (" + failures.join("; ") + ")"
        );
      }
      var participantNodes = usable.map(function(deviceJid) {
        var payload = signal.parseJid(deviceJid).user === signal.parseJid(selfJid).user
          ? selfDevicePayload
          : devicePayload;
        var encrypted = signal.encrypt(store, deviceJid, payload);
        var encAttrs = { v: "3", type: encrypted.type };
        if (protocolMediaType) encAttrs.mediatype = protocolMediaType;
        return binary.encodeNode("to", { jid: deviceJid }, [
          binary.encodeNode("enc", encAttrs, encrypted.ciphertext)
        ]);
      });
      var messageNode = binary.encodeNode(
        "message",
        { to: toJid, type: nodeType || "text", id: messageId },
        [
          binary.encodeNode("participants", {}, participantNodes),
          binary.encodeNode("franking", {}, [binary.encodeNode("franking_tag", {}, app.frankingTag)]),
          binary.encodeNode("trace", {}, [
            binary.encodeNode(
              "request_id",
              {},
              Buffer.from(require("crypto").randomUUID().replace(/-/g, ""), "hex")
            )
          ])
        ]
      );
      return self.sendNode(messageNode).then(function() {
        var timestamp = Date.now();
        store.threads[String(threadId)] = true;
        store.appendHistory(threadId, {
          messageID: messageId,
          threadID: String(threadId),
          senderID: self.ctx.userID,
          timestamp: timestamp,
          body: historyBody || ""
        });
        store.save();
        return { threadID: String(threadId), messageID: messageId, timestamp: timestamp };
      });
    });
  }).catch(function(err) {
    // Don't keep sending from a device list that may be why this failed.
    self.forgetDeviceList(toJid);
    self.forgetDeviceList(selfBare);
    throw err;
  });
};

var SERVER_MEDIA = [
  "image",
  "sticker",
  "ptt",
  "audio",
  "document",
  "video",
  "gif",
  "preview",
  "xma-image",
  "ppic"
];

E2EEClient.prototype.gatherMediaConn = function() {
  var self = this;
  if (this.mediaConn && this.mediaConn.expiresAt > Date.now() + 5000) {
    return Promise.resolve(this.mediaConn);
  }
  if (this.mediaConnPromise) return this.mediaConnPromise;
  var id = this.nextId("mc-");
  var iq = {
    tag: "iq",
    attrs: { id: id, to: "s.whatsapp.net", type: "set", xmlns: "w:m" },
    content: [{ tag: "media_conn", attrs: {} }]
  };
  this.mediaConnPromise = this.requestIQ(iq, 20000)
    .then(function(res) {
      var connNode = binary.findDescendant(res, "media_conn");
      if (!connNode || !Array.isArray(connNode.content)) {
        throw new Error(
          "E2EE media_conn IQ returned no media hosts: " + JSON.stringify(summarizeNode(res))
        );
      }
      var hosts = [];
      connNode.content.forEach(function(hostNode) {
        if (!hostNode || hostNode.tag !== "host" || !hostNode.attrs.hostname) return;
        var host = {
          domain: hostNode.attrs.hostname,
          class: hostNode.attrs.class || null,
          isFallback: hostNode.attrs.type === "fallback",
          uploadable: [],
          downloadable: []
        };
        ["upload", "download"].forEach(function(key) {
          var node = binary.findChild(hostNode, key);
          var listKey = key === "upload" ? "uploadable" : "downloadable";
          if (!node) {
            host[listKey] = SERVER_MEDIA.slice();
            return;
          }
          if (!Array.isArray(node.content)) return;
          node.content.forEach(function(child) {
            if (child && child.tag) host[listKey].push(child.tag);
          });
        });
        hosts.push(host);
      });
      if (hosts.length === 0) throw new Error("E2EE media_conn IQ returned no hosts");
      log.verbose(
        "e2ee",
        "media_conn hosts: " +
          hosts
            .map(function(host) {
              return (
                host.domain +
                " up=[" +
                host.uploadable.join(",") +
                "] down=[" +
                host.downloadable.join(",") +
                "]"
              );
            })
            .join(" | ")
      );
      var ttl = Number(connNode.attrs.auth_ttl || connNode.attrs.ttl || 0);
      var expiresAt = ttl > 0
        ? Math.min(ttl * 1000, Date.now() + 15 * 60 * 1000)
        : Date.now() + 5 * 60 * 1000;
      var conn = { hosts: hosts, authToken: connNode.attrs.auth || "", expiresAt: expiresAt };
      self.mediaConn = conn;
      return conn;
    })
    .finally(function() {
      self.mediaConnPromise = null;
    });
  return this.mediaConnPromise;
};

function pickMediaHost(hosts, mediaType, operation) {
  var key = operation === "upload" ? "uploadable" : "downloadable";
  var matching = (hosts || []).filter(function(host) {
    return host[key] && host[key].indexOf(mediaType) !== -1;
  });
  if (matching.length === 0) return null;
  var primary = matching.filter(function(host) {
    return !host.isFallback;
  })[0];
  return primary || matching[0];
}

function toBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function msgrMediaType(serverMediaType) {
  switch (serverMediaType) {
    case "image":
    case "video":
    case "gif":
    case "sticker":
      return serverMediaType;
    case "document":
      return "file";
    case "ptt":
      return "audio";
    case "xma-image":
      return "xma";
    default:
      return "file";
  }
}

E2EEClient.prototype.buildMIAuthQuery = function() {
  var params = {
    __user: this.ctx.userID,
    __a: 1,
    __req: (++this.requestCounter).toString(36)
  };
  if (this.ctx.fb_dtsg) params.fb_dtsg = this.ctx.fb_dtsg;
  if (this.ctx.ttstamp) params.jazoest = this.ctx.ttstamp;
  if (this.ctx.lsd) params.lsd = this.ctx.lsd;
  if (this.ctx.clientRevision) params.__rev = this.ctx.clientRevision;
  return Object.keys(params)
    .map(function(key) {
      return encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key]));
    })
    .join("&");
};

E2EEClient.prototype.parseUploadResponse = function(body) {
  var json;
  try {
    json = JSON.parse(body);
  } catch (err) {
    throw new Error("E2EE media upload returned invalid JSON", { cause: err });
  }
  if (!json.direct_path) {
    throw new Error("E2EE media upload response is missing direct_path");
  }
  return json;
};

E2EEClient.prototype.miUploadMedia = function(media, uploadToken, serverMediaType) {
  var self = this;
  var encodedHash = toBase64Url(media.fileEncSha256);
  var url =
    "https://rupload.facebook.com/messenger_eb/" +
    encodedHash +
    "?direct_ip=0&token=" +
    toBase64Url(uploadToken) +
    "&" +
    this.buildMIAuthQuery();
  return http
    .request({
      method: "POST",
      url: url,
      jar: self.ctx.jar,
      headers: {
        "Content-Type": "application/octet-stream",
        Offset: "0",
        "X-Entity-Length": String(media.ciphertext.length),
        "X-Entity-Name": encodeURIComponent(encodedHash),
        "X-Entity-Type": "application/octet-stream",
        desired_upload_handler: "encrypted_backups",
        media_type: msgrMediaType(serverMediaType)
      },
      body: media.ciphertext,
      timeout: 180000
    })
    .then(function(res) {
      if (res.statusCode !== 200) {
        throw new Error(
          "E2EE media upload failed with HTTP " +
            res.statusCode +
            " on rupload.facebook.com/messenger_eb: " +
            String(res.body).slice(0, 300)
        );
      }
      return self.parseUploadResponse(res.body);
    });
};

E2EEClient.prototype.uploadMedia = function(buffer, serverMediaType) {
  var self = this;
  var media = mediaLib.encryptMedia(buffer, serverMediaType);
  var uploadToken = require("crypto").randomBytes(32);
  return this.gatherMediaConn().then(function(conn) {
    var host = pickMediaHost(conn.hosts, serverMediaType, "upload");
    var upload;
    if (host) {
      var url =
        "https://" +
        host.domain +
        "/wa-msgr/mms/" +
        serverMediaType +
        "/" +
        toBase64Url(media.fileEncSha256) +
        "?auth=" +
        encodeURIComponent(conn.authToken || "") +
        "&token=" +
        toBase64Url(uploadToken);
      upload = http
        .request({
          method: "POST",
          url: url,
          jar: self.ctx.jar,
          headers: { "Content-Type": "text/plain" },
          body: media.ciphertext,
          timeout: 180000
        })
        .then(function(res) {
          if (res.statusCode !== 200) {
            throw new Error(
              "E2EE media upload failed with HTTP " +
                res.statusCode +
                " on " +
                host.domain +
                ": " +
                String(res.body).slice(0, 300)
            );
          }
          return self.parseUploadResponse(res.body);
        });
    } else {
      upload = self.miUploadMedia(media, uploadToken, serverMediaType);
    }
    return upload.then(function(json) {
      return {
        fileSha256: media.fileSha256,
        mediaKey: media.mediaKey,
        fileEncSha256: media.fileEncSha256,
        directPath: json.direct_path,
        objectId: json.object_id || null,
        handle: json.handle || null,
        mediaKeyTimestamp: Math.floor(Date.now() / 1000),
        serverMediaType: serverMediaType,
        size: buffer.length
      };
    });
  });
};

E2EEClient.prototype.downloadMedia = function(attachment, callback) {
  var self = this;
  var e2ee = attachment && attachment.e2ee;
  if (!e2ee || !e2ee.directPath || !e2ee.mediaKey || !e2ee.fileEncSha256) {
    return callback({ error: "downloadE2EEAttachment: attachment has no E2EE media info." });
  }
  this.connect()
    .then(function() {
      var serverMediaType = e2ee.serverMediaType || "document";
      var fileEncSha256 = Buffer.from(e2ee.fileEncSha256, "base64");
      var mediaKey = Buffer.from(e2ee.mediaKey, "base64");
      return self.gatherMediaConn().then(function(conn) {
        var hosts = (conn.hosts || []).slice().sort(function(a, b) {
          var aMatch = a.downloadable && a.downloadable.indexOf(serverMediaType) !== -1 ? 0 : 1;
          var bMatch = b.downloadable && b.downloadable.indexOf(serverMediaType) !== -1 ? 0 : 1;
          return aMatch - bMatch;
        });
        if (!hosts.length) throw new Error("No E2EE media download hosts available");
        var attempts = hosts.map(function(host) {
          return function() {
            var url =
              "https://" +
              host.domain +
              e2ee.directPath +
              "?hash=" +
              toBase64Url(fileEncSha256) +
              "&mode=manual";
            return http
              .request({
                method: "GET",
                url: url,
                jar: self.ctx.jar,
                encoding: null,
                timeout: 180000
              })
              .then(function(res) {
                if (res.statusCode !== 200) {
                  throw new Error("E2EE media download failed with HTTP " + res.statusCode);
                }
                if (Buffer.compare(cryptoUtils.sha256(res.body), fileEncSha256) !== 0) {
                  throw new Error("E2EE media download hash mismatch");
                }
                var plaintext = mediaLib.decryptMedia(res.body, mediaKey, serverMediaType);
                if (e2ee.fileSha256) {
                  var expected = Buffer.from(e2ee.fileSha256, "base64");
                  if (Buffer.compare(cryptoUtils.sha256(plaintext), expected) !== 0) {
                    throw new Error("E2EE media plaintext hash mismatch");
                  }
                }
                return plaintext;
              });
          };
        });
        return attempts.reduce(function(promise, attempt) {
          return promise.catch(attempt);
        }, Promise.reject(new Error("E2EE media download: no hosts")));
      });
    })
    .then(
      function(buffer) {
        callback(null, buffer);
      },
      function(err) {
        callback(err);
      }
    );
};

E2EEClient.prototype.disconnect = function() {
  this.stopHeartbeat();
  this.connected = false;
  this.connectPromise = null;
  if (this.socket) {
    this.socket.end();
    this.socket = null;
  }
};

module.exports = {
  E2EEClient: E2EEClient,
  encodeClientPayload: encodeClientPayload,
  encodeTextMessage: encodeTextMessage,
  encodeMessageApplication: encodeMessageApplication,
  encodeMessageTransport: encodeMessageTransport,
  decodeConsumerText: decodeConsumerText,
  decodeDsmDestination: decodeDsmDestination
};
