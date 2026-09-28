"use strict";
/* global BigInt */

// Spec-driven codec for Messenger's "Multiway" (Zenon) call signaling thrift
// messages, as sent on the /t_rtc_multi MQTT topic.
//
// The struct and enum definitions below are transcribed from Meta's Messenger
// web bundle (MultiwayCommonSerializers, MultiwaySharedSerializers,
// DataMessageSerializers, WebrtcSignalingCommonSerializers and
// MqttThriftHeaderSerializers), so the encoding is wire-compatible with the
// official clients. Unknown fields are skipped while decoding.

var thrift = require("./thrift");
var TType = thrift.TType;
var Writer = thrift.Writer;
var Reader = thrift.Reader;
var toBigInt = thrift.toBigInt;

var MessageType = {
  JOIN: 0,
  SERVER_MEDIA_UPDATE: 1,
  HANGUP: 2,
  ICE_CANDIDATE: 3,
  RING: 4,
  DISMISS: 5,
  CONFERENCE_STATE: 6,
  ADD_PARTICIPANTS: 7,
  SUBSCRIPTION: 8,
  CLIENT_MEDIA_UPDATE: 9,
  DATA_MESSAGE: 10,
  REMOVE_PARTICIPANTS: 11,
  PING: 18,
  UPDATE: 20,
  NOTIFY: 21,
  CONNECT: 22,
  CLIENT_EVENT: 23,
  UNSUBSCRIBE: 25,
  APPROVAL: 26,
  TRANSFER: 27,
  WAKEUP: 28
};

var HangupReason = {
  IGNORE_CALL: 0,
  HANGUP_CALL: 1,
  NO_ANSWER_TIMEOUT: 2,
  CLIENT_ERROR: 3,
  IN_ANOTHER_CALL: 4,
  CLIENT_INTERRUPTED: 5,
  SESSION_MIGRATED: 6,
  E2EE_MANDATED_BUT_OFFER_DID_NOT_CONTAIN_E2EE: 7,
  E2EE_MANDATED_BUT_ANSWER_DID_NOT_NEGOTIATE_E2EE: 8,
  WEBRTC_ERROR: 9,
  CONNECTION_DROPPED: 10,
  IGNORE_CALL_IF_SINGLE_ENDPOINT: 11
};

var DismissReason = {
  CALL_ENDED: 0,
  ANSWERED_ON_ANOTHER_DEVICE: 1,
  IN_ANOTHER_CALL: 2,
  CONNECTION_DROPPED: 3,
  REJECTED_ON_ANOTHER_DEVICE: 4,
  REMOVED_BY_PARTICIPANT: 5,
  REJECTED_BY_CALLEE: 6,
  INTERNAL_ERROR: 7,
  CALL_ENDED_BY_PRODUCT: 9,
  JOIN_APPROVAL_DENIED: 10,
  JOIN_APPROVAL_TIMEDOUT: 11,
  UNSUPPORTED_VERSION: 12,
  LIVE_NOT_ACKED: 13,
  TX_ACK_TIMEDOUT: 14,
  ANSWERED_BY_OTHER_USER: 15,
  PARTICIPANT_SELF_TERMINATION: 16,
  PARTICIPANT_REJOIN: 17,
  LONG_LASTING_AUDIO_ISSUE: 18,
  PRIMARY_ENDPOINT_HANGUP: 19,
  RECONNECT_FAILED: 20,
  E2EE_HARDENING_ERROR: 21,
  CALL_ENDED_BY_EXTENSION: 22,
  CALL_ENDED_BY_OVER_CAPACITY: 23,
  CALL_ENDED_BY_SERVER_TIMEOUT: 24
};

var DeviceStatus = {
  OK: 0,
  NOT_SUPPORTED: 1,
  IN_ANOTHER_CALL: 10
};

var RingType = {
  GROUP_AUDIO_CALL: 0,
  PEER_VIDEO_CALL: 1,
  PEER_AUDIO_CALL: 2,
  GROUP_VIDEO_CALL: 3,
  LIVE_STREAM: 4,
  PEER_ESCALATED_VIDEO_CALL: 5,
  PEER_ESCALATED_AUDIO_CALL: 6,
  LIVE_AUDIO_ROOM: 7,
  LIVE_WITH_ROOM: 8
};

var MediaPath = {
  SFU: 1,
  P2P: 2
};

var MediaType = {
  AUDIO: 0,
  VIDEO: 1
};

var ClientStack = {
  OLD_CLIENT_PLATFORM_STACK: 0,
  RSYS_X: 1,
  IG_OLD_STACK: 2,
  MLITE_OLD_STACK: 3,
  SCOTCH: 4,
  ZENON: 5
};

var TrackLabel = {
  DEFAULT_AUDIO: 0,
  DEFAULT_VIDEO: 1,
  SCREEN_AUDIO: 2,
  SCREEN_VIDEO: 3,
  CUSTOM_VIDEO: 4,
  CUSTOM_AUDIO: 5
};

var CustomVideoContentType = {
  NONE: 0,
  AVATAR: 1,
  AUGMENTED_CALLING: 2,
  SCENE_COMPOSITION: 3,
  STEREO_VIDEO: 4,
  SHARED_STATE: 5
};

var CustomAudioContentType = {
  NONE: 0,
  AMBISONIC: 1,
  CONVERSATION_BOT: 2,
  MONOMIX: 3,
  MONOSTREAM: 4
};

var Capability = {
  SUPPORT_AUDIO_DEPRECATED: 0,
  SUPPORT_VIDEO_DEPRECATED: 1,
  SUPPORT_EXPERIMENTS_IN_JOIN_RESPONSE: 2,
  SUPPORT_NEW_PARTICIPANT_STATES: 3,
  SUPPORT_SDP_RENEGOTIATION: 4,
  SUPPORT_MWPP: 5,
  REQUIRE_FULL_SDP_IN_SMU: 6,
  SUPPORT_PRECONNECT: 7,
  SUPPORT_MWPP_DEESCALATION: 8,
  SUPPORT_PARTICIPANT_STATE_UNCALLABLE: 9,
  SUPPORT_MULTIPLE_VIDEO_STREAMS: 10,
  REQUIRE_FULL_SDP_IN_SMU_OPTIMIZED: 11,
  SUPPORT_MULTISTREAM_FEC: 12,
  SUPPORT_DELTA_SMU: 13,
  REQUIRE_DEFAULT_CHANNEL_SCREENSHARE: 14,
  SUPPORT_SCREENSHARE_FLAG_IN_JOIN_RESPONSE_AND_SMU: 15,
  SUPPORT_TEMPORAL_LAYER_JBE: 16,
  REQUIRES_P2P_RELAY_INFO_VIA_SIGNALING: 17,
  SUPPORT_NUMERIC_TOPICS: 18,
  SUPPORT_SDP_SENDRECV: 20
};

