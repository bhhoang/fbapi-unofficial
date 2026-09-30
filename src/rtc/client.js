"use strict";

// Messenger voice/video call control over the "Multiway" (Zenon) signaling
// protocol.
//
// The web client sends compact-thrift messages to the /t_rtc_multi MQTT topic
// (see src/rtc/proto.js for the message schemas). This client opens its own
// MQTT connection for signaling, rings a peer by joining a conference with
// them as invitees, and drives the call state from the server's RING/JOIN/
// HANGUP/DISMISS traffic.
//
// Only call signaling is implemented: no audio or video is sent or received.
// A synthetic SDP offer is used so Facebook accepts the join; conversations
// stay silent (see DOCS.md#call). Pass `offerSdp` (or `answerSdp`) to supply
// SDP from a real WebRTC stack.

var websocket = require("../websocket");
var log = require("npmlog");
var proto = require("./proto");
var e2eeState = require("./e2eeState");
var e2eeMedia = require("./e2eeMedia");
var media = require("./media");
var turn = require("./turn");
var dtlsAuth = require("./dtlsAuth");

var signalingTopic = "/t_rtc_multi";

// Same app id the rest of the library uses for the web MQTT endpoint.
var mqttAppID = "219994525426954";

// Capability set the Messenger web client advertises, captured from a live
// session: participant states, full/delta SDP in server media updates, SDP
// renegotiation, preconnect and multiple video streams.
var baseCapabilities = [
  proto.Capability.SUPPORT_NEW_PARTICIPANT_STATES,
  proto.Capability.REQUIRE_FULL_SDP_IN_SMU,
  proto.Capability.SUPPORT_SDP_RENEGOTIATION,
  proto.Capability.REQUIRE_FULL_SDP_IN_SMU_OPTIMIZED,
  proto.Capability.SUPPORT_DELTA_SMU,
  proto.Capability.SUPPORT_PRECONNECT,
  proto.Capability.SUPPORT_MULTIPLE_VIDEO_STREAMS
];

// Peer-to-peer media (with escalation/deescalation) is only claimed when a
// real WebRTC peer connection is going to be used.
var p2pCapabilities = [
  proto.Capability.SUPPORT_MWPP,
  proto.Capability.SUPPORT_MWPP_DEESCALATION
];

function randomUint32() {
  return (Math.random() * 4294967295) >>> 0;
}

function randomUuid() {
  var hex = randomHex(32);
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) +
    "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}

function randomHex(length) {
  var out = "";
  while (out.length < length) {
    out += randomUint32().toString(16);
  }
  return out.slice(0, length);
}

// The web client uses String(Random.uint32() + 1) for both client session ids
// and message transaction ids.
function newId() {
  return String(randomUint32() + 1);
}

// Minimal SDP offer. Facebook's signaling only validates that the offer parses
// and contains the expected m-lines; without a real WebRTC stack no media is
// exchanged.
function buildOfferSdp(options) {
  var sessionId = newId();
  var fingerprint = randomHex(64).replace(/(.{2})(?=.)/g, "$1:");
  var bundle = options.video ? "0 1" : "0";
  var lines = [
    "v=0",
    "o=- " + sessionId + " 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE " + bundle,
    "a=msid-semantic: WMS stream" + sessionId,
    "m=audio 9 UDP/TLS/RTP/SAVPF 111 0 8",
    "c=IN IP4 0.0.0.0",
    "a=rtcp:9 IN IP4 0.0.0.0",
    "a=ice-ufrag:" + randomHex(8),
    "a=ice-pwd:" + randomHex(24),
    "a=ice-options:trickle",
    "a=fingerprint:sha-256 " + fingerprint,
    "a=setup:actpass",
    "a=mid:0",
    "a=sendrecv",
    "a=msid:stream" + sessionId + " audio" + sessionId,
    "a=rtcp-mux",
    "a=rtpmap:111 opus/48000/2",
    "a=rtpmap:0 PCMU/8000",
    "a=rtpmap:8 PCMA/8000"
  ];
  if (options.video) {
    lines = lines.concat([
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "c=IN IP4 0.0.0.0",
      "a=rtcp:9 IN IP4 0.0.0.0",
      "a=ice-ufrag:" + randomHex(8),
      "a=ice-pwd:" + randomHex(24),
      "a=ice-options:trickle",
      "a=fingerprint:sha-256 " + fingerprint,
      "a=setup:actpass",
      "a=mid:1",
      "a=sendrecv",
      "a=msid:stream" + sessionId + " video" + sessionId,
      "a=rtcp-mux",
      "a=rtcp-rsize",
      "a=rtpmap:96 VP8/90000"
    ]);
  }
  return lines.join("\r\n") + "\r\n";
}

// Track ids in the media status must match the SDP track ids (`a=msid`), so
// the conference maps them to our actual media. When a media session exists
// its real track ids are used; otherwise random UUIDs stand in.
function buildMediaStatus(video, trackIds) {
  var mediaStatus = {};
  var tracks = {};
  trackIds = trackIds || {};

  function addTrack(label, id) {
    id = id || randomUuid();
    mediaStatus[id] = true;
    tracks[id] = {
      enabled: true,
      customVideoContentType: 0,
      customAudioContentType: 0,
      label: label
    };
  }
  addTrack(proto.TrackLabel.DEFAULT_AUDIO, trackIds.audio);
  if (video) addTrack(proto.TrackLabel.DEFAULT_VIDEO, trackIds.video);

  return { mediaStatus: mediaStatus, mediaStatusEx: { tracks: tracks } };
}

// The joining_context app message tells Facebook which thread the call belongs
// to. The web client sends every field, with nulls for the unused ones.
function joiningContextMessage(peerID, options, isE2eeMandated) {
  var context = {
    call_trigger: options.callTrigger != null ? options.callTrigger : null,
    callable_post_id: null,
    calling_tags: isE2eeMandated ? 2 : 0,
    group_thread_id: options.groupThreadID || null,
    ig_thread_id: null,
    link_url: null,
    live_broadcast_id: null,
    meeting_id: null,
    peer_id: peerID || null,
    server_info_data: options.serverInfoData || null
  };
  var recipients = peerID ? [peerID] : [];
  return {
    header: {
      topic_DEPRECATED: "joining_context",
      recipients: recipients
    },
    body: {
      genericMessage: {
        topic: "joining_context",
        data: Buffer.from(JSON.stringify(context), "utf8")
      }
    }
  };
}

// Secure (end-to-end encrypted) calls must include the client's E2EE call
// state in the join's state-sync payload; Facebook rejects the join with
// "Participant didn't provide sync payload for the topic" otherwise. The
// state comes from the web/Meta client (see `e2eeState` in DOCS.md#call).
function buildSyncPayload(options) {
  if (options.syncPayload) return options.syncPayload;
  var stateStore = {
    coplay: { version: 1, data: Buffer.alloc(0) }
  };
  if (options.e2eeState) {
    stateStore.E2eeState = { version: 1, data: options.e2eeState };
  }
  return { stateStore: stateStore, stateStoreV2: {} };
}

// The web client declares these in every join (captured from Messenger web,
// which gets video forwarded; the library sent none).
var USER_CAPABILITIES = JSON.stringify({
  AddParticipantEnabled: false,
  GROUP_COWATCH: true,
  MultipleVideoStreamsAllowed: true,
  MW_AV_ESCALATION: true,
  canApproveCollaborationSpaceJoinRequests: true,
  cowatch: true,
  screen_sharing: false,
  sctpSecondPc: false
});

// Shared join body for outgoing calls and accepted incoming calls.
function buildJoinRequest(call, options) {
  // Messenger web starts 1:1 calls P2P (the server escalates them to the SFU
  // once the peer answers) and group calls on the SFU. Our outgoing video
  // calls join the SFU directly: a web callee otherwise builds a P2P leg from
  // our offer that never connects (we only talk to the SFU), and its
  // participant model keeps that leg's ended video track, so it showed our
  // avatar instead of the video. The web client declares the P2P
  // capabilities either way.
  var mediaMode = options.mediaMode != null
    ? options.mediaMode
    : (call.mediaPath != null
      ? call.mediaPath
      : (call.isGroup || (call.isVideo && call.direction === "outgoing")
        ? proto.MediaPath.SFU
        : proto.MediaPath.P2P));
  var capabilities = baseCapabilities.concat(p2pCapabilities);
  var media = buildMediaStatus(call.isVideo && !options.deferVideo, {
    audio: options.audioTrackId,
    video: options.videoTrackId
  });
  var isE2eeMandated = options.e2ee === true;

  // An accepting client sends its local SDP as `answer`; when a real answer is
  // supplied the offer field stays empty, exactly like the web client.
  var offerSdp = options.offerSdp ||
    (options.answerSdp ? null : buildOfferSdp({ video: call.isVideo }));

  // An accepting client must echo the caller's E2EE requirements: sending
  // different ones (for example forcing preventSfuMode) makes the server
  // reject the join with "Mismatch in the E2EE requirements of the JOIN".
  var enforcement = call.e2eeEnforcement || {};
  var joinEnforcement = {
    mode: enforcement.mode != null
      ? enforcement.mode
      : (isE2eeMandated ? proto.E2eeMode.E2EE_MANDATED : proto.E2eeMode.E2EE_NOT_MANDATED),
    // Messenger web sends false: the call may use the SFU. Preventing it
    // while the server routes the call through the SFU anyway left E2EE
    // disabled (errorCode 3).
    preventSfuMode: enforcement.preventSfuMode != null
      ? !!enforcement.preventSfuMode
      : (options.preventSfuMode != null ? !!options.preventSfuMode : false),
    infraMandatedExpStatus: enforcement.infraMandatedExpStatus != null
      ? enforcement.infraMandatedExpStatus
      : proto.E2eeInfraMandatedExpStatus.NOT_SET
  };

  var joinRequest = {
    offer: offerSdp ? { sdpString: offerSdp } : {},
    deviceCapabilities: capabilities,
    userCapabilities: Buffer.from(USER_CAPABILITIES, "utf8"),
    mediaStatus: media.mediaStatus,
    mediaStatusEx: media.mediaStatusEx,
    e2eeEnforcement: joinEnforcement,
    clientMediaMode: mediaMode,
    endpointSettings: { joinMode: proto.JoinMode.PRIMARY }
  };

  if (call.direction === "outgoing") {
    joinRequest.usersToCall = call.invitees || [call.peerID];
    joinRequest.appMessages = [
      joiningContextMessage(call.isGroup ? null : call.peerID, options, isE2eeMandated)
    ];
  }
  // The state sync payload is mandatory once the call is E2EE mandated.
  if (isE2eeMandated || options.syncPayload) {
    joinRequest.syncPayload = buildSyncPayload(options);
  }
  // The web client sends a full answer only after an offer was received.
  if (options.answerSdp) {
    joinRequest.answer = { sdpString: options.answerSdp };
  }
  return joinRequest;
}

