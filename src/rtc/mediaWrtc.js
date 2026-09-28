"use strict";

// Media engine backed by the optional `@roamhq/wrtc` package (the full
// libwebrtc stack for Node). Unlike werift it supports ICE-TCP including DTLS
// over TCP and TURN relays over TCP/TLS, which is what networks that block
// outbound UDP to Facebook need.
//
// Same interface as the werift session in media.js: offer/answer, remote
// SDP/ICE, a local candidate callback, and WAV/callback audio I/O.

var fs = require("fs");
var log = require("npmlog");
var media = require("./media"); // shared WAV/PCM helpers

// libwebrtc's RTCAudioSource only accepts 10 ms frames (480 samples @48 kHz).
var FRAME_MS = 10;
var OPUS_RATE = 48000;
var OPUS_SAMPLES_PER_FRAME = (OPUS_RATE * FRAME_MS) / 1000;
var SAMPLE_RATE = 8000;

function loadWrtc() {
  try {
    return require("@roamhq/wrtc");
  } catch (e) {
    return null;
  }
}

function MediaSessionWrtc(wrtc, options) {
  this.options = options || {};
  this.closed = false;
  this.onCandidate = null;
  this.recorded = [];
  this.offset = 0;
  this.pump = null;
  this.diagnostics = 0;
  // `holdAudio` keeps the WAV paused until the client says the peer arrived,
  // so the first seconds are not played before anyone can hear them.
  this.autoStart = this.options.holdAudio !== true;

  var self = this;
  var iceServers = (this.options.iceServers || []).map(function(server) {
    return { urls: server.urls, username: server.username, credential: server.credential };
  });

  this.pc = new wrtc.RTCPeerConnection({
    iceServers: iceServers,
    // Let libwebrtc gather TCP candidates too (Facebook's edge offers them).
    iceTransportPolicy: "all"
  });

  this.pc.onicecandidate = function(event) {
    if (!event.candidate || !self.onCandidate) return;
    self.onCandidate({
      candidate: event.candidate.candidate,
      sdpMid: event.candidate.sdpMid || "0",
      sdpMLineIndex: event.candidate.sdpMLineIndex || 0
    });
  };

  this.pc.onconnectionstatechange = function() {
    log.info("call", "Media: peer connection state = " + self.pc.connectionState +
      " (ice " + self.pc.iceConnectionState + ")");
    if (self.pc.connectionState === "connected") {
      self.applyOpusBitrate();
      if (self.autoStart) self.startAudio();
      else log.info("call", "Media: connected; holding the audio until the peer joins");
      if (!self.connectedNotified && self.onConnected) {
        self.connectedNotified = true;
        self.onConnected();
      }
    }
    if (self.pc.connectionState === "failed" || self.pc.connectionState === "closed") self.stopAudio();
  };

  // Outgoing audio: libwebrtc encodes the PCM frames we push.
  this.source = new wrtc.nonstandard.RTCAudioSource();
  this.track = this.source.createTrack();
  this.pc.addTrack(this.track, new wrtc.MediaStream([this.track]));
  // The conference expects the media status to be keyed by the real SDP
  // track id (the `a=msid` track id), not an arbitrary one.
  this.trackIds = { audio: this.track.id, video: null };

  // Meta's call clients expect a data channel in the offer (their E2EE call
  // layer exchanges key material over SCTP); without the m=application line
  // end-to-end encrypted calls are rejected with "Cannot call".
  try {
    this.dataChannel = this.pc.createDataChannel("data", { negotiated: true, id: 0 });
  } catch (e) {
    log.warn("call", "Media: could not create the data channel: " + e.message);
  }

  // Incoming audio: libwebrtc decodes to PCM for us.
  this.sink = null;
  this.pc.ontrack = function(event) {
    var track = event.track;
    if (!track || track.kind !== "audio") return;
    self.sink = new wrtc.nonstandard.RTCAudioSink(track);
    self.sink.ondata = function(data) {
      self.onSinkData(data);
    };
  };

  var sourceRate = OPUS_RATE;
  if (this.options.audioFile) {
    var wav = media.wavToPcm(fs.readFileSync(this.options.audioFile));
    this.sourcePcm = media.resamplePcm(wav.pcm, wav.sampleRate, sourceRate);
  } else {
    this.sourcePcm = Buffer.alloc(sourceRate * 2);
  }
  this.sourceRate = sourceRate;

  this.dtlsTimer = setInterval(function() {
    if (self.closed || !self.pc) return;
    var states = "ice=" + self.pc.iceConnectionState + " pc=" + self.pc.connectionState;
    log.info("call", "Media: " + states);
    self.logStats();
    if (self.pc.connectionState !== "connected" && self.diagnostics < 6) {
      self.diagnostics++;
    }
  }, 3000);
}

// libwebrtc's Opus encoder starts at a low, speech-oriented rate; ask for the
// configured bitrate once the sender has encodings (only after negotiation).
MediaSessionWrtc.prototype.applyOpusBitrate = function() {
  var bitrate = this.options.opusBitrate || 128000;
  try {
    var senders = this.pc.getSenders ? this.pc.getSenders() : [];
    var sender = senders && senders[0];
    if (!sender || typeof sender.getParameters !== "function" ||
        typeof sender.setParameters !== "function") return;
    var params = sender.getParameters();
    if (!params || !params.encodings || !params.encodings.length) return;
    params.encodings[0].maxBitrate = bitrate;
    sender.setParameters(params);
    log.info("call", "Media: Opus bitrate set to " + bitrate + " bps");
  } catch (e) {
    log.verbose("call", "Media: could not set the Opus bitrate: " + e.message);
  }
};