var MessageTag = {
  PRANSWER: 1001,
  INITIAL_ANSWER_TO_P2P_CALLER: 1002,
  DEESCALATE_OFFER_TO_P2P_CALLEE: 1003,
  DEESCALATE_ANSWER_TO_P2P_CALLER: 1004,
  REQUEST_DEESCALATE_TO_P2P_CALLER: 1005,
  REQUEST_ESCALATE: 1006,
  REQUEST_CLIENT_FULL_RENEGOTIATION_TO_ADMIT_FROM_WAITINGROOM: 1007,
  REQUEST_CLIENT_FULL_RENEGOTIATION_AGAINST_MWS: 1008,
  PARTICIPANT_ADDED: 1009,
  PARTICIPANT_REMOVED: 1010,
  FIRST_REMOTE_ALERTED_FOR_INITIATOR: 2001,
  FIRST_REMOTE_ANSWERED_FOR_INITIATOR: 2002,
  CONTAIN_PENDING_APPROVAL_PARTICIPANTS: 2003,
  KEEP_ALIVE_PING: 3001,
  IS_INITIATOR: 4001,
  PREGEN_SDP: 4002
};

var ConferenceType = {
  ROOM: 15
};

// MultiwaySharedTypes.E2eeMode: E2EE_MANDATED is 2, not 1. Sending the wrong
// value makes an E2EE-mandated call look like it is not E2EE, and the callee
// refuses it ("Cannot call").
var E2eeMode = {
  E2EE_NOT_MANDATED: 0,
  DEPRECATED_NO_REQUIREMENT: 1,
  E2EE_MANDATED: 2,
  E2EE_BYPASSED_USER_CONSENTED: 3
};

// E2eeStateTypes.InfraMandatedExpStatus.
var E2eeInfraMandatedExpStatus = {
  NOT_SET: 0,
  CONTROL: 1,
  TEST: 2
};

var ApprovalStatus = {
  DENIED: 0,
  APPROVED: 1
};

var JoinMode = {
  PRIMARY: 0,
  SECONDARY: 1
};

var ParticipantCallState = {
  UNKNOWN: 0,
  DISCONNECTED: 1,
  NO_ANSWER: 2,
  REJECTED: 3,
  UNREACHABLE: 4,
  CONNECTION_DROPPED: 5,
  CONTACTING: 6,
  RINGING: 7,
  CONNECTING: 8,
  CONNECTED: 9,
  PARTICIPANT_LIMIT_REACHED: 10,
  IN_ANOTHER_CALL: 11,
  RING_TYPE_UNSUPPORTED: 12,
  PENDING_APPROVAL: 13,
  APPROVED: 14,
  FAILED_APPROVAL: 15,
  HANGUP_IN_WAITING_ROOM: 16,
  UNCALLABLE: 17,
  UNCALLABLE_DELAYED: 18
};

var RtcResponseStatusCode = {
  OK: 200,
  CONDITIONAL_REQUEST_FAILED: 412,
  METHOD_NOT_ALLOWED: 406
};

// MultiwaySharedTypes.VideoQuality: the values matter for subscriptions
// (the dominant-speaker subscription uses LOW, per-track ones MEDIUM).
var VideoQuality = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  HD: 3
};

var SubscriptionType = {
  CNAME: 0,
  TRACK: 1,
  DOMINANT_SPEAKER: 2
};

var ClientEventType = {
  UNKNOWN: 0,
  MEDIA_CONNECTED: 1
};

var Service = {
  UNKNOWN: 0,
  MWS: 1,
  GENAI_SERVICE: 2,
  LIVEAI_SERVICE: 3,
  GRAPHQL_SERVICE: 4,
  ACP_SERVICE: 5
};

// ---------------------------------------------------------------------------
// Struct definitions: { id, name, type, opt, struct | elem | key | value }
// ---------------------------------------------------------------------------