function findJoiningContext(message) {
  var messages = (message.messageBody && message.messageBody.ringRequest
    ? message.messageBody.ringRequest.appMessages
    : null) || [];
  for (var i = 0; i < messages.length; i++) {
    var body = messages[i].body;
    var generic = body && body.genericMessage;
    if (!generic || generic.topic !== "joining_context" || !generic.data) continue;
    try {
      return JSON.parse(Buffer.from(generic.data).toString("utf8"));
    } catch (e) {
      log.warn("call", "Could not parse joining_context app message: " + e.message);
    }
  }
  return null;
}

function CallClient(ctx, defaultFuncs) {
  this.ctx = ctx;
  this.defaultFuncs = defaultFuncs;
  this.mqttClient = null;
  this.connected = false;
  this.connectCallbacks = [];
  this.sendingQueue = [];
  // callID -> call state
  this.calls = {};
  // transactionId -> call state, for responses that echo the request id
  this.pendingTransactions = {};
  // Active WebRTC media session (optional, needs the werift package).
  this.mediaSession = null;
  this.mediaCall = null;
  this.pendingLocalCandidates = [];
}

// End-to-end encrypted calls must carry this client's E2EE call state. When
// the caller did not supply one, build it from the library's E2EE device
// (registering a device first if this account does not have one yet).
CallClient.prototype.resolveE2eeState = function(options, callback) {
  var self = this;
  if (options.syncPayload || options.e2ee !== true || options.e2eeState) {
    return callback();
  }
  this.ensureE2eeDevice(function(err) {
    if (err) return callback(err);
    try {
      var device = e2eeState.loadDevice(self.ctx.globalOptions.e2eeDevicePath);
      if (!device) throw new Error("no E2EE device at " + self.ctx.globalOptions.e2eeDevicePath);
      options.e2eeState = e2eeState.buildE2eeClientState(device);
      callback();
    } catch (e) {
      callback({
        error: "call: could not build the E2EE call state.",
        detail: e.message,
        e2eeRequired: true
      });
    }
  });
};

// ---------------------------------------------------------------------------
// WebRTC media (optional, requires the `werift` package)
// ---------------------------------------------------------------------------

// Facebook mints TURN relays once the call exists, and the web client then
// trickles the relay candidates to the conference. Refresh the media relays
// after a join response (user-provided iceServers are kept).
CallClient.prototype.refreshMediaRelays = function(call, responseRelayInfo) {
  if (!call || !call.mediaSession || !responseRelayInfo) return;
  var fromJoin = media.iceServersFromRelayInfo(responseRelayInfo);
  if (fromJoin.length) call.mediaSession.setIceServers(fromJoin);
};

// ICE candidates are only gathered once by werift, so Facebook's TURN relays
// have to be known before the offer/answer is created (the web client does the
// same; its discovery request carries the fixed `ZenonPlatform` identifier).
CallClient.prototype.withTurnServers = function(mediaOptions, callback) {
  if ((mediaOptions.iceServers && mediaOptions.iceServers.length) || !this.defaultFuncs) {
    return callback(mediaOptions);
  }
  turn.fetchTurnCredentials(this.defaultFuncs, this.ctx, function(err, servers) {
    if (servers && servers.length) {
      mediaOptions.iceServers = turn.orderForTransport(servers, mediaOptions.turnTransport);
    }
    callback(mediaOptions);
  });
};

// E2EE calls authenticate the DTLS handshake with the account's identity key
// (`a=x-dtls-auth`); the other side rejects the media path without it.
CallClient.prototype.withDtlsAuth = function(sdp, options, callback) {
  if (options.e2ee !== true || !sdp) return callback(null, sdp);
  dtlsAuth.addToSdp(sdp, {
    e2eeDevicePath: this.ctx.globalOptions.e2eeDevicePath,
    wasmPath: this.ctx.globalOptions.frameEncryptionWasmPath,
    userId: this.ctx.userID
  }, function(err, signed) {
    if (err) {
      log.warn("call", "Could not add x-dtls-auth to the SDP: " + err.message);
      return callback(null, sdp);
    }
    log.info("call", "Media: added x-dtls-auth to the SDP");
    callback(null, signed);
  });
};

// E2EE calls negotiate SFrame media keys over the signaling channel: the
// frame_encryption wasm (src/rtc/e2eeMedia.js) turns the server's E2eeState
// and the peer's E2eeKey messages into frame keys, and every encoded audio
// frame is encrypted/decrypted through it.
CallClient.prototype.setupE2eeMedia = function(options, mediaOptions, call, callback) {
  if (options.e2ee !== true || options.e2eeMediaSession) return callback();
  var self = this;
  dtlsAuth.ensureWasm({
    wasmPath: this.ctx.globalOptions.frameEncryptionWasmPath,
    e2eeDevicePath: this.ctx.globalOptions.e2eeDevicePath
  }, function(wasmError, wasmPath) {
    if (wasmError) {
      log.warn("call", "Could not prepare the frame-encryption wasm: " + wasmError.message);
      return callback();
    }
    var session = new e2eeMedia.E2eeMediaSession({
      e2eeDevicePath: self.ctx.globalOptions.e2eeDevicePath,
      wasmPath: wasmPath,
      userId: self.ctx.userID
    });
    session.onSendKey = function(recipient, data) {
      self.sendE2eeKeyDataMessage(call, recipient, data);
    };
    // The wasm serializes this client's E2eeClientState at start-up; the web
    // client puts exactly that into the join's sync payload (it signs its own
    // signed prekey, so it differs from one built outside the wasm).
    session.onClientState = function(bytes) {
      self.e2eeClientState = bytes;
      options.e2eeState = bytes;
      log.info("call", "E2EE media: using the wasm client state (" + bytes.length + " bytes) for the join");
    };
    session.start(function(err) {
      if (err) {
        log.warn("call", "Could not start the E2EE media stack: " + err.message);
        return callback();
      }
      options.e2eeMediaSession = session;
      mediaOptions.e2eeMedia = session;
      callback();
    });
  });
};

// The wasm asks for these to reach the peer's E2EE stack; the web client sends
// them as DATA_MESSAGEs with the "E2eeKey" topic (recipients = the peer).
// Outgoing calls are still being set up when the first key message appears, so
// the call is resolved lazily.
CallClient.prototype.sendE2eeKeyDataMessage = function(call, recipient, data) {
  if (!call) {
    call = this.mediaCall;
    var self = this;
    Object.keys(this.calls).some(function(id) {
      var candidate = self.calls[id];
      if (candidate.state === "ended") return false;
      if (candidate.peerID === recipient ||
        (candidate.invitees || []).indexOf(recipient) !== -1) {
        call = candidate;
        return true;
      }
      return false;
    });
  }
  if (!call || !call.serverInfoData) {
    log.warn("call", "Could not send an E2eeKey data message: no active call");
    return;
  }
  var header = this.buildHeader(proto.MessageType.DATA_MESSAGE, call, {});
  this.send(header, {
    dataMessageRequest: {
      message: {
        header: {
          sender: this.ctx.userID,
          topic_DEPRECATED: "",
          recipients: [recipient],
          serviceRecipients: []
        },
        body: {
          genericMessage: {
            topic: "E2eeKey",
            data: data
          }
        }
      }
    }
  }, function(err) {
    if (err) log.warn("call", "Could not send an E2eeKey data message: " + err.message);
    else log.verbose("call", "E2EE media: sent " + data.length + " bytes of key material to " + recipient);
  });
};

// Media options that can be given a global default through api.setOptions
// (per-call options.media wins).
CallClient.prototype.applyGlobalMediaOptions = function(mediaOptions) {
  var globals = this.ctx.globalOptions || {};
  ["opusBitrate"].forEach(function(key) {
    if (mediaOptions[key] == null && globals[key] != null) mediaOptions[key] = globals[key];
  });
};