// Proves whether RTP is really leaving/arriving, independent of signaling.
MediaSessionWrtc.prototype.logStats = function() {
  if (!this.pc || this.closed || typeof this.pc.getStats !== "function") return;
  this.pc.getStats().then(function(report) {
    var out = 0, outBytes = 0, incoming = 0;
    report.forEach(function(stat) {
      if (stat.type === "outbound-rtp" && stat.kind === "audio") {
        out = stat.packetsSent || 0;
        outBytes = stat.bytesSent || 0;
      }
      if (stat.type === "inbound-rtp" && stat.kind === "audio") {
        incoming = stat.packetsReceived || 0;
      }
    });
    log.info("call", "Media: RTP out=" + out + " packets (" + outBytes + " B), in=" + incoming + " packets");
  }).catch(function() { /* stats unavailable */ });
};

MediaSessionWrtc.prototype.startAudio = function() {
  var self = this;
  if (this.pump || this.closed) return;
  var sourceFrames = Math.floor(this.sourcePcm.length / 2);
  function frame() {
    var samples = new Int16Array(OPUS_SAMPLES_PER_FRAME);
    for (var i = 0; i < OPUS_SAMPLES_PER_FRAME; i++) {
      samples[i] = sourceFrames ? self.sourcePcm.readInt16LE(((self.offset + i) % sourceFrames) * 2) : 0;
    }
    self.offset = sourceFrames ? (self.offset + OPUS_SAMPLES_PER_FRAME) % sourceFrames : 0;
    self.source.onData({
      samples: samples,
      sampleRate: self.sourceRate,
      bitsPerSample: 16,
      channelCount: 1,
      numberOfFrames: OPUS_SAMPLES_PER_FRAME
    });
  }
  media.startFramePump(this, frame, FRAME_MS);
  log.info("call", "Media: sending audio (libwebrtc, 48 kHz PCM in)");
};

MediaSessionWrtc.prototype.stopAudio = function() {
  if (this.pump) clearTimeout(this.pump);
  this.pump = null;
};

MediaSessionWrtc.prototype.onSinkData = function(data) {
  if (!data || !data.samples) return;
  var pcm = Buffer.from(data.samples.buffer, data.samples.byteOffset, data.samples.byteLength);
  var eightK = media.resamplePcm(pcm, data.sampleRate || OPUS_RATE, SAMPLE_RATE);
  if (this.options.recordFile) this.recorded.push(eightK);
  if (typeof this.options.onAudioData === "function") {
    try {
      this.options.onAudioData(eightK, pcm);
    } catch (e) {
      log.warn("call", "onAudioData handler threw: " + e.message);
    }
  }
};

MediaSessionWrtc.prototype.createOffer = function(callback) {
  var self = this;
  this.pc.createOffer()
    .then(function(offer) { return self.pc.setLocalDescription(offer); })
    .then(function() {
      var sdp = self.pc.localDescription ? self.pc.localDescription.sdp : "";
      log.info("call", "Media: local candidates (libwebrtc) " +
        ((sdp.match(/a=candidate/g) || []).length ? "in SDP" : "trickled"));
      callback(null, sdp);
    })
    .catch(function(e) { callback(e); });
};

MediaSessionWrtc.prototype.createAnswer = function(remoteSdp, callback) {
  var self = this;
  this.pc.setRemoteDescription(new (loadWrtc().RTCSessionDescription)({ type: "offer", sdp: remoteSdp }))
    .then(function() { return self.pc.createAnswer(); })
    .then(function(answer) { return self.pc.setLocalDescription(answer); })
    .then(function() {
      callback(null, self.pc.localDescription ? self.pc.localDescription.sdp : "");
    })
    .catch(function(e) { callback(e); });
};

MediaSessionWrtc.prototype.setRemoteAnswer = function(remoteSdp, callback) {
  callback = callback || function() {};
  var wrtc = loadWrtc();
  this.pc.setRemoteDescription(new wrtc.RTCSessionDescription({ type: "answer", sdp: remoteSdp }))
    .then(function() { callback(null); })
    .catch(function(e) { callback(e); });
};

MediaSessionWrtc.prototype.addRemoteCandidate = function(candidate, callback) {
  callback = callback || function() {};
  var wrtc = loadWrtc();
  this.pc.addIceCandidate(new wrtc.RTCIceCandidate({
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex
  })).then(function() {
    callback(null);
  }).catch(function(e) {
    callback(e);
  });
};

MediaSessionWrtc.prototype.setIceServers = function(iceServers) {
  this.options.iceServers = iceServers;
  log.info("call", "Media: relay configuration updated (" + iceServers.length + " server(s))");
};

MediaSessionWrtc.prototype.close = function() {
  if (this.closed) return;
  this.closed = true;
  if (this.dtlsTimer) clearInterval(this.dtlsTimer);
  this.stopAudio();
  if (this.options.recordFile && this.recorded.length) {
    try {
      media.writeWav(this.options.recordFile, Buffer.concat(this.recorded));
      log.info("call", "Recorded call audio to " + this.options.recordFile);
    } catch (e) {
      log.warn("call", "Could not write the call recording: " + e.message);
    }
  }
  try {
    if (this.sink) this.sink.stop();
    if (this.track && this.track.stop) this.track.stop();
    this.pc.close();
  } catch (e) {
    log.warn("call", "Error closing the peer connection: " + e.message);
  }
};

function createWrtcSession(options) {
  var wrtc = loadWrtc();
  if (!wrtc) return null;
  return new MediaSessionWrtc(wrtc, options);
}

module.exports = {
  createSession: createWrtcSession,
  isAvailable: function() { return !!loadWrtc(); }
};