var STRUCTS = {
  MqttThriftHeader: {
    fields: [
      { id: 1, name: "traceInfo", type: TType.STRING, opt: true },
      { id: 2, name: "coreContextRequestId", type: TType.STRING, opt: true }
    ]
  },

  RtcSender: {
    fields: [{ id: 1, name: "id", type: TType.STRING }]
  },

  RtcReceiver: {
    fields: [
      { id: 1, name: "actorId", type: TType.STRING },
      { id: 2, name: "baseId", type: TType.STRING }
    ]
  },

  RtcMessageHeader: {
    fields: [
      { id: 1, name: "type", type: TType.I32 },
      { id: 2, name: "conferenceName", type: TType.STRING },
      { id: 3, name: "transactionId", type: TType.STRING },
      { id: 4, name: "retryCount", type: TType.I16 },
      { id: 5, name: "serverInfoData", type: TType.STRING, opt: true },
      { id: 6, name: "responseStatusCode", type: TType.I32, opt: true },
      { id: 7, name: "extensions", type: TType.MAP, key: { type: TType.STRING }, value: { type: TType.STRING }, opt: true },
      { id: 8, name: "sequenceNumber", type: TType.I64, opt: true },
      { id: 9, name: "clientSessionId", type: TType.STRING, opt: true },
      { id: 10, name: "responseStatusMessage", type: TType.STRING, opt: true },
      { id: 11, name: "responseSubCode", type: TType.I32, opt: true },
      { id: 12, name: "collisionKey", type: TType.STRING, opt: true },
      { id: 13, name: "conferenceType", type: TType.I32, opt: true },
      { id: 14, name: "serverSessionId", type: TType.STRING, opt: true },
      { id: 15, name: "rtcHandle", type: TType.STRING, opt: true },
      { id: 16, name: "retryAfterMsec", type: TType.I32, opt: true },
      { id: 17, name: "receiverUserId", type: TType.STRING, opt: true },
      { id: 18, name: "clientStack", type: TType.I32, opt: true },
      { id: 19, name: "serverMsgTime", type: TType.I64, opt: true },
      { id: 20, name: "sender", type: TType.STRUCT, struct: "RtcSender", opt: true },
      { id: 21, name: "receiver", type: TType.STRUCT, struct: "RtcReceiver", opt: true },
      { id: 22, name: "messageTags", type: TType.SET, elem: { type: TType.I32 }, opt: true },
      { id: 23, name: "conferenceId", type: TType.I64, opt: true },
      { id: 24, name: "protocolVersion", type: TType.I32, opt: true },
      { id: 25, name: "bodyCompressionVersion", type: TType.I64, opt: true }
    ]
  },

  SessionDescription: {
    fields: [
      { id: 1, name: "sdpString", type: TType.STRING, opt: true },
      { id: 3, name: "sdpCompressionVersion", type: TType.I64, opt: true },
      { id: 4, name: "sdpCompressedData", type: TType.STRING, opt: true, binary: true}
    ]
  },

  ClientTrackInfo: {
    fields: [
      { id: 1, name: "enabled", type: TType.BOOL },
      { id: 2, name: "pausedUplink", type: TType.I32, opt: true },
      { id: 3, name: "pausedDownlink", type: TType.I32, opt: true },
      { id: 4, name: "owner", type: TType.STRING, opt: true },
      { id: 5, name: "label", type: TType.I32, opt: true },
      { id: 6, name: "customVideoContentType", type: TType.I32 },
      { id: 7, name: "name", type: TType.STRING, opt: true },
      { id: 8, name: "customAudioContentType", type: TType.I32 },
      { id: 9, name: "nodeId", type: TType.I64, opt: true }
    ]
  },

  ClientMediaStatus: {
    fields: [
      { id: 1, name: "tracks", type: TType.MAP, key: { type: TType.STRING }, value: { type: TType.STRUCT, struct: "ClientTrackInfo" } }
    ]
  },

  E2eeEnforcement: {
    fields: [
      { id: 1, name: "mode", type: TType.I32 },
      { id: 2, name: "preventSfuMode", type: TType.BOOL },
      { id: 3, name: "infraMandatedExpStatus", type: TType.I32 }
    ]
  },

  TurnInfo: {
    fields: [
      { id: 1, name: "ipv4", type: TType.STRING, opt: true, binary: true},
      { id: 2, name: "ipv6", type: TType.STRING, opt: true, binary: true},
      { id: 3, name: "udpPort", type: TType.I32, opt: true },
      { id: 4, name: "tcpPort", type: TType.I32, opt: true },
      { id: 5, name: "sslTcpPort", type: TType.I32, opt: true },
      { id: 6, name: "portInfoIdx", type: TType.I32, opt: true },
      { id: 7, name: "tlsPort", type: TType.I32, opt: true },
      { id: 8, name: "credentialIdx", type: TType.I32, opt: true },
      { id: 9, name: "turnUsername", type: TType.STRING, opt: true },
      { id: 10, name: "turnPassword", type: TType.STRING, opt: true }
    ]
  },

  EdgerayInfo: {
    fields: [
      { id: 1, name: "edgerayType", type: TType.I32, opt: true },
      { id: 2, name: "ipv4", type: TType.STRING, opt: true, binary: true},
      { id: 3, name: "ipv6", type: TType.STRING, opt: true, binary: true},
      { id: 4, name: "token", type: TType.STRING, opt: true, binary: true},
      { id: 5, name: "tokenIdx", type: TType.I32, opt: true },
      { id: 6, name: "secret", type: TType.STRING, opt: true, binary: true},
      { id: 7, name: "secretIdx", type: TType.I32, opt: true }
    ]
  },

  RelayInfo: {
    fields: [
      { id: 1, name: "turns", type: TType.LIST, elem: { type: TType.STRUCT, struct: "TurnInfo" }, opt: true },
      { id: 2, name: "edgerays", type: TType.LIST, elem: { type: TType.STRUCT, struct: "EdgerayInfo" }, opt: true },
      { id: 3, name: "turnUsername", type: TType.STRING, opt: true },
      { id: 4, name: "turnPassword", type: TType.STRING, opt: true }
    ]
  },

  ThreadIdInfo: {
    fields: [
      { id: 1, name: "groupThreadId", type: TType.STRING, opt: true },
      { id: 2, name: "peerId", type: TType.STRING, opt: true }
    ]
  },

  EndpointSettings: {
    fields: [{ id: 1, name: "joinMode", type: TType.I32 }]
  },

  SfuAllocation: {
    fields: [
      { id: 1, name: "smcTier", type: TType.STRING },
      { id: 2, name: "region", type: TType.STRING },
      { id: 3, name: "isUsfu", type: TType.BOOL },
      { id: 4, name: "isEdge", type: TType.BOOL }
    ]
  },

  UserProfile: {
    fields: [
      { id: 1, name: "name", type: TType.STRING, opt: true },
      { id: 2, name: "profilePictureUri", type: TType.STRING, opt: true },
      { id: 3, name: "aliasId", type: TType.STRING, opt: true }
    ]
  },

  ProductMetadata: {
    fields: [
      { id: 1, name: "callerInfo", type: TType.STRUCT, struct: "UserProfile", opt: true },
      { id: 2, name: "liveBroadcastId", type: TType.STRING, opt: true },
      { id: 3, name: "callingTags", type: TType.I32, opt: true },
      { id: 4, name: "backingIdentifier", type: TType.STRING, opt: true }
    ]
  },

  State: {
    fields: [
      { id: 1, name: "version", type: TType.I32 },
      { id: 2, name: "data", type: TType.STRING, opt: true, binary: true}
    ]
  },

  SyncPayload: {
    fields: [
      { id: 1, name: "stateStore", type: TType.MAP, key: { type: TType.STRING }, value: { type: TType.STRUCT, struct: "State" } },
      { id: 4, name: "stateStoreV2", type: TType.MAP, key: { type: TType.I32 }, value: { type: TType.STRUCT, struct: "State" } }
    ]
  },

  GenericDataMessage: {
    fields: [
      { id: 1, name: "topic", type: TType.STRING },
      { id: 2, name: "data", type: TType.STRING, binary: true},
      { id: 3, name: "e2eEncryptedData", type: TType.STRING, opt: true, binary: true}
    ]
  },

  DataHeader: {
    fields: [
      { id: 1, name: "sender", type: TType.STRING, opt: true },
      { id: 2, name: "topic_DEPRECATED", type: TType.STRING },
      { id: 3, name: "recipients", type: TType.SET, elem: { type: TType.STRING }, opt: true },
      { id: 4, name: "serviceSender", type: TType.I32, opt: true },
      { id: 5, name: "serviceRecipients", type: TType.SET, elem: { type: TType.I32 }, opt: true },
      { id: 6, name: "shouldSendToAllUsers", type: TType.BOOL, opt: true },
      { id: 7, name: "senderE2eeId", type: TType.STRING, opt: true, binary: true}
    ]
  },

  DataMessageBody: {
    fields: [
      { id: 1, name: "genericMessage", type: TType.STRUCT, struct: "GenericDataMessage", opt: true }
    ]
  },

  DataMessage: {
    fields: [
      { id: 1, name: "header", type: TType.STRUCT, struct: "DataHeader" },
      { id: 2, name: "data_DEPRECATED", type: TType.STRING, opt: true, binary: true},
      { id: 3, name: "body", type: TType.STRUCT, struct: "DataMessageBody", opt: true }
    ]
  },

  JoinRequest: {
    fields: [
      { id: 1, name: "offer", type: TType.STRUCT, struct: "SessionDescription" },
      { id: 2, name: "deviceCapabilities", type: TType.SET, elem: { type: TType.I32 } },
      { id: 3, name: "usersToCall", type: TType.SET, elem: { type: TType.STRING }, opt: true },
      { id: 4, name: "mediaStatus", type: TType.MAP, key: { type: TType.STRING }, value: { type: TType.BOOL }, opt: true },
      { id: 5, name: "userCapabilities", type: TType.STRING, opt: true, binary: true},
      { id: 6, name: "supportedExperiments", type: TType.STRING, opt: true },
      { id: 9, name: "appMessages", type: TType.LIST, elem: { type: TType.STRUCT, struct: "DataMessage" }, opt: true },
      { id: 10, name: "userToEscalate", type: TType.STRING, opt: true },
      { id: 11, name: "escalatingCallId", type: TType.I64, opt: true },
      { id: 12, name: "conferenceType", type: TType.I32, opt: true },
      { id: 13, name: "mediaStatusEx", type: TType.STRUCT, struct: "ClientMediaStatus", opt: true },
      { id: 14, name: "answer", type: TType.STRUCT, struct: "SessionDescription", opt: true },
      { id: 15, name: "syncPayload", type: TType.STRUCT, struct: "SyncPayload", opt: true },
      { id: 16, name: "usersToApproveFromWaitingRoom", type: TType.SET, elem: { type: TType.STRING }, opt: true },
      { id: 17, name: "e2eeEnforcement", type: TType.STRUCT, struct: "E2eeEnforcement", opt: true },
      { id: 18, name: "sfuAllocation", type: TType.STRUCT, struct: "SfuAllocation", opt: true },
      { id: 19, name: "clientMediaMode", type: TType.I32, opt: true },
      { id: 20, name: "endpointSettings", type: TType.STRUCT, struct: "EndpointSettings", opt: true },
      { id: 21, name: "backupSfuAllocation", type: TType.STRUCT, struct: "SfuAllocation", opt: true },
      { id: 22, name: "supportedCustomVideoContentTypes", type: TType.SET, elem: { type: TType.I32 }, opt: true },
      { id: 23, name: "configIntegrityOpaqueToken", type: TType.I32, opt: true }
    ]
  },

  GroupOfUsers: {
    fields: [
      { id: 1, name: "users", type: TType.SET, elem: { type: TType.STRING } },
      { id: 2, name: "allowMultipleJoins", type: TType.BOOL },
      { id: 3, name: "dismissOthersOnFirstJoin", type: TType.BOOL },
      { id: 4, name: "aliasId", type: TType.STRING }
    ]
  },

  JoinResponse: {
    fields: [
      { id: 1, name: "answer", type: TType.STRUCT, struct: "SessionDescription" },
      { id: 2, name: "mediaStatus", type: TType.MAP, key: { type: TType.STRING }, value: { type: TType.BOOL } },
      { id: 3, name: "initiator", type: TType.STRING },
      { id: 4, name: "negotiatedExperiments", type: TType.STRING, opt: true },
      { id: 6, name: "mediaStatusEx", type: TType.STRUCT, struct: "ClientMediaStatus", opt: true },
      { id: 7, name: "appMessages", type: TType.LIST, elem: { type: TType.STRUCT, struct: "DataMessage" }, opt: true },
      { id: 8, name: "stateStore", type: TType.MAP, key: { type: TType.STRING }, value: { type: TType.STRUCT, struct: "State" }, opt: true },
      { id: 9, name: "sdpOriginLocalId", type: TType.STRING, opt: true },
      { id: 10, name: "isPendingApproval", type: TType.BOOL },
      { id: 11, name: "renegotiationOffer", type: TType.STRUCT, struct: "SessionDescription", opt: true },
      { id: 12, name: "multipleVideoStreamsAllowed", type: TType.BOOL },
      { id: 13, name: "mediaPath", type: TType.I32 },
      { id: 14, name: "groupsOfUsers", type: TType.LIST, elem: { type: TType.STRUCT, struct: "GroupOfUsers" } },
      { id: 15, name: "screenShareStreamAllowed", type: TType.BOOL },
      { id: 16, name: "relayInfo", type: TType.STRUCT, struct: "RelayInfo", opt: true },
      { id: 17, name: "selfSctpNodeId", type: TType.I64, opt: true },
      { id: 18, name: "stateStoreV2", type: TType.MAP, key: { type: TType.I32 }, value: { type: TType.STRUCT, struct: "State" }, opt: true },
      { id: 19, name: "allowedCustomVideoContentTypes", type: TType.SET, elem: { type: TType.I32 }, opt: true }
    ]
  },

  RingRequest: {
    fields: [
      { id: 1, name: "caller", type: TType.STRING },
      { id: 2, name: "otherParticipants", type: TType.SET, elem: { type: TType.STRING } },
      { id: 4, name: "ringType", type: TType.I32 },
      { id: 5, name: "offeredExperiments", type: TType.STRING, opt: true },
      { id: 6, name: "isScheduledCall", type: TType.BOOL, opt: true },
      { id: 8, name: "appMessages", type: TType.LIST, elem: { type: TType.STRUCT, struct: "DataMessage" }, opt: true },
      { id: 10, name: "offer", type: TType.STRUCT, struct: "SessionDescription", opt: true },
      { id: 11, name: "mediaStatusEx", type: TType.STRUCT, struct: "ClientMediaStatus", opt: true },
      { id: 12, name: "isPreconnectSupported", type: TType.BOOL, opt: true },
      { id: 13, name: "sdpOriginLocalId", type: TType.STRING, opt: true },
      { id: 14, name: "unifiedOffer", type: TType.STRUCT, struct: "SessionDescription", opt: true },
      { id: 15, name: "mediaPath", type: TType.I32 },
      { id: 16, name: "e2eeEnforcement", type: TType.STRUCT, struct: "E2eeEnforcement", opt: true },
      { id: 17, name: "isLegacyCall", type: TType.BOOL, opt: true },
      { id: 18, name: "isTransferCall", type: TType.BOOL },
      { id: 20, name: "relayInfo", type: TType.STRUCT, struct: "RelayInfo", opt: true },
      { id: 21, name: "overlayConfigs", type: TType.MAP, key: { type: TType.I32 }, value: { type: TType.I32 }, opt: true },
      { id: 22, name: "productMetadata", type: TType.STRUCT, struct: "ProductMetadata", opt: true },
      { id: 23, name: "callerClientSessionId", type: TType.STRING, opt: true },
      { id: 24, name: "threadIdInfo", type: TType.STRUCT, struct: "ThreadIdInfo", opt: true },
      { id: 25, name: "linkUrl", type: TType.STRING, opt: true }
    ]
  },

  RingResponse: {
    fields: [{ id: 2, name: "deviceStatus", type: TType.I32 }]
  },

  HangupRequest: {
    fields: [
      { id: 1, name: "reason", type: TType.I32 },
      { id: 2, name: "detailedReasonString", type: TType.STRING }
    ]
  },

  DismissRequest: {
    fields: [
      { id: 1, name: "reason", type: TType.I32 },
      { id: 2, name: "detailedReasonString", type: TType.STRING },
      { id: 3, name: "callabilityResultErrorCode", type: TType.I64, opt: true }
    ]
  },

  ApprovalRequest: {
    fields: [
      { id: 2, name: "approvalStatus", type: TType.I32 },
      { id: 3, name: "targetUsers", type: TType.SET, elem: { type: TType.STRING } }
    ]
  },

  IceCandidate: {
    fields: [
      { id: 1, name: "candidateSdpString", type: TType.STRING, opt: true },
      { id: 2, name: "sdpMLineIndex", type: TType.I64 },
      { id: 3, name: "sdpMid", type: TType.STRING }
    ]
  },

  IceCandidateRequest: {
    fields: [
      { id: 1, name: "iceCandidateSdps", type: TType.LIST, elem: { type: TType.STRUCT, struct: "IceCandidate" } }
    ]
  },

  Media: {
    fields: [
      { id: 1, name: "type", type: TType.I32 },
      { id: 2, name: "id", type: TType.STRING },
      { id: 3, name: "ssrcs", type: TType.LIST, elem: { type: TType.I64 } },
      { id: 4, name: "enabled", type: TType.BOOL },
      { id: 5, name: "pausedDownlink", type: TType.I32, opt: true },
      { id: 6, name: "pausedUplink", type: TType.I32, opt: true },
      { id: 7, name: "owner", type: TType.STRING, opt: true },
      { id: 8, name: "label", type: TType.I32, opt: true },
      { id: 9, name: "customVideoContentType", type: TType.I32 },
      { id: 10, name: "name", type: TType.STRING, opt: true },
      { id: 11, name: "customAudioContentType", type: TType.I32 }
    ]
  },

  SsrcGroup: {
    fields: [
      { id: 1, name: "semantics", type: TType.STRING },
      { id: 2, name: "ssrcs", type: TType.LIST, elem: { type: TType.I64 } }
    ]
  },

  ServerMediaUpdate: {
    fields: [
      { id: 1, name: "sourceKey", type: TType.STRING },
      { id: 2, name: "media", type: TType.LIST, elem: { type: TType.STRUCT, struct: "Media" } },
      { id: 3, name: "ssrcGroups", type: TType.LIST, elem: { type: TType.STRUCT, struct: "SsrcGroup" } }
    ]
  },

  ServerMediaUpdateRequest: {
    fields: [
      { id: 1, name: "fromVersion", type: TType.I64 },
      { id: 2, name: "toVersion", type: TType.I64 },
      { id: 3, name: "mediaUpdates", type: TType.LIST, elem: { type: TType.STRUCT, struct: "ServerMediaUpdate" } },
      { id: 4, name: "offer", type: TType.STRUCT, struct: "SessionDescription", opt: true },
      { id: 6, name: "answer", type: TType.STRUCT, struct: "SessionDescription", opt: true },
      { id: 7, name: "mediaStatus", type: TType.STRUCT, struct: "ClientMediaStatus", opt: true },
      { id: 8, name: "renegotiationRequested", type: TType.BOOL },
      { id: 9, name: "prAnswer", type: TType.STRUCT, struct: "SessionDescription", opt: true },
      { id: 11, name: "sdpOriginLocalId", type: TType.STRING, opt: true },
      { id: 13, name: "multipleVideoStreamsAllowed", type: TType.BOOL },
      { id: 14, name: "renegotiationOffer", type: TType.STRUCT, struct: "SessionDescription", opt: true },
      { id: 15, name: "mediaPath", type: TType.I32 },
      { id: 17, name: "screenShareStreamAllowed", type: TType.BOOL },
      { id: 20, name: "relayInfo", type: TType.STRUCT, struct: "RelayInfo", opt: true }
    ]
  },

  ServerMediaUpdateResponse: {
    fields: [
      { id: 1, name: "currentVersion", type: TType.I64 },
      { id: 2, name: "answer", type: TType.STRUCT, struct: "SessionDescription", opt: true },
      { id: 3, name: "mediaStatus", type: TType.STRUCT, struct: "ClientMediaStatus", opt: true }
    ]
  },

  ClientMediaUpdate: {
    fields: [
      { id: 1, name: "mediaStatus", type: TType.MAP, key: { type: TType.STRING }, value: { type: TType.BOOL } },
      { id: 2, name: "mediaStatusEx", type: TType.STRUCT, struct: "ClientMediaStatus", opt: true }
    ]
  },

  ClientMediaUpdateRequest: {
    fields: [
      { id: 1, name: "fromVersion", type: TType.I64 },
      { id: 2, name: "toVersion", type: TType.I64 },
      { id: 3, name: "mediaUpdates", type: TType.LIST, elem: { type: TType.STRUCT, struct: "ClientMediaUpdate" } },
      { id: 4, name: "offer", type: TType.STRUCT, struct: "SessionDescription", opt: true }
    ]
  },

  ClientMediaUpdateResponse: {
    fields: [
      { id: 1, name: "currentVersion", type: TType.I64 },
      { id: 2, name: "answer", type: TType.STRUCT, struct: "SessionDescription", opt: true },
      { id: 3, name: "mediaStatus", type: TType.STRUCT, struct: "ClientMediaStatus", opt: true },
      { id: 4, name: "sdpOriginLocalId", type: TType.STRING, opt: true },
      { id: 5, name: "renegotiationOffer", type: TType.STRUCT, struct: "SessionDescription", opt: true },
      { id: 6, name: "mediaPath", type: TType.I32 },
      { id: 7, name: "stateStore", type: TType.MAP, key: { type: TType.STRING }, value: { type: TType.STRUCT, struct: "State" }, opt: true },
      { id: 8, name: "stateStoreV2", type: TType.MAP, key: { type: TType.I32 }, value: { type: TType.STRUCT, struct: "State" }, opt: true }
    ]
  },

  ParticipantState: {
    fields: [
      { id: 1, name: "state", type: TType.I32 },
      { id: 2, name: "userCapabilities", type: TType.STRING, opt: true, binary: true},
      { id: 3, name: "sctpNodeId", type: TType.I64, opt: true }
    ]
  },

  ConferenceStateRequest: {
    fields: [
      { id: 1, name: "version", type: TType.I64 },
      { id: 2, name: "participantStates", type: TType.MAP, key: { type: TType.STRING }, value: { type: TType.STRUCT, struct: "ParticipantState" } },
      { id: 3, name: "userProfiles", type: TType.MAP, key: { type: TType.STRING }, value: { type: TType.STRUCT, struct: "UserProfile" } },
      { id: 4, name: "appMessages", type: TType.LIST, elem: { type: TType.STRUCT, struct: "DataMessage" }, opt: true },
      { id: 5, name: "groupsOfUsers", type: TType.LIST, elem: { type: TType.STRUCT, struct: "GroupOfUsers" } }
    ]
  },

  ConferenceStateResponse: {
    fields: [{ id: 1, name: "currentVersion", type: TType.I64 }]
  },

  UpdateRequest: {
    fields: [
      { id: 1, name: "syncPayload", type: TType.STRUCT, struct: "SyncPayload" },
      { id: 2, name: "topic", type: TType.STRING },
      { id: 3, name: "version", type: TType.I32 },
      { id: 4, name: "data", type: TType.STRING, opt: true, binary: true},
      { id: 5, name: "topicId", type: TType.I32 }
    ]
  },

  UpdateResponse: {
    fields: [
      { id: 2, name: "topic", type: TType.STRING },
      { id: 3, name: "version", type: TType.I32 }
    ]
  },

  NotifyRequest: {
    fields: [
      { id: 2, name: "topic", type: TType.STRING },
      { id: 3, name: "version", type: TType.I32 },
      { id: 4, name: "data", type: TType.STRING, binary: true},
      { id: 5, name: "syncPayload", type: TType.STRUCT, struct: "SyncPayload", opt: true },
      { id: 6, name: "topicId", type: TType.I32, opt: true }
    ]
  },

  NotifyResponse: {
    fields: [
      { id: 2, name: "topic", type: TType.STRING },
      { id: 3, name: "version", type: TType.I32 }
    ]
  },

  UnsubscribeRequest: {
    fields: [
      { id: 1, name: "topic", type: TType.STRING },
      { id: 2, name: "version", type: TType.I32 },
      { id: 3, name: "topicId", type: TType.I32 }
    ]
  },

  UnsubscribeResponse: {
    fields: [
      { id: 1, name: "topic", type: TType.STRING },
      { id: 2, name: "version", type: TType.I32 }
    ]
  },

  ClientEvent: {
    fields: [
      { id: 1, name: "type", type: TType.I32 },
      { id: 2, name: "time", type: TType.I64, opt: true }
    ]
  },

  ClientEventRequest: {
    fields: [
      { id: 1, name: "clientEvents", type: TType.LIST, elem: { type: TType.STRUCT, struct: "ClientEvent" } }
    ]
  },

  SubscriptionOptions: {
    fields: [
      { id: 1, name: "videoQuality", type: TType.I32 },
      { id: 2, name: "qualityIndex", type: TType.I32, opt: true }
    ]
  },

  Subscription: {
    fields: [
      { id: 1, name: "cname", type: TType.STRING },
      { id: 2, name: "options", type: TType.STRUCT, struct: "SubscriptionOptions", opt: true },
      { id: 3, name: "type", type: TType.I32 },
      { id: 4, name: "trackId", type: TType.STRING, opt: true }
    ]
  },

  SubscriptionRequest: {
    fields: [
      { id: 1, name: "subscriptions", type: TType.LIST, elem: { type: TType.STRUCT, struct: "Subscription" } }
    ]
  },

  AddParticipantsRequest: {
    fields: [
      { id: 1, name: "usersToInvite", type: TType.SET, elem: { type: TType.STRING } },
      { id: 2, name: "appMessages", type: TType.LIST, elem: { type: TType.STRUCT, struct: "DataMessage" }, opt: true }
    ]
  },

  RemoveParticipantsRequest: {
    fields: [{ id: 1, name: "usersToRemove", type: TType.SET, elem: { type: TType.STRING } }]
  },

  RtcMessageBody: {
    fields: [
      { id: 1, name: "joinRequest", type: TType.STRUCT, struct: "JoinRequest", opt: true },
      { id: 2, name: "joinResponse", type: TType.STRUCT, struct: "JoinResponse", opt: true },
      { id: 3, name: "serverMediaUpdateRequest", type: TType.STRUCT, struct: "ServerMediaUpdateRequest", opt: true },
      { id: 4, name: "serverMediaUpdateResponse", type: TType.STRUCT, struct: "ServerMediaUpdateResponse", opt: true },
      { id: 5, name: "hangupRequest", type: TType.STRUCT, struct: "HangupRequest", opt: true },
      { id: 6, name: "iceCandidateRequest", type: TType.STRUCT, struct: "IceCandidateRequest", opt: true },
      { id: 8, name: "ringRequest", type: TType.STRUCT, struct: "RingRequest", opt: true },
      { id: 9, name: "ringResponse", type: TType.STRUCT, struct: "RingResponse", opt: true },
      { id: 10, name: "dismissRequest", type: TType.STRUCT, struct: "DismissRequest", opt: true },
      { id: 11, name: "conferenceStateRequest", type: TType.STRUCT, struct: "ConferenceStateRequest", opt: true },
      { id: 12, name: "conferenceStateResponse", type: TType.STRUCT, struct: "ConferenceStateResponse", opt: true },
      { id: 13, name: "addParticipantsRequest", type: TType.STRUCT, struct: "AddParticipantsRequest", opt: true },
      { id: 14, name: "subscriptionRequest", type: TType.STRUCT, struct: "SubscriptionRequest", opt: true },
      { id: 15, name: "clientMediaUpdateRequest", type: TType.STRUCT, struct: "ClientMediaUpdateRequest", opt: true },
      { id: 16, name: "clientMediaUpdateResponse", type: TType.STRUCT, struct: "ClientMediaUpdateResponse", opt: true },
      { id: 17, name: "dataMessageRequest", type: TType.STRUCT, struct: "DataMessageRequest", opt: true },
      { id: 18, name: "removeParticipantsRequest", type: TType.STRUCT, struct: "RemoveParticipantsRequest", opt: true },
      { id: 30, name: "updateRequest", type: TType.STRUCT, struct: "UpdateRequest", opt: true },
      { id: 31, name: "updateResponse", type: TType.STRUCT, struct: "UpdateResponse", opt: true },
      { id: 32, name: "notifyRequest", type: TType.STRUCT, struct: "NotifyRequest", opt: true },
      { id: 33, name: "notifyResponse", type: TType.STRUCT, struct: "NotifyResponse", opt: true },
      { id: 36, name: "clientEventRequest", type: TType.STRUCT, struct: "ClientEventRequest", opt: true },
      { id: 40, name: "unsubscribeRequest", type: TType.STRUCT, struct: "UnsubscribeRequest", opt: true },
      { id: 41, name: "unsubscribeResponse", type: TType.STRUCT, struct: "UnsubscribeResponse", opt: true },
      { id: 42, name: "approvalRequest", type: TType.STRUCT, struct: "ApprovalRequest", opt: true }
    ]
  },

  DataMessageRequest: {
    fields: [{ id: 1, name: "message", type: TType.STRUCT, struct: "DataMessage" }]
  },

  DataMessageResponse: {
    fields: [
      { id: 1, name: "deliveryResult", type: TType.MAP, key: { type: TType.STRING }, value: { type: TType.I32 } },
      { id: 2, name: "serviceTypeDeliveryResult", type: TType.MAP, key: { type: TType.I32 }, value: { type: TType.I32 }, opt: true }
    ]
  }
};