// Caller side: create the offer that goes into the JOIN.
CallClient.prototype.prepareMediaForOutgoing = function(options, callback) {
  if (!options.media) return callback();
  var self = this;
  var mediaOptions = options.media === true ? {} : Object.assign({}, options.media);
  // Video needs the werift engine; tell the session factory even when no
  // video file is given (the other side's video still has to be rendered).
  if (options.video && mediaOptions.wantsVideo == null) mediaOptions.wantsVideo = true;
  // Hold the audio file until the other side actually joins the call.
  if (mediaOptions.holdAudio == null) mediaOptions.holdAudio = mediaOptions.autoStart !== true;
  this.applyGlobalMediaOptions(mediaOptions);
  options.audioDelayMs = mediaOptions.audioDelayMs;
  this.setupE2eeMedia(options, mediaOptions, null, function() {
    self.withTurnServers(mediaOptions, function(prepared) {
      var session = media.createMediaSession(prepared);
      if (!session) return callback(mediaUnavailableError());
      if (session.trackIds) {
        options.audioTrackId = session.trackIds.audio;
        options.videoTrackId = session.trackIds.video;
      }
      self.attachMediaSession(session, null);
      session.createOffer(function(err, sdp) {
        if (err) {
          self.closeMediaSession(session);
          return callback({ error: "call: could not create the WebRTC offer.", detail: err.message });
        }
        if (options.e2eeMediaSession && session.localCname) {
          options.e2eeMediaSession.setLocalE2eeId(self.ctx.userID + ":" + session.localCname);
        }
        self.withDtlsAuth(sdp, options, function(authErr, signedSdp) {
          options.offerSdp = signedSdp;
          callback();
        });
      });
    });
  });
};

// Callee side: answer the caller's offer (P2P) or offer to the SFU.
CallClient.prototype.prepareMediaForIncoming = function(call, options, callback) {
  if (!options.media) return callback();
  var self = this;
  var mediaOptions = options.media === true ? {} : Object.assign({}, options.media);
  if (call && call.isVideo && mediaOptions.wantsVideo == null) mediaOptions.wantsVideo = true;
  if (mediaOptions.holdAudio == null) mediaOptions.holdAudio = mediaOptions.autoStart !== true;
  this.applyGlobalMediaOptions(mediaOptions);
  options.audioDelayMs = mediaOptions.audioDelayMs;
  var relayServers = call.relayInfo ? media.iceServersFromRelayInfo(call.relayInfo) : [];
  if (relayServers.length) {
    mediaOptions.iceServers = (mediaOptions.iceServers || []).concat(relayServers);
  }

  this.setupE2eeMedia(options, mediaOptions, call, function() {
    self.withTurnServers(mediaOptions, function(prepared) {
      var session = media.createMediaSession(prepared);
      if (!session) return callback(mediaUnavailableError());
      if (session.trackIds) {
        options.audioTrackId = session.trackIds.audio;
        options.videoTrackId = session.trackIds.video;
      }
      self.attachMediaSession(session, call);

      function done(err, sdp, field) {
        if (err) {
          self.closeMediaSession(session);
          return callback({ error: "call: could not create the WebRTC " + field + ".", detail: err.message });
        }
        if (options.e2eeMediaSession && session.localCname) {
          options.e2eeMediaSession.setLocalE2eeId(self.ctx.userID + ":" + session.localCname);
        }
        self.withDtlsAuth(sdp, options, function(authErr, signedSdp) {
          options[field === "answer" ? "answerSdp" : "offerSdp"] = signedSdp;
          callback();
        });
      }

      if (call.offerSdp) {
        session.createAnswer(call.offerSdp, function(err, sdp) { done(err, sdp, "answer"); });
      } else {
        session.createOffer(function(err, sdp) { done(err, sdp, "offer"); });
      }
    });
  });
};

CallClient.prototype.attachMediaSession = function(session, call) {
  var self = this;
  this.mediaSession = session;
  this.mediaCall = call;
  session.onCandidate = function(candidate) {
    self.pendingLocalCandidates.push(candidate);
    self.flushLocalCandidates(self.mediaCall);
  };
  // Tell the conference the media path is up; without this the SFU keeps
  // treating us as signaling-only and does not forward audio.
  session.onConnected = function() {
    var activeCall = self.mediaCall || call;
    if (!activeCall) return;

    var header = self.buildHeader(proto.MessageType.CLIENT_EVENT, activeCall, {});
    self.send(header, {
      clientEventRequest: {
        clientEvents: [{ type: proto.ClientEventType.MEDIA_CONNECTED, time: Date.now() }]
      }
    }, function(err) {
      if (err) log.warn("call", "Could not send the media-connected event: " + err.message);
      else log.info("call", "Media: announced MEDIA_CONNECTED to the conference");
    });

    // The web client asks the SFU for the dominant speaker stream once its
    // media is up; without this subscription the conference does not send it
    // any audio (and does not mix the participant in).
    var subscribeHeader = self.buildHeader(proto.MessageType.SUBSCRIPTION, activeCall, {});
    self.send(subscribeHeader, {
      subscriptionRequest: {
        subscriptions: [{
          cname: "",
          options: { videoQuality: proto.VideoQuality.LOW },
          type: proto.SubscriptionType.DOMINANT_SPEAKER
        }]
      }
    }, function(err) {
      if (err) log.warn("call", "Could not subscribe to the conference audio: " + err.message);
      else log.info("call", "Media: subscribed to the conference (dominant speaker)");
    });

    // The web client also publishes its local media state once the connection
    // is up; the SFU uses it to start forwarding our audio (and video).
    var mediaStatus = {};
    var tracks = {};
    function addLocalTrack(id, label) {
      if (!id) return;
      mediaStatus[id] = true;
      tracks[id] = {
        enabled: true,
        customVideoContentType: 0,
        customAudioContentType: 0,
        label: label
      };
    }
    addLocalTrack(activeCall.audioTrackId, proto.TrackLabel.DEFAULT_AUDIO);
    addLocalTrack(activeCall.videoTrackId, proto.TrackLabel.DEFAULT_VIDEO);
    if (!Object.keys(mediaStatus).length) return;
    var updateHeader = self.buildHeader(proto.MessageType.CLIENT_MEDIA_UPDATE, activeCall, {});
    // The version is our current SDP session version (see stampOrigin), the
    // same number the renegotiation used; a hard-coded 0 -> 1 was rejected
    // with 409 once the renegotiation had moved it on.
    var mediaVersion = session.sdpVersion || activeCall.clientMediaVersion || 1;
    activeCall.clientMediaVersion = mediaVersion;
    self.send(updateHeader, {
      clientMediaUpdateRequest: {
        fromVersion: mediaVersion,
        toVersion: mediaVersion,
        mediaUpdates: [{ mediaStatus: mediaStatus, mediaStatusEx: { tracks: tracks } }]
      }
    }, function(err) {
      if (err) log.warn("call", "Could not publish the local media state: " + err.message);
      else log.info("call", "Media: published the local media state (" + Object.keys(mediaStatus).length + " track(s))");
    });
  };
};

// The conference describes the other participants' tracks in `mediaStatus`
// maps (join response, server media updates and client media update
// responses). Every remote track has to be subscribed to explicitly, exactly
// like the web client does, or the SFU never forwards it.
CallClient.prototype.subscribeToMediaStatus = function(call, mediaStatus) {
  if (!call || !call.serverInfoData || !mediaStatus || !mediaStatus.tracks) return;
  var self = this;
  call.subscribed = call.subscribed || {};
  var subscriptions = [];
  Object.keys(mediaStatus.tracks).forEach(function(trackId) {
    var track = mediaStatus.tracks[trackId];
    if (!track) return;
    if (track.owner && track.owner === self.ctx.userID) return;
    if (track.enabled === false) return;
    if (track.label != null && track.label !== proto.TrackLabel.DEFAULT_AUDIO &&
      track.label !== proto.TrackLabel.DEFAULT_VIDEO) return;
    if (call.subscribed[trackId]) return;
    call.subscribed[trackId] = true;
    subscriptions.push({
      cname: "",
      options: { videoQuality: proto.VideoQuality.MEDIUM },
      type: proto.SubscriptionType.TRACK,
      trackId: trackId
    });
  });
  if (!subscriptions.length) return;

  var header = this.buildHeader(proto.MessageType.SUBSCRIPTION, call, {});
  this.send(header, { subscriptionRequest: { subscriptions: subscriptions } }, function(err) {
    if (err) log.warn("call", "Could not subscribe to the remote track(s): " + err.message);
    else log.info("call", "Media: subscribed to " + subscriptions.length + " remote track(s)");
  });
};

// Subscribe to the other participants' tracks (SFU conferences only deliver
// tracks the client has subscribed to; the web client subscribes to video too).
CallClient.prototype.subscribeToRemoteAudio = function(call, update) {
  if (!call || !call.serverInfoData) return;
  var self = this;
  call.subscribed = call.subscribed || {};
  var subscriptions = [];
  (update.mediaUpdates || []).forEach(function(mediaUpdate) {
    (mediaUpdate.media || []).forEach(function(track) {
      if (track.type !== proto.MediaType.AUDIO && track.type !== proto.MediaType.VIDEO) return;
      if (track.owner && track.owner === self.ctx.userID) return;
      var key = mediaUpdate.sourceKey + "|" + track.id;
      if (call.subscribed[key]) return;
      call.subscribed[key] = true;
      subscriptions.push({
        cname: mediaUpdate.sourceKey,
        type: proto.SubscriptionType.TRACK,
        trackId: track.id
      });
    });
  });
  if (!subscriptions.length) return;

  var header = this.buildHeader(proto.MessageType.SUBSCRIPTION, call, {});
  this.send(header, { subscriptionRequest: { subscriptions: subscriptions } }, function(err) {
    if (err) log.warn("call", "Could not subscribe to the remote audio: " + err.message);
    else log.info("call", "Media: subscribed to " + subscriptions.length + " remote audio track(s)");
  });
};