// ---------------------------------------------------------------------------
// Schema-driven encode/decode
// ---------------------------------------------------------------------------

function defaultValue(def) {
  switch (def.type) {
    case TType.BOOL: return false;
    case TType.BYTE:
    case TType.I16:
    case TType.I32: return 0;
    case TType.I64: return BigInt(0);
    case TType.DOUBLE: return 0;
    case TType.STRING: return "";
    case TType.STRUCT: return {};
    case TType.LIST:
    case TType.SET: return [];
    case TType.MAP: return {};
  }
  return null;
}

function writeValue(writer, def, value) {
  switch (def.type) {
    case TType.BOOL:
      writer.writeBool(!!value);
      return;
    case TType.BYTE:
      writer.writeByte(value | 0);
      return;
    case TType.I16:
      writer.writeI16(value | 0);
      return;
    case TType.I32:
      writer.writeI32(value | 0);
      return;
    case TType.I64:
      writer.writeI64(toBigInt(value));
      return;
    case TType.DOUBLE:
      writer.writeDouble(Number(value));
      return;
    case TType.STRING:
      // Binary fields carry Buffers/Uint8Arrays; strings are UTF-8 encoded.
      if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
        writer.writeBinary(value);
      } else {
        writer.writeString(value);
      }
      return;
    case TType.STRUCT:
      writeStruct(writer, def.struct, value == null ? {} : value);
      return;
    case TType.LIST:
    case TType.SET: {
      var items = value instanceof Set ? Array.from(value) : value || [];
      if (def.type === TType.LIST) {
        writer.writeListBegin(items.length, def.elem.type);
      } else {
        writer.writeSetBegin(items.length, def.elem.type);
      }
      for (var i = 0; i < items.length; i++) {
        writeCollectionElement(writer, def.elem, items[i]);
      }
      return;
    }
    case TType.MAP: {
      var entries = value instanceof Map ? Array.from(value.entries()) : null;
      var keys = entries ? null : Object.keys(value || {});
      if (!entries && def.key.type === TType.I32) {
        keys = keys.map(Number);
      }
      writer.writeMapBegin(entries ? entries.length : keys.length, def.key.type, def.value.type);
      if (entries) {
        for (var m = 0; m < entries.length; m++) {
          writeCollectionElement(writer, def.key, entries[m][0]);
          writeCollectionElement(writer, def.value, entries[m][1]);
        }
        return;
      }
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j];
        writeCollectionElement(writer, def.key, key);
        writeCollectionElement(writer, def.value, value[key]);
      }
      return;
    }
  }
  throw new Error("Cannot encode thrift value of type " + def.type);
}

function writeCollectionElement(writer, def, value) {
  if (def.type === TType.BOOL) {
    // Collection bools are standalone bytes, not field headers.
    writer.writeByte(value ? 1 : 2);
    return;
  }
  if (def.type === TType.STRUCT) {
    writeStruct(writer, def.struct, value == null ? {} : value);
    return;
  }
  if (def.type === TType.STRING) {
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
      writer.writeBinary(value);
    } else {
      writer.writeString(value);
    }
    return;
  }
  writeValue(writer, def, value);
}

function writeStruct(writer, name, obj) {
  var schema = STRUCTS[name];
  if (!schema) throw new Error("Unknown thrift struct " + name);
  writer.writeStructBegin();
  for (var i = 0; i < schema.fields.length; i++) {
    var def = schema.fields[i];
    var value = obj[def.name];
    var present = value !== undefined && value !== null;
    if (!present) {
      if (def.opt) continue;
      value = defaultValue(def);
    }
    writer.writeFieldBegin(def.id, def.type);
    writeValue(writer, def, value);
  }
  writer.writeFieldStop();
  writer.writeStructEnd();
}

function readValue(reader, def, field) {
  switch (def.type) {
    case TType.BOOL:
      // Field bools carry the value in the field header.
      return field && field.value !== undefined ? field.value : reader.readByte() === 1;
    case TType.BYTE:
      return reader.readByte();
    case TType.I16:
      return reader.readI16();
    case TType.I32:
      return reader.readI32();
    case TType.I64:
      return reader.readI64();
    case TType.DOUBLE:
      return reader.readDouble();
    case TType.STRING:
      return def.binary ? reader.readBinary() : reader.readString();
    case TType.STRUCT:
      return readStruct(reader, def.struct);
    case TType.LIST:
    case TType.SET: {
      var collection = reader.readCollectionBegin();
      var items = [];
      for (var i = 0; i < collection.size; i++) {
        items.push(readCollectionElement(reader, def.elem));
      }
      return items;
    }
    case TType.MAP: {
      var map = reader.readMapBegin();
      var result = {};
      for (var j = 0; j < map.size; j++) {
        var key = readCollectionElement(reader, def.key);
        result[key] = readCollectionElement(reader, def.value);
      }
      return result;
    }
  }
  throw new Error("Cannot decode thrift value of type " + def.type);
}