// Starts the outgoing audio file a moment after the peer is in the call, so
// the beginning of a WAV is not played to an empty conference. The delay is
// `media.audioDelayMs` (default 500 ms).
CallClient.prototype.startCallAudio = function(call, reason) {
  if (!call || !call.mediaSession || call.audioStarted) return;
  call.audioStarted = true;
  var delay = call.audioDelayMs != null ? call.audioDelayMs : 500;
  log.info("call", "Media: " + reason + "; starting the audio in " + delay + " ms");
  if (typeof call.mediaSession.prewarmVideo === "function") call.mediaSession.prewarmVideo();
  setTimeout(function() {
    if (call.state === "ended" || !call.mediaSession) return;
    call.mediaSession.startAudio();
  }, delay);
};

CallClient.prototype.closeMediaSession = function(session) {
  if (!session) return;
  if (session.e2eeMedia) session.e2eeMedia.close();
  session.close();
  if (this.mediaSession === session) this.mediaSession = null;
  if (this.mediaCall && this.mediaCall.mediaSession === session) this.mediaCall = null;
  this.pendingLocalCandidates = [];
};

CallClient.prototype.sendIceCandidate = function(call, candidate) {
  var header = this.buildHeader(proto.MessageType.ICE_CANDIDATE, call, {});
  this.send(header, {
    iceCandidateRequest: {
      iceCandidateSdps: [{
        candidateSdpString: candidate.candidate,
        sdpMLineIndex: candidate.sdpMLineIndex || 0,
        sdpMid: candidate.sdpMid || "0"
      }]
    }
  }, function(err) {
    if (err) log.warn("call", "Could not send an ICE candidate: " + err.message);
  });
};

CallClient.prototype.flushLocalCandidates = function(call) {
  if (!call || !call.serverInfoData) return;
  var queued = this.pendingLocalCandidates;
  this.pendingLocalCandidates = [];
  var self = this;
  queued.forEach(function(candidate) {
    self.sendIceCandidate(call, candidate);
  });
};

// Generic data messages carry the call E2EE key exchange ("E2eeKey" topic);
// the frame_encryption wasm consumes them (see src/rtc/e2eeMedia.js).
CallClient.prototype.onDataMessage = function(message) {
  var request = message.messageBody.dataMessageRequest;
  if (!request || !request.message) return;
  var generic = request.message.body && request.message.body.genericMessage;
  if (!generic || !generic.data) return;

  var call = this.findCallForMessage(message);
  // Acknowledge every data message with an empty response carrying the same
  // transaction (that is how the web client stops the sender's retries).
  var ackHeader = this.buildHeader(proto.MessageType.DATA_MESSAGE, call, {
    transactionId: message.messageHeader.transactionId,
    responseStatusCode: proto.RtcResponseStatusCode.OK
  });
  this.send(ackHeader, {}, function(err) {
    if (err) log.verbose("call", "Could not acknowledge a data message: " + err.message);
  });

  var session = call && call.mediaSession && call.mediaSession.e2eeMedia;
  if (generic.topic === "E2eeKey") {
    log.verbose("call", "E2EE media: received " + generic.data.length + " bytes of key material");
    if (session) session.processE2eeMessage(generic.data);
    return;
  }
  log.verbose("call", "Ignoring data message with topic " + generic.topic);
};

// State-sync updates can carry the call E2EE state: either a sync payload
// with a stateStore or an "E2eeState" topic update.
CallClient.prototype.onUpdateRequest = function(message) {
  var update = message.messageBody.updateRequest;
  if (!update) return;
  var call = this.findCallForMessage(message);
  var session = call && call.mediaSession && call.mediaSession.e2eeMedia;
  if (!session) return;

  var stateStore = update.syncPayload && update.syncPayload.stateStore;
  if (stateStore && stateStore.E2eeState && stateStore.E2eeState.data) {
    log.info("call", "E2EE media: processing an E2eeState state-sync update");
    session.processServerState(stateStore.E2eeState.data);
    return;
  }
  if (update.topic === "E2eeState" && update.data && update.data.length) {
    log.info("call", "E2EE media: processing an E2eeState topic update");
    session.processServerState(update.data);
  }
};

CallClient.prototype.onIceCandidate = function(message) {
  var request = message.messageBody.iceCandidateRequest;
  if (!request) return;
  var call = this.findCallForMessage(message);
  var session = (call && call.mediaSession) || this.mediaSession;
  if (!session) return;
  (request.iceCandidateSdps || []).forEach(function(candidate) {
    if (!candidate.candidateSdpString) return;
    session.addRemoteCandidate({
      candidate: candidate.candidateSdpString,
      sdpMid: candidate.sdpMid || "0",
      sdpMLineIndex: Number(candidate.sdpMLineIndex) || 0
    }, function(err) {
      if (err) log.verbose("call", "Could not add a remote ICE candidate: " + err.message);
    });
  });
};

function mediaUnavailableError() {
  return {
    error:
      "call: real media (`media: true`) needs the optional 'werift' package. " +
      "Install it with `npm install werift`, or omit `media` for " +
      "signaling-only calls.",
    mediaRequired: true
  };
}

CallClient.prototype.ensureE2eeDevice = function(callback) {
  var device = e2eeState.loadDevice(this.ctx.globalOptions.e2eeDevicePath);
  if (device && device.identity_key_pub && device.signed_pre_key && device.pre_keys) {
    return callback();
  }
  if (!this.defaultFuncs) {
    return callback({
      error:
        "call: this is an end-to-end encrypted call and no E2EE device is " +
        "registered. Run api.connectE2EE() first, or pass `e2eeState`.",
      e2eeRequired: true
    });
  }

  // Register this library as an E2EE device (same flow sendMessage uses).
  var E2EEClient = require("../e2ee/client").E2EEClient;
  if (!this.ctx.e2eeClient) {
    this.ctx.e2eeClient = new E2EEClient(this.ctx, this.defaultFuncs);
  }
  log.info("call", "Registering an E2EE device for the call...");
  this.ctx.e2eeClient.connect(function(err) {
    if (err) {
      return callback({
        error: "call: could not register an E2EE device for the call.",
        detail: err && (err.error || err.message || err),
        e2eeRequired: true
      });
    }
    callback();
  });
};

// ---------------------------------------------------------------------------
// MQTT transport
// ---------------------------------------------------------------------------

CallClient.prototype.ensureConnected = function(callback) {
  var self = this;
  if (this.connected) return callback();

  if (this.connectCallbacks.length) {
    this.connectCallbacks.push(callback);
    return;
  }
  this.connectCallbacks.push(callback);

  var sessionID = Math.floor(Math.random() * 9007199254740991) + 1;
  this.deviceID = randomUuid();

  var username = {
    u: this.ctx.userID,
    s: sessionID,
    chat_on: true,
    fg: true,
    d: this.deviceID,
    ct: "websocket",
    aid: mqttAppID,
    mqtt_sid: "",
    cp: 3,
    ecp: 10,
    st: [signalingTopic],
    pm: [],
    dc: "",
    no_auto_fg: true,
    gas: null
  };
  var cookies = this.ctx.jar.getCookies("https://www.facebook.com").join("; ");

  var options = {
    clientId: "mqttwsclient",
    protocolId: "MQIsdp",
    protocolVersion: 3,
    username: JSON.stringify(username),
    clean: true,
    wsOptions: {
      headers: {
        "Cookie": cookies,
        "Origin": "https://www.facebook.com",
        "User-Agent": this.ctx.globalOptions.userAgent,
        "Referer": "https://www.facebook.com",
        "Host": "edge-chat.facebook.com"
      },
      origin: "https://www.facebook.com",
      protocolVersion: 13
    }
  };

  var host = "wss://edge-chat.facebook.com/chat?sid=" + sessionID;
  this.mqttClient = new (require("mqtt").Client)(function() {
    return websocket.mqtt(host, options.wsOptions);
  }, options);
  websocket.mqttReconnectBackoff(this.mqttClient);

  function finish(err) {
    var callbacks = self.connectCallbacks;
    self.connectCallbacks = [];
    callbacks.forEach(function(cb) {
      cb(err);
    });
  }

  this.mqttClient.on("connect", function() {
    log.info("call", "Signaling connection established");
    self.connected = true;
    finish();
    self.flushQueue();
  });

  this.mqttClient.on("message", function(topic, message) {
    if (topic !== signalingTopic) return;
    self.handleMessage(message);
  });

  this.mqttClient.on("error", function(err) {
    log.error("call", err && err.message ? err.message : err);
    if (!self.connected) {
      finish(err || { error: "Connection refused: Server unavailable" });
    }
  });

  this.mqttClient.on("close", function() {
    self.connected = false;
  });
};

CallClient.prototype.flushQueue = function() {
  var self = this;
  var queue = this.sendingQueue;
  this.sendingQueue = [];
  queue.forEach(function(item) {
    self.publish(item.payload, item.callback);
  });
};

CallClient.prototype.publish = function(payload, callback) {
  if (!this.mqttClient || !this.connected) {
    this.sendingQueue.push({ payload: payload, callback: callback });
    return;
  }
  this.mqttClient.publish(signalingTopic, payload, { qos: 1, retain: false }, function(err) {
    if (callback) callback(err);
  });
};

CallClient.prototype.send = function(header, body, callback) {
  var self = this;
  this.ensureConnected(function(err) {
    if (err) return callback && callback(err);
    var payload;
    try {
      payload = proto.serializeMessage({ messageHeader: header, messageBody: body });
    } catch (e) {
      return callback && callback(e);
    }
    log.verbose("call", "Sending " + header.type + " (" + payload.length + " bytes)");
    self.publish(payload, callback);
  });
};

CallClient.prototype.buildHeader = function(type, call, extra) {
  var header = {
    type: type,
    conferenceName: "",
    transactionId: newId(),
    retryCount: 0,
    clientStack: proto.ClientStack.ZENON,
    clientSessionId: (call && call.clientSessionId) || newId(),
    sender: { id: this.ctx.userID }
  };
  if (call) {
    if (call.conferenceName) header.conferenceName = call.conferenceName;
    if (call.serverInfoData) header.serverInfoData = call.serverInfoData;
    if (call.conferenceType != null) header.conferenceType = call.conferenceType;
  }
  if (extra) {
    Object.keys(extra).forEach(function(key) {
      header[key] = extra[key];
    });
  }
  return header;
};

// ---------------------------------------------------------------------------
// Incoming signaling
// ---------------------------------------------------------------------------

CallClient.prototype.handleMessage = function(message) {
  var decoded;
  try {
    decoded = proto.deserializeMessage(message);
  } catch (e) {
    log.warn("call", "Could not decode signaling message: " + e.message);
    return;
  }
  var header = decoded.messageHeader || {};
  log.verbose("call", "Received " + header.type + " transaction " + header.transactionId);
  log.verbose("call", "  " + JSON.stringify(decoded, function(key, value) {
    if (Buffer.isBuffer(value)) {
      var text = value.toString("utf8");
      return /^[\x20-\x7e\r\n]*$/.test(text) ? text : "0x" + value.toString("hex");
    }
    return value;
  }));

  try {
    switch (header.type) {
      case proto.MessageType.JOIN:
        if (header.responseStatusCode != null) this.onJoinResponse(decoded);
        break;
      case proto.MessageType.RING:
        if (header.responseStatusCode == null) this.onRingRequest(decoded);
        break;
      case proto.MessageType.SERVER_MEDIA_UPDATE:
        this.onServerMediaUpdate(decoded);
        break;
      case proto.MessageType.CLIENT_MEDIA_UPDATE:
        this.onClientMediaUpdate(decoded);
        break;
      case proto.MessageType.ICE_CANDIDATE:
        if (header.responseStatusCode == null) this.onIceCandidate(decoded);
        break;
      case proto.MessageType.HANGUP:
        if (header.responseStatusCode == null) this.onHangup(decoded);
        break;
      case proto.MessageType.DISMISS:
        if (header.responseStatusCode == null) this.onDismiss(decoded);
        break;
      case proto.MessageType.CONFERENCE_STATE:
        this.onConferenceState(decoded);
        break;
      case proto.MessageType.DATA_MESSAGE:
        if (header.responseStatusCode == null) this.onDataMessage(decoded);
        break;
      case proto.MessageType.UPDATE:
        if (header.responseStatusCode == null) this.onUpdateRequest(decoded);
        break;
      case proto.MessageType.NOTIFY:
        if (header.responseStatusCode == null) this.onNotifyRequest(decoded);
        break;
      case proto.MessageType.APPROVAL:
        this.emitCallEvent("approval", this.calls[header.conferenceName], decoded);
        break;
    }
  } catch (e) {
    log.error("call", e);
  }
};

CallClient.prototype.findCallForMessage = function(message) {
  var header = message.messageHeader || {};

  // Responses echo the request's transaction id.
  var byTransaction = header.transactionId && this.pendingTransactions[header.transactionId];
  if (byTransaction) return byTransaction;

  // Otherwise fall back to the conference, which every message carries.
  var callIDs = Object.keys(this.calls);
  for (var i = 0; i < callIDs.length; i++) {
    var call = this.calls[callIDs[i]];
    if (header.conferenceName && call.conferenceName === header.conferenceName) return call;
    if (header.clientSessionId && call.clientSessionId === header.clientSessionId) return call;
  }
  return null;
};

CallClient.prototype.rememberCall = function(call) {
  this.calls[call.callID] = call;
  if (call.transactionId) this.pendingTransactions[call.transactionId] = call;
};

CallClient.prototype.onJoinResponse = function(message) {
  var header = message.messageHeader;
  var response = message.messageBody.joinResponse || {};
  var call = this.findCallForMessage(message);

  if (!call) {
    log.warn("call", "JOIN response for unknown call " + header.conferenceName);
    return;
  }

  // Facebook answers a rejected join with a non-OK status in the header.
  if (header.responseStatusCode != null &&
    header.responseStatusCode !== proto.RtcResponseStatusCode.OK) {
    var error = {
      error: "call: Facebook rejected the call join.",
      code: header.responseStatusCode,
      subcode: header.responseSubCode,
      detail: header.responseStatusMessage
    };
    if (call.settle) call.settle(error);
    this.endCallState(call, proto.HangupReason.CLIENT_ERROR);
    return;
  }

  call.conferenceName = header.conferenceName || call.conferenceName;
  call.serverInfoData = header.serverInfoData || call.serverInfoData;
  if (header.conferenceType != null) call.conferenceType = header.conferenceType;
  call.mediaPath = response.mediaPath;
  call.answerSdp = (response.answer && response.answer.sdpString) || call.answerSdp;

  // E2EE calls: the server E2eeState carries the call's key material. The
  // frame_encryption wasm derives the frame keys from it and answers with
  // E2eeKey data messages to the peer.
  if (call.mediaSession && call.mediaSession.e2eeMedia && response.stateStore &&
    response.stateStore.E2eeState && response.stateStore.E2eeState.data) {
    log.info("call", "E2EE media: processing the server E2eeState from the join response");
    call.mediaSession.e2eeMedia.processServerState(response.stateStore.E2eeState.data);
  }

  // Media: the join response can already carry the answer (P2P), and local
  // ICE candidates can now be sent because the conference is known.
  if (call.mediaSession && call.answerSdp && !call.remoteDescriptionSet) {
    call.remoteDescriptionSet = true;
    log.info("call", "Media: applying the remote answer from the join response");
    call.mediaSession.setRemoteAnswer(call.answerSdp, function(err) {
      if (err) log.warn("call", "Could not apply the WebRTC answer: " + err.message);
    });
  }
  if (call.mediaSession) {
    this.mediaCall = call;
    this.flushLocalCandidates(call);
    this.refreshMediaRelays(call, response.relayInfo);
    // In a JOIN response `mediaStatus` is a plain {trackId: bool} map; the
    // track details (owner, label) are in `mediaStatusEx`. Passing the plain
    // map meant the peer's video was never subscribed to, so the SFU never
    // forwarded it (Messenger web subscribes to it right after joining).
    this.subscribeToMediaStatus(call, response.mediaStatusEx);
  }

  if (call.direction === "outgoing" && call.state === "starting") {
    call.state = "ringing";
    call.startedAt = Date.now();
    this.emitCallEvent("calling", call);
    if (call.settle) call.settle();
  } else if (call.direction === "incoming" && call.state === "joining") {
    // Our own accept join was acknowledged; the call is up.
    this.setConnected(call);
  }
};

CallClient.prototype.onRingRequest = function(message) {
  var header = message.messageHeader;
  var ring = message.messageBody.ringRequest || {};
  var context = findJoiningContext(message) || {};

  var peerID = context.peer_id || ring.caller;
  var callID = context.group_thread_id || peerID;

  var existing = this.calls[callID];
  if (existing && existing.state !== "ended") {
    log.info("call", "Ignoring duplicate RING for " + callID);
    return;
  }

  var call = {
    callID: callID,
    threadID: callID,
    peerID: peerID,
    callerID: ring.caller,
    isGroup: !!context.group_thread_id,
    groupThreadID: context.group_thread_id,
    direction: "incoming",
    state: "incoming",
    conferenceName: header.conferenceName,
    conferenceType: header.conferenceType,
    serverInfoData: header.serverInfoData,
    clientSessionId: newId(),
    transactionId: header.transactionId,
    ringTransactionId: header.transactionId,
    isVideo: ring.ringType === proto.RingType.PEER_VIDEO_CALL ||
      ring.ringType === proto.RingType.GROUP_VIDEO_CALL,
    ringType: ring.ringType,
    mediaPath: ring.mediaPath,
    offerSdp: ring.offer && ring.offer.sdpString,
    relayInfo: ring.relayInfo,
    e2eeEnforcement: ring.e2eeEnforcement,
    e2eeMandated: !!(ring.e2eeEnforcement &&
      ring.e2eeEnforcement.mode === proto.E2eeMode.E2EE_MANDATED),
    startedAt: Date.now()
  };
  this.rememberCall(call);

  // Acknowledge the ring exactly like the web client does, so the caller knows
  // this device is ringing.
  this.acknowledgeRing(call);
  this.emitCallEvent("ring", call);
};

CallClient.prototype.acknowledgeRing = function(call) {
  var header = this.buildHeader(proto.MessageType.RING, call, {
    transactionId: call.ringTransactionId,
    responseStatusCode: proto.RtcResponseStatusCode.OK,
    responseSubCode: 0
  });
  this.send(header, { ringResponse: { deviceStatus: proto.DeviceStatus.OK } }, function(err) {
    if (err) log.warn("call", "Could not acknowledge ring: " + err.message);
  });
};