function readCollectionElement(reader, def) {
  if (def.type === TType.BOOL) return reader.readByte() === 1;
  if (def.type === TType.STRUCT) return readStruct(reader, def.struct);
  return readValue(reader, def, null);
}

function readStruct(reader, name) {
  var schema = STRUCTS[name];
  if (!schema) throw new Error("Unknown thrift struct " + name);
  var fieldsById = {};
  for (var i = 0; i < schema.fields.length; i++) {
    fieldsById[schema.fields[i].id] = schema.fields[i];
  }

  var result = {};
  reader.readStructBegin();
  for (;;) {
    var field = reader.readFieldBegin();
    if (field.type === TType.STOP) break;
    var def = fieldsById[field.id];
    if (!def || def.type !== field.type) {
      reader.skip(field.type);
      continue;
    }
    result[def.name] = readValue(reader, def, field);
  }
  reader.readStructEnd();
  return result;
}

// ---------------------------------------------------------------------------
// Top-level message framing
// ---------------------------------------------------------------------------

// [MqttThriftHeader][RtcMessageHeader][RtcMessageBody], each a standalone
// compact-thrift struct. Payloads published on /t_rtc_multi are exactly this.
function serializeMessage(message, skipMqttHeader) {
  var writer = new Writer();
  if (!skipMqttHeader) writeStruct(writer, "MqttThriftHeader", {});
  writeStruct(writer, "RtcMessageHeader", message.messageHeader);
  writeStruct(writer, "RtcMessageBody", message.messageBody);
  return writer.toBuffer();
}

function deserializeMessage(bytes, skipMqttHeader) {
  var reader = new Reader(bytes);
  if (!skipMqttHeader) readStruct(reader, "MqttThriftHeader");
  var header = readStruct(reader, "RtcMessageHeader");
  var body = readStruct(reader, "RtcMessageBody");
  return { messageHeader: header, messageBody: body };
}

module.exports = {
  MessageType: MessageType,
  HangupReason: HangupReason,
  DismissReason: DismissReason,
  DeviceStatus: DeviceStatus,
  RingType: RingType,
  MediaPath: MediaPath,
  MediaType: MediaType,
  ClientStack: ClientStack,
  TrackLabel: TrackLabel,
  CustomVideoContentType: CustomVideoContentType,
  CustomAudioContentType: CustomAudioContentType,
  Capability: Capability,
  MessageTag: MessageTag,
  ConferenceType: ConferenceType,
  E2eeMode: E2eeMode,
  E2eeInfraMandatedExpStatus: E2eeInfraMandatedExpStatus,
  ApprovalStatus: ApprovalStatus,
  JoinMode: JoinMode,
  ParticipantCallState: ParticipantCallState,
  RtcResponseStatusCode: RtcResponseStatusCode,
  VideoQuality: VideoQuality,
  SubscriptionType: SubscriptionType,
  ClientEventType: ClientEventType,
  Service: Service,
  structs: STRUCTS,
  serializeMessage: serializeMessage,
  deserializeMessage: deserializeMessage
};