CallClient.prototype.onServerMediaUpdate = function(message) {
  var call = this.findCallForMessage(message);
  if (!call) return;
  var update = message.messageBody.serverMediaUpdateRequest || {};
  var answer = (update.answer && update.answer.sdpString) || "";
  log.info("call", "Media: server media update v" + update.fromVersion + "->" + update.toVersion +
    " mediaPath=" + update.mediaPath +
    " offer=" + ((update.offer && update.offer.sdpString) ? update.offer.sdpString.length : 0) +
    " answer=" + answer.length +
    " relay=" + (update.relayInfo ? "yes" : "no") +
    " stateStore=" + (update.stateStore ? Object.keys(update.stateStore).join(",") : "-"));
  if (answer) {
    call.answerSdp = answer;
    if (call.mediaSession && !call.remoteDescriptionSet) {
      call.remoteDescriptionSet = true;
      log.info("call", "Media: applying the remote answer from a server media update");
      call.mediaSession.setRemoteAnswer(answer, function(err) {
        if (err) log.warn("call", "Could not apply the WebRTC answer: " + err.message);
      });
    }
  }
  // The server escalates a call to the SFU by requesting a renegotiation
  // (`renegotiationRequested`); the client acknowledges it and then sends a
  // fresh offer as a CLIENT_MEDIA_UPDATE request (the SFU answers).
    if (update.renegotiationRequested === true) {
      call.renegotiationRequested = true;
      this.acknowledgeRenegotiation(call, message, update);
    this.initiateClientRenegotiation(call, update);
    if (call.state !== "connected") this.setConnected(call);
    return;
  }

  if (call.mediaSession) {
    this.mediaCall = call;
    this.flushLocalCandidates(call);
    this.subscribeToRemoteAudio(call, update);
    this.subscribeToMediaStatus(call, update.mediaStatus);
    this.renegotiateForPeerStreams(call, update);
  }

  // State-sync updates can carry a newer server E2eeState (key rotation).
  if (call.mediaSession && call.mediaSession.e2eeMedia && update.stateStore &&
    update.stateStore.E2eeState && update.stateStore.E2eeState.data) {
    log.info("call", "E2EE media: processing a server E2eeState update");
    call.mediaSession.e2eeMedia.processServerState(update.stateStore.E2eeState.data);
  }

  // The SFU renegotiates through server media update *requests*: an embedded
  // offer has to be answered with a serverMediaUpdateResponse carrying the
  // new answer (the web client does this too).
  if (update.offer && update.offer.sdpString && call.mediaSession) {
    this.answerServerMediaUpdate(call, message, update);
  } else if (update.renegotiationRequested !== true) {
    // Every other server media update still has to be acknowledged with the
    // new version; without the acknowledgement the server retries the same
    // update forever and never advances the media state (video forwarding
    // waits for this acknowledgement).
    this.acknowledgeMediaUpdate(call, message, update);
  }

  if ((answer || update.toVersion) && call.state !== "connected") {
    this.setConnected(call);
  }
};

// The E2EE stack learns the peer's media identity ("<userId>:<cname>") from
// the a=ssrc cname of the peer's streams in an SDP from the server; until then
// our E2EE key isn't sent and the peer can't decrypt our audio or video. The
// server adds the peer's streams either to its answer to our renegotiation
// (when the peer is already set up) or through an offer in a later update;
// in calls we place that later update often arrives without one. So when the
// server announces the peer's tracks and we still don't know their cname,
// renegotiate once more on the same connection: the answer then lists them.
CallClient.prototype.renegotiateForPeerStreams = function(call, update) {
  var session = call.mediaSession;
  if (!session || !session.e2eeMedia || session.remoteCname) return;
  // A call escalated from P2P renegotiates once the server asks it to; a call
  // that joined the SFU directly never gets that request, and without this
  // renegotiation the peer never received our key.
  if (call.peerStreamsRenegotiated) return;
  if (!call.renegotiationRequested && call.mediaPath !== proto.MediaPath.SFU) return;
  if (update.offer && update.offer.sdpString) return;
  if (!session.remoteDescriptionSet) return;
  var self = this;
  var tracks = (update.mediaStatus && update.mediaStatus.tracks) || {};
  var peerTracks = Object.keys(tracks).filter(function(id) {
    var track = tracks[id];
    return track && track.owner && String(track.owner) !== String(self.ctx.userID);
  });
  if (!peerTracks.length) return;
  call.peerStreamsRenegotiated = true;
  log.info("call", "Media: the peer's streams aren't in our SDP yet; renegotiating to get them");
  this.initiateClientRenegotiation(call, {});
};

// Acknowledges a server media update: the response echoes the version the
// client has (currentVersion = the update's toVersion).
CallClient.prototype.acknowledgeMediaUpdate = function(call, message, update) {
  var header = this.buildHeader(proto.MessageType.SERVER_MEDIA_UPDATE, call, {
    transactionId: message.messageHeader.transactionId,
    responseStatusCode: proto.RtcResponseStatusCode.OK
  });
  var version = update.toVersion != null ? String(update.toVersion) : "0";
  this.send(header, {
    serverMediaUpdateResponse: { currentVersion: version }
  }, function(err) {
    if (err) log.warn("call", "Could not acknowledge the media update: " + err.message);
    else log.verbose("call", "Media: acknowledged the media update (v" + version + ")");
  });
};

// Acknowledges an SMU renegotiation request: the response echoes the version
// the client has (the web client sends currentVersion = the SMU's toVersion).
CallClient.prototype.acknowledgeRenegotiation = function(call, message, update) {
  var header = this.buildHeader(proto.MessageType.SERVER_MEDIA_UPDATE, call, {
    transactionId: message.messageHeader.transactionId,
    responseStatusCode: proto.RtcResponseStatusCode.OK
  });
  var version = update.toVersion != null ? String(update.toVersion) : "0";
  this.send(header, {
    serverMediaUpdateResponse: { currentVersion: version }
  }, function(err) {
    if (err) log.warn("call", "Could not acknowledge the renegotiation request: " + err.message);
    else log.info("call", "Media: acknowledged the renegotiation request (v" + version + ")");
  });
};

// Client-initiated renegotiation (SFU escalation): the client sends a new
// offer in a CLIENT_MEDIA_UPDATE request and the server answers with a
// clientMediaUpdateResponse.
CallClient.prototype.initiateClientRenegotiation = function(call, update) {
  if (!call.mediaSession) return;
  var self = this;

  // werift gathers ICE candidates once per peer connection, so the relays the
  // SFU just handed out only make it into the SDP when the media session is
  // recreated. That is what makes the SFU path reachable on networks that
  // block direct UDP.
  var session = call.mediaSession;
  // Messenger web renegotiates on the same connection, keeping its tracks. A
  // recreated session has new track ids, DTLS fingerprint and cname that the
  // server never saw in the JOIN, and the server accepted such an offer but
  // never answered it. Recreating (to pick up the relays) is opt-in, for
  // networks where only the TURN relays work.
  if (update.relayInfo && session.options && session.options.recreateForRelays === true) {
    var servers = turn.toIceServers(update.relayInfo);
    if (servers.length) {
      // Facebook's SFU advertises UDP and TCP host candidates; on networks
      // that block UDP the plain TURN-over-TCP relay (port 8080) is the way
      // in, so prefer it unless the caller asked for something else. The
      // recreated session gathers the relay only: direct connectivity is
      // exactly what just failed (that is why the server escalated).
      var transport = (session.options && session.options.turnTransport) || "tcp";
      var mediaOptions = Object.assign({}, session.options, {
        iceServers: turn.orderForTransport(servers, transport)
      });
      var recreated = media.createMediaSession(mediaOptions);
      if (recreated) {
        log.info("call", "Media: recreating the media session with the SFU relays (" +
          servers.length + " server(s))");
        this.attachMediaSession(recreated, call);
        call.mediaSession = recreated;
        if (recreated.trackIds) {
          call.audioTrackId = recreated.trackIds.audio;
          call.videoTrackId = recreated.trackIds.video;
        }
        // The new session has to (re)start its own audio/video.
        call.audioStarted = false;
        session.close();
        session = recreated;
      }
    }
  }

  // The renegotiation carries a new offer but no media-state change, so the
  // version stays the same (Messenger web sends e.g. 7 -> 7). Bumping it
  // (0 -> 1) got the update rejected with 503 "Endpoint rate-limited".
  var version = call.clientMediaVersion || 0;
  var nextVersion = version;
  session.createOffer(function(err, sdp) {
    if (err) {
      log.warn("call", "Could not create the renegotiation offer: " + err.message);
      return;
    }
    if (session.e2eeMedia && session.localCname) {
      session.e2eeMedia.setLocalE2eeId(self.ctx.userID + ":" + session.localCname);
    }
    self.withDtlsAuth(sdp, { e2ee: call.e2ee }, function(authErr, signedSdp) {
      var mediaStatus = {};
      var tracks = {};
      function addTrack(id, label) {
        if (!id) return;
        mediaStatus[id] = true;
        tracks[id] = {
          enabled: true,
          customVideoContentType: 0,
          customAudioContentType: 0,
          label: label
        };
      }
      addTrack(call.audioTrackId, proto.TrackLabel.DEFAULT_AUDIO);
      addTrack(call.videoTrackId, proto.TrackLabel.DEFAULT_VIDEO);
      // The versions are the offer's SDP session version (the second number
      // of its o= line); Messenger web's "7 -> 7" goes with "o=- <id> 7 ...".
      // With any other number the server accepts the update but never
      // answers the offer.
      var origin = /^o=\S+\s+\d+\s+(\d+)/m.exec(signedSdp);
      if (origin) {
        version = Number(origin[1]);
        nextVersion = version;
      }
      var header = self.buildHeader(proto.MessageType.CLIENT_MEDIA_UPDATE, call, {});
      self.send(header, {
        clientMediaUpdateRequest: {
          fromVersion: version,
          toVersion: nextVersion,
          mediaUpdates: [{ mediaStatus: mediaStatus, mediaStatusEx: { tracks: tracks } }],
          offer: { sdpString: signedSdp }
        }
      }, function(sendErr) {
        if (sendErr) log.warn("call", "Could not send the renegotiation offer: " + sendErr.message);
        else {
          call.clientMediaVersion = nextVersion;
          log.info("call", "Media: sent the renegotiation offer (" + signedSdp.length + " bytes, v" +
            version + "->" + nextVersion + ")");
        }
      });
    });
  });
};

CallClient.prototype.answerServerMediaUpdate = function(call, message, update) {
  var self = this;
  var header = this.buildHeader(proto.MessageType.SERVER_MEDIA_UPDATE, call, {
    transactionId: message.messageHeader.transactionId,
    responseStatusCode: proto.RtcResponseStatusCode.OK
  });

  // Every published track, like the join: leaving the video out here told the
  // conference our video was gone after each SFU renegotiation.
  function mediaStatus() {
    if (!call.audioTrackId) return undefined;
    var tracks = {};
    [[call.audioTrackId, proto.TrackLabel.DEFAULT_AUDIO],
      [call.videoTrackId, proto.TrackLabel.DEFAULT_VIDEO]].forEach(function(entry) {
      if (!entry[0]) return;
      tracks[entry[0]] = {
        enabled: true,
        customVideoContentType: 0,
        customAudioContentType: 0,
        label: entry[1]
      };
    });
    return { tracks: tracks };
  }

  call.mediaSession.createAnswer(update.offer.sdpString, function(err, answerSdp) {
    if (err) {
      log.warn("call", "Could not answer the server media update offer: " + err.message);
      return;
    }
    var response = {
      currentVersion: update.toVersion != null ? update.toVersion : 0,
      answer: { sdpString: answerSdp }
    };
    var status = mediaStatus();
    if (status) response.mediaStatus = status;
    self.send(header, { serverMediaUpdateResponse: response }, function(sendErr) {
      if (sendErr) log.warn("call", "Could not send the server media update response: " + sendErr.message);
      else log.info("call", "Media: answered the SFU renegotiation offer");
    });
  });
};

CallClient.prototype.onClientMediaUpdate = function(message) {
  var call = this.findCallForMessage(message);
  if (!call) return;
  this.emitCallEvent("media", call, message);

  // A rejected media update (e.g. 503 "Endpoint rate-limited") has no body;
  // the renegotiation it carried never takes effect, so say so.
  var header = message.messageHeader || {};
  if (header.responseStatusCode != null && header.responseStatusCode !== proto.RtcResponseStatusCode.OK) {
    log.warn("call", "Facebook rejected a media update: " + header.responseStatusCode +
      (header.responseSubCode != null ? "/" + header.responseSubCode : "") +
      (header.responseStatusMessage ? " " + header.responseStatusMessage : ""));
  }

  var response = message.messageBody.clientMediaUpdateResponse;
  if (!response) return;

  this.subscribeToMediaStatus(call, response.mediaStatus);

  if (call.mediaSession && call.mediaSession.e2eeMedia && response.stateStore &&
    response.stateStore.E2eeState && response.stateStore.E2eeState.data) {
    log.info("call", "E2EE media: processing the server E2eeState from a media update response");
    call.mediaSession.e2eeMedia.processServerState(response.stateStore.E2eeState.data);
  }

  var answer = (response.answer && response.answer.sdpString) || "";
  if (answer && call.mediaSession) {
    log.info("call", "Media: applying the remote answer from a media update response");
    call.mediaSession.setRemoteAnswer(answer, function(err) {
      if (err) log.warn("call", "Could not apply the renegotiation answer: " + err.message);
    });
  }
};

// ParticipantCallState names for logging (MultiwayCommonTypes).
var participantStates = {
  0: "UNKNOWN", 1: "DISCONNECTED", 2: "NO_ANSWER", 3: "REJECTED", 4: "UNREACHABLE",
  5: "CONNECTION_DROPPED", 6: "CONTACTING", 7: "RINGING", 8: "CONNECTING", 9: "CONNECTED",
  10: "PARTICIPANT_LIMIT", 11: "IN_ANOTHER_CALL", 12: "RING_TYPE_UNSUPPORTED",
  13: "PENDING_APPROVAL", 14: "APPROVED", 15: "FAILED_APPROVAL", 16: "HANGUP_IN_WAITING_ROOM",
  17: "UNCALLABLE", 18: "UNCALLABLE_DELAYED"
};

// The server asks a joined participant for its conference state; the web
// client acknowledges with the version it has.
CallClient.prototype.onConferenceState = function(message) {
  var request = message.messageBody.conferenceStateRequest;
  if (!request) return;

  var call = this.findCallForMessage(message);

  // Track every participant's call state, so it is visible whether the other
  // side actually reached CONNECTED in this conference.
  var self = this;
  if (request.participantStates && call) {
    var states = call.participantStates || {};
    Object.keys(request.participantStates).forEach(function(userID) {
      var state = request.participantStates[userID].state;
      if (states[userID] === state) return;
      states[userID] = state;
      log.info("call", "Media: participant " + userID + " is " +
        (participantStates[state] || state));
      // Release a held audio file only once someone else is really in the call.
      if (userID !== self.ctx.userID && state === 9) {
        self.startCallAudio(call, "peer joined");
        self.refreshE2eeState(call);
      }
    });
    call.participantStates = states;
  }

  var header = this.buildHeader(proto.MessageType.CONFERENCE_STATE, call, {
    conferenceName: message.messageHeader.conferenceName,
    serverInfoData: message.messageHeader.serverInfoData,
    conferenceType: message.messageHeader.conferenceType,
    transactionId: message.messageHeader.transactionId,
    responseStatusCode: proto.RtcResponseStatusCode.OK
  });
  this.send(header, {
    conferenceStateResponse: { currentVersion: request.version }
  }, function(err) {
    if (err) log.warn("call", "Could not answer conference state request: " + err.message);
  });
};

// In a call we place, the peer joins after our media state was published, so
// the E2eeState we got back doesn't list them: the frame-encryption stack
// never sends them our key and they can't decrypt our audio or video.
// Messenger web re-sends its media state with unchanged versions a few seconds
// after joining; the server's answer (handled in onClientMediaUpdate) carries
// the current E2eeState. Do the same once, when the peer joins.
CallClient.prototype.refreshE2eeState = function(call) {
  if (!call || call.e2eeStateRefreshed || call.clientMediaVersion == null) return;
  if (!call.mediaSession || !call.mediaSession.e2eeMedia) return;
  call.e2eeStateRefreshed = true;

  var mediaStatus = {};
  var tracks = {};
  function addTrack(id, label) {
    if (!id) return;
    mediaStatus[id] = true;
    tracks[id] = { enabled: true, customVideoContentType: 0, customAudioContentType: 0, label: label };
  }
  addTrack(call.audioTrackId, proto.TrackLabel.DEFAULT_AUDIO);
  addTrack(call.videoTrackId, proto.TrackLabel.DEFAULT_VIDEO);
  var version = call.clientMediaVersion;
  var header = this.buildHeader(proto.MessageType.CLIENT_MEDIA_UPDATE, call, {});
  this.send(header, {
    clientMediaUpdateRequest: {
      fromVersion: version,
      toVersion: version,
      mediaUpdates: [{ mediaStatus: mediaStatus, mediaStatusEx: { tracks: tracks } }]
    }
  }, function(err) {
    if (err) log.warn("call", "Could not refresh the E2EE state: " + err.message);
    else log.info("call", "E2EE media: asked for the current E2eeState (peer joined)");
  });
};

// State-sync notifications carry server state (config_engine, coplay, the
// E2eeState, ...). Messenger web answers each one with the topic and version
// it applied; unanswered, the server keeps re-sending them, and in calls we
// placed the E2eeState listing the participant who joined later never came,
// so our E2EE key was never sent and the peer couldn't decrypt our media.
CallClient.prototype.onNotifyRequest = function(message) {
  var call = this.findCallForMessage(message);
  var request = message.messageBody.notifyRequest;
  if (!call || !request) return;

  var stateStore = (request.syncPayload && request.syncPayload.stateStore) || {};
  var topics = Object.keys(stateStore);
  var e2eeState = stateStore.E2eeState;
  if (e2eeState && e2eeState.data && call.mediaSession && call.mediaSession.e2eeMedia) {
    log.info("call", "E2EE media: processing the server E2eeState from a notification");
    call.mediaSession.e2eeMedia.processServerState(e2eeState.data);
  }

  var topic = topics.length ? topics[0] : request.topic;
  var version = topics.length ? stateStore[topics[0]].version : request.version;
  var header = this.buildHeader(proto.MessageType.NOTIFY, call, {
    conferenceName: message.messageHeader.conferenceName,
    serverInfoData: message.messageHeader.serverInfoData,
    conferenceType: message.messageHeader.conferenceType,
    transactionId: message.messageHeader.transactionId,
    responseStatusCode: proto.RtcResponseStatusCode.OK
  });
  this.send(header, { notifyResponse: { topic: topic, version: version } }, function(err) {
    if (err) log.warn("call", "Could not answer a state-sync notification: " + err.message);
  });
};

CallClient.prototype.onHangup = function(message) {
  var call = this.findCallForMessage(message);
  var hangup = message.messageBody.hangupRequest || {};
  if (!call) return;
  this.endCallState(call, hangup.reason);
};

CallClient.prototype.onDismiss = function(message) {
  var call = this.findCallForMessage(message);
  var dismiss = message.messageBody.dismissRequest || {};

  if (call) {
    // DISMISS requests are acknowledged before the invite is dropped.
    var header = this.buildHeader(proto.MessageType.DISMISS, call, {
      transactionId: message.messageHeader.transactionId,
      responseStatusCode: proto.RtcResponseStatusCode.OK,
      responseSubCode: 0
    });
    this.send(header, {}, function(err) {
      if (err) log.warn("call", "Could not acknowledge dismiss: " + err.message);
    });
    this.endCallState(call, dismiss.reason);
  }
};

CallClient.prototype.setConnected = function(call) {
  if (call.state === "connected") return;
  call.state = "connected";
  call.connectedAt = Date.now();
  // The held media starts once the peer's participant state reaches CONNECTED
  // (see onConferenceState). A 1:1 call joined on the SFU is "connected" as
  // soon as the peer accepts, seconds before they are in the call, so it
  // waits for that state too; the timer only covers a state that never comes.
  if (!call.isGroup) {
    var self = this;
    setTimeout(function() {
      if (call.state !== "ended") self.startCallAudio(call, "call connected (no peer state)");
    }, 10000);
  }
  this.emitCallEvent("connected", call);
};

CallClient.prototype.endCallState = function(call, reason) {
  if (call.state === "ended") return;
  if (call.mediaSession) this.closeMediaSession(call.mediaSession);
  call.state = "ended";
  call.endedAt = Date.now();
  call.endReason = reason;
  if (call.endReason != null) {
    Object.keys(proto.DismissReason).forEach(function(name) {
      if (proto.DismissReason[name] === reason) call.endReasonName = name;
    });
  }
  this.emitCallEvent("ended", call);
  delete this.calls[call.callID];
  if (call.transactionId) delete this.pendingTransactions[call.transactionId];
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

CallClient.prototype.emitCallEvent = function(event, call, detail) {
  var payload = {
    type: "call",
    event: event,
    callID: call ? call.callID : undefined,
    threadID: call ? call.threadID : undefined,
    peerID: call ? call.peerID : undefined,
    direction: call ? call.direction : undefined,
    isGroup: call ? !!call.isGroup : undefined,
    isVideo: call ? !!call.isVideo : undefined,
    state: call ? call.state : undefined,
    timestamp: Date.now()
  };
  if (call && call.endReasonName) payload.reason = call.endReasonName;
  if (detail) payload.messageType = detail.messageHeader && detail.messageHeader.type;

  log.info("call", event + (call ? " " + call.callID : ""));
  if (this.ctx.globalCallback) {
    (function() {
      this.ctx.globalCallback(null, payload);
    }).call(this);
  } else {
    log.warn("call", "No listenMqtt listener is running; call events are dropped. " +
      "Call api.listenMqtt() to receive them.");
  }
};

// ---------------------------------------------------------------------------
// Public control API
// ---------------------------------------------------------------------------

CallClient.prototype.startCall = function(peerID, options, callback) {
  var self = this;
  options = options || {};
  peerID = peerID.toString();

  // One-to-one Messenger chats are end-to-end encrypted, so calls placed on
  // them are E2EE mandated. Group calls are not.
  if (options.e2ee == null) {
    options.e2ee = !options.groupThreadID;
  }

  this.resolveE2eeState(options, function(stateError) {
    if (stateError) return callback(stateError);
    self.prepareMediaForOutgoing(options, function(mediaError) {
      if (mediaError) return callback(mediaError);
      self.startCallWithJoin(peerID, options, callback);
    });
  });
};

CallClient.prototype.startCallWithJoin = function(peerID, options, callback) {
  var self = this;
  var call = {
    callID: peerID,
    threadID: peerID,
    peerID: peerID,
    invitees: options.invitees || [peerID],
    direction: "outgoing",
    state: "starting",
    clientSessionId: newId(),
    isVideo: !!options.video,
    isGroup: !!options.groupThreadID,
    groupThreadID: options.groupThreadID,
    conferenceType: proto.ConferenceType.ROOM,
    startedAt: Date.now()
  };
  if (this.mediaSession) call.mediaSession = this.mediaSession;
  call.audioTrackId = options.audioTrackId;
  call.videoTrackId = options.videoTrackId;
  call.audioDelayMs = options.audioDelayMs;
  call.e2ee = options.e2ee === true;
  this.rememberCall(call);

  var header = this.buildHeader(proto.MessageType.JOIN, call, {
    conferenceName: "",
    conferenceType: proto.ConferenceType.ROOM,
    sequenceNumber: 0,
    messageTags: []
  });
  if (options.messageTags) header.messageTags = options.messageTags;
  call.transactionId = header.transactionId;

  var joinRequest = buildJoinRequest(call, options);

  // The server answers with a JOIN response once the conference exists and the
  // peer is being rung; onJoinResponse calls settle() at that point.
  var settled = false;
  function settle(err) {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (err) return callback(err);
    callback(null, self.describeCall(call));
  }
  call.settle = settle;

  var timeout = setTimeout(function() {
    if (call.state !== "ringing") {
      self.endCallState(call, proto.HangupReason.CLIENT_ERROR);
      return settle({ error: "call: timed out waiting for Facebook to accept the call." });
    }
  }, options.timeout || 20000);

  this.emitCallEvent("starting", call);

  this.send(header, { joinRequest: joinRequest }, function(err) {
    if (err) {
      if (call.state !== "ended") self.endCallState(call, proto.HangupReason.CLIENT_ERROR);
      return settle({ error: "call: failed to send the call request.", err: err });
    }
  });
};

CallClient.prototype.accept = function(callID, options, callback) {
  var self = this;
  options = options || {};
  var call = this.resolveCall(callID, callback);
  if (!call) return;

  if (call.direction !== "incoming" || call.state === "ended") {
    return callback({ error: "acceptCall: no incoming call to accept." });
  }
  if (call.state === "joining" || call.state === "connected") {
    return callback({ error: "acceptCall: this call is already accepted." });
  }

  if (options.e2ee == null) {
    options.e2ee = !!call.e2eeMandated;
  }
  this.resolveE2eeState(options, function(stateError) {
    if (stateError) return callback(stateError);
    self.prepareMediaForIncoming(call, options, function(mediaError) {
      if (mediaError) return callback(mediaError);
      self.acceptWithJoin(call, options, callback);
    });
  });
};

CallClient.prototype.acceptWithJoin = function(call, options, callback) {
  var self = this;
  call.audioTrackId = options.audioTrackId;
  call.videoTrackId = options.videoTrackId;
  call.audioDelayMs = options.audioDelayMs;
  call.e2ee = options.e2ee === true;
  call.state = "joining";
  if (call.isGroup == null) call.isGroup = !!call.groupThreadID;
  // The join response carries the answer to our offer; without the session on
  // the call it can never be applied and the media stays unnegotiated.
  if (this.mediaSession) call.mediaSession = this.mediaSession;
  var header = this.buildHeader(proto.MessageType.JOIN, call, {
    sequenceNumber: 0,
    messageTags: []
  });
  call.transactionId = header.transactionId;

  // Accepting client: same join body, but no usersToCall/appMessages because
  // the conference already exists.
  call.direction = call.direction === "incoming" ? "incoming" : call.direction;
  var joinRequest = buildJoinRequest(call, options);

  this.send(header, { joinRequest: joinRequest }, function(err) {
    if (err) {
      call.state = "incoming";
      return callback({ error: "acceptCall: failed to join the call.", err: err });
    }
    callback(null, self.describeCall(call));
  });
};

CallClient.prototype.decline = function(callID, callback) {
  return this.hangup(callID, proto.HangupReason.IGNORE_CALL, callback);
};

CallClient.prototype.end = function(callID, callback) {
  return this.hangup(callID, proto.HangupReason.HANGUP_CALL, callback);
};

CallClient.prototype.hangup = function(callID, reason, callback) {
  var self = this;
  var call = this.resolveCall(callID, callback);
  if (!call) return;
  if (call.state === "ended") {
    return callback({ error: "endCall: this call has already ended." });
  }

  var header = this.buildHeader(proto.MessageType.HANGUP, call, {});
  var body = { hangupRequest: { reason: reason, detailedReasonString: "" } };

  this.send(header, body, function(err) {
    if (err) return callback({ error: "endCall: failed to send the hangup.", err: err });
    self.endCallState(call, reason);
    callback(null, self.describeCall(call));
  });
};

CallClient.prototype.resolveCall = function(callID, callback) {
  var callIDs = Object.keys(this.calls);
  if (callID && this.calls[callID]) return this.calls[callID];
  if (!callID && callIDs.length === 1) return this.calls[callIDs[0]];
  if (!callID && callIDs.length === 0) {
    callback({ error: "No active call." });
    return null;
  }
  if (callID) {
    callback({ error: "No active call for " + callID + "." });
  } else {
    callback({ error: "Several calls are active; pass a callID (threadID).", callIDs: callIDs });
  }
  return null;
};

CallClient.prototype.getCalls = function() {
  var self = this;
  return Object.keys(this.calls).map(function(callID) {
    return self.describeCall(self.calls[callID]);
  });
};

CallClient.prototype.describeCall = function(call) {
  return {
    callID: call.callID,
    threadID: call.threadID,
    peerID: call.peerID,
    callerID: call.callerID,
    direction: call.direction,
    state: call.state,
    isGroup: !!call.isGroup,
    isVideo: !!call.isVideo,
    conferenceName: call.conferenceName,
    mediaPath: call.mediaPath,
    startedAt: call.startedAt
  };
};

CallClient.prototype.disconnect = function() {
  if (this.mqttClient) {
    this.mqttClient.end();
    this.mqttClient = null;
  }
  this.connected = false;
};

module.exports = {
  CallClient: CallClient,
  signalingTopic: signalingTopic,
  buildOfferSdp: buildOfferSdp,
  // Exported for the unit tests.
  buildJoinRequest: buildJoinRequest
};
