"use strict";

// Real WebRTC audio for calls, backed by the optional `werift` package
// (pure-JavaScript WebRTC for Node, MIT).
//
// A media session owns an RTCPeerConnection with a single audio track. Audio
// is G.711 PCMU (8 kHz, 20 ms frames): `audioFile` (a 16-bit PCM WAV) is
// streamed to the peer in a loop, everything received is written to
// `recordFile` (WAV) and/or passed to `onAudioData` (PCM16 buffers). Without
// `audioFile` silence is sent, which still negotiates and holds the media
// path open.
//
// The signaling client drives the session: it creates the offer (caller) or
// the answer (callee), feeds remote SDP/ICE in, and forwards local ICE
// candidates to the peer.

var fs = require("fs");
var log = require("npmlog");
var turn = require("./turn");

var SAMPLE_RATE = 8000;          // PCMU / recording rate
var OPUS_RATE = 48000;           // Opus operates at 48 kHz
var FRAME_MS = 20;
var SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000;
var OPUS_SAMPLES_PER_FRAME = (OPUS_RATE * FRAME_MS) / 1000;
var ULAW_BIAS = 0x84;
var ULAW_CLIP = 32635;

function loadWerift() {
  try {
    return require("werift");
  } catch (e) {
    return null;
  }
}

function loadOpus() {
  try {
    return require("opusscript");
  } catch (e) {
    return null;
  }
}

function resamplePcm(pcm, fromRate, toRate) {
  if (fromRate === toRate) return pcm;
  var inFrames = Math.floor(pcm.length / 2);
  if (!inFrames) return Buffer.alloc(0);
  var outFrames = Math.floor((inFrames * toRate) / fromRate);
  var out = Buffer.alloc(outFrames * 2);
  for (var n = 0; n < outFrames; n++) {
    var pos = (n * fromRate) / toRate;
    var idx = Math.floor(pos);
    var frac = pos - idx;
    var a = idx + 1 < inFrames ? pcm.readInt16LE(idx * 2) : pcm.readInt16LE((inFrames - 1) * 2);
    var b = idx + 1 < inFrames ? pcm.readInt16LE((idx + 1) * 2) : a;
    out.writeInt16LE(Math.round(a + (b - a) * frac), n * 2);
  }
  return out;
}

function wavToPcm(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  var offset = 12;
  var fmt = null;
  var data = null;
  while (offset + 8 <= buffer.length) {
    var id = buffer.toString("ascii", offset, offset + 4);
    var size = buffer.readUInt32LE(offset + 4);
    var body = buffer.subarray(offset + 8, offset + 8 + size);
    if (id === "fmt ") {
      fmt = {
        audioFormat: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bitsPerSample: body.readUInt16LE(14)
      };
    } else if (id === "data") {
      data = body;
    }
    offset += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("WAV is missing the fmt/data chunk");
  if (fmt.bitsPerSample !== 16) throw new Error("only 16-bit PCM WAV files are supported");

  // Down-mix to mono.
  var pcm = data;
  if (fmt.channels > 1) {
    var frames = Math.floor(data.length / (2 * fmt.channels));
    var mono = Buffer.alloc(frames * 2);
    for (var i = 0; i < frames; i++) {
      var sum = 0;
      for (var c = 0; c < fmt.channels; c++) sum += data.readInt16LE((i * fmt.channels + c) * 2);
      mono.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / fmt.channels))), i * 2);
    }
    pcm = mono;
  }

  return { pcm: pcm, sampleRate: fmt.sampleRate };
}

function pcm16ToUlaw(sample) {
  var s = sample;
  var sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > ULAW_CLIP) s = ULAW_CLIP;
  s += ULAW_BIAS;
  var exponent = 7;
  for (var mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  var mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function ulawToPcm16(u) {
  var x = ~u & 0xff;
  var sign = x & 0x80;
  var exponent = (x >> 4) & 0x07;
  var mantissa = x & 0x0f;
  var sample = ((mantissa << 3) + ULAW_BIAS) << exponent;
  sample -= ULAW_BIAS;
  return sign ? -sample : sample;
}

function pcm16ToUlawBuffer(pcm) {
  var out = Buffer.alloc(Math.floor(pcm.length / 2));
  for (var i = 0; i < out.length; i++) out[i] = pcm16ToUlaw(pcm.readInt16LE(i * 2));
  return out;
}

function ulawBufferToPcm16(ulaw) {
  var out = Buffer.alloc(ulaw.length * 2);
  for (var i = 0; i < ulaw.length; i++) out.writeInt16LE(ulawToPcm16(ulaw[i]), i * 2);
  return out;
}

function writeWav(file, pcm) {
  var header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, pcm]));
}

function MediaSession(werift, options) {
  this.options = options || {};
  this.closed = false;
  this.onCandidate = null;
  this.pendingRemoteCandidates = [];
  this.remoteDescriptionSet = false;
  this.recorded = [];
  this.sequenceNumber = 1;
  this.timestamp = 0;
  this.offset = 0;
  this.pump = null;
  this.diagnostics = 0;
  // `holdAudio` keeps the WAV paused until the peer joins (see mediaWrtc.js).
  this.autoStart = this.options.holdAudio !== true;
  // End-to-end encrypted calls (src/rtc/e2eeMedia.js): every encoded audio
  // frame is SFrame-encrypted before it is written and decrypted on receive.
  this.e2eeMedia = this.options.e2eeMedia || null;
  this.e2eeOutbound = Promise.resolve();
  this.e2eeInbound = Promise.resolve();

  // Opus is what Messenger's SFU conferences negotiate; PCMU is the fallback
  // when the optional opusscript package is not installed.
  var OpusScript = loadOpus();
  this.codec = this.options.codec === "pcmu" || !OpusScript ? "pcmu" : "opus";
  this.opusEncoder = null;
  this.opusDecoder = null;
  if (this.codec === "opus") {
    this.opusEncoder = new OpusScript(OPUS_RATE, 1, OpusScript.Application.AUDIO);
    this.opusDecoder = new OpusScript(OPUS_RATE, 1, OpusScript.Application.AUDIO);
    // opusscript defaults to a low bitrate; 128 kbps mono is transparent for
    // speech and music. Configurable with opusBitrate (Opus caps at 510 kbps).
    this.opusBitrate = this.options.opusBitrate || 128000;
    try {
      this.opusEncoder.setBitrate(this.opusBitrate);
    } catch (e) {
      log.verbose("call", "Media: could not set the Opus bitrate: " + e.message);
    }
  }

  var audioCodecs = this.codec === "opus"
    ? [werift.useOPUS({
      parameters: "minptime=10;usedtx=0;useinbandfec=0;maxaveragebitrate=" +
        (this.options.opusBitrate || 128000) + ";maxplaybackrate=48000"
    }), werift.usePCMU()]
    : [werift.usePCMU()];

  this.pc = new werift.RTCPeerConnection({
    iceServers: this.options.iceServers || [],
    iceUseIpv6: false,
    // Facebook's conference edge advertises TCP candidates (tcptype passive)
    // alongside UDP; on networks that block UDP to Facebook's media ports the
    // ICE-TCP path is the one that works (werift frames DTLS over it).
    iceUseTcp: this.options.iceUseTcp !== false,
    // "tcp" makes werift use the TURN relay over TCP/TLS (ports 443/8080),
    // which works on networks that block UDP to Facebook.
    turnTransport: this.options.turnTransport,
    // "relay" gathers only the TURN relay candidate (used for the SFU path
    // when direct connectivity is known to be blocked).
    iceTransportPolicy: this.options.iceTransportPolicy,
    // Multi-homed machines (VPN adapters, etc.) can pin ICE to the interface
    // that actually reaches Facebook: iceInterfaceAddresses: ["192.168.1.5"].
    iceInterfaceAddresses: this.options.iceInterfaceAddresses,
    iceAdditionalHostAddresses: this.options.iceAdditionalHostAddresses,
    codecs: { audio: audioCodecs, video: [] }
  });
  this.track = new werift.MediaStreamTrack({ kind: "audio" });
  // The stream id makes werift emit `a=msid:<stream> <track>` in the SDP; the
  // SFU uses the track id to map our published media status to this stream,
  // and without it the peer never receives our audio. werift assigns the
  // track's WebRTC `id` when the track is registered on the sender, so read it
  // after addTrack.
  this.mediaStream = new werift.MediaStream([this.track]);
  this.pc.addTrack(this.track, this.mediaStream);
  this.trackIds = { audio: this.track.id, video: null };
  // Facebook's SFU sends the other participant's stream on an m-line the
  // client offered as recvonly (the web client offers a second, receive-only
  // m-line). Without it the SFU's answer has nowhere to send the peer's audio.
  if (typeof this.pc.addTransceiver === "function") {
    try {
      this.receiveTransceiver = this.pc.addTransceiver("audio", { direction: "recvonly" });
    } catch (e) {
      log.warn("call", "Media: could not add the receive-only m-line: " + e.message);
    }
  }
  // The media cname identifies this endpoint in the call E2EE key exchange
  // (the peer reads it from our SDP and addresses frames to it).
  this.localCname = this.pc.cname;
  this.remoteCname = null;

  var sourceRate = this.codec === "opus" ? OPUS_RATE : SAMPLE_RATE;
  if (this.options.audioFile) {
    var wav = wavToPcm(fs.readFileSync(this.options.audioFile));
    this.sourcePcm = resamplePcm(wav.pcm, wav.sampleRate, sourceRate);
  } else {
    // Silence keeps the audio stream alive when no file is provided.
    this.sourcePcm = Buffer.alloc(sourceRate * 2);
  }
  if (this.codec === "pcmu") {
    this.ulaw = pcm16ToUlawBuffer(this.sourcePcm);
  }
  this.outboundOpus = this.codec === "opus";
  this.inboundOpus = this.codec === "opus";

  var self = this;
  // Facebook's SFU sends the other participant's audio on a sendonly m-line
  // without any a=ssrc attribute, so werift's RTP router (which routes by
  // SSRC) drops those packets before they can reach a receiver. Register
  // unknown SSRCs against the audio receiver so they are delivered.
  if (this.pc.router && typeof this.pc.router.routeRtp === "function") {
    var originalRoute = this.pc.router.routeRtp;
    this.pc.router.routeRtp = function(packet) {
      var router = self.pc.router;
      if (packet && packet.header && !router.ssrcTable[packet.header.ssrc]) {
        var receivers = self.pc.getReceivers ? self.pc.getReceivers() : [];
        var audioReceiver = receivers.filter(function(r) { return r.kind === "audio"; })[0];
        if (audioReceiver) {
          router.ssrcTable[packet.header.ssrc] = audioReceiver;
          log.verbose("call", "Media: routing unknown SSRC " + packet.header.ssrc + " to the audio receiver");
        }
      }
      return originalRoute(packet);
    };
  }
  this.pc.onIceCandidate.subscribe(function(candidate) {
    if (!candidate || !self.onCandidate) return;
    self.onCandidate({
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid || "0",
      sdpMLineIndex: Number(candidate.sdpMLineIndex) || 0
    });
  });
  this.pc.onTrack.subscribe(function(track) {
    log.info("call", "Media: remote " + track.kind + " track " + track.id);
    track.onReceiveRtp.subscribe(function(rtp) {
      self.handleIncomingRtp(rtp);
    });
  });
  this.dtlsTimer = setInterval(function() {
    if (self.closed || !self.pc) return;
    try {
      var transports = self.pc.dtlsTransports || [];
      var dtls = transports.map(function(t) { return t.state; }).join(",");
      log.info("call", "Media: state pc=" + self.pc.connectionState +
        " ice=" + self.pc.iceConnectionState + " dtls=[" + dtls + "]");
      if (log.verbose && transports.length) {
        var traffic = "";
        transports.forEach(function(t) {
          var connection = t.iceTransport && t.iceTransport.connection;
          var pair = connection && connection.nominated;
          if (!pair) return;
          traffic += " rx=" + (pair.packetsReceived || 0) + "/" + (pair.bytesReceived || 0) +
            " tx=" + (pair.packetsSent || 0) + "/" + (pair.bytesSent || 0);
        });
        var receivers = self.pc.getReceivers ? self.pc.getReceivers() : [];
        receivers.forEach(function(receiver) {
          traffic += " recv[" + receiver.kind + " rtcp=" + (receiver.__rtcpCount || 0) +
            " streams=" + Object.keys(receiver.remoteStreams || {}).length + "]";
        });
        if (traffic) log.verbose("call", "Media: traffic" + traffic);
      }
      if (self.pc.connectionState !== "connected" && self.diagnostics < 6) {
        self.diagnostics++;
        self.logIceDiagnostics();
      }
      // werift only sends application data (DTLS/SRTP) over a *nominated*
      // pair. Against Facebook's ice-lite SFU the regular nomination check
      // often never completes (TCP checks are sent without retransmissions),
      // which leaves DTLS stuck in "connecting" even though a pair works.
      // Nominate the first succeeded pair, and re-run failed TCP checks (the
      // only path that works on networks blocking UDP to Facebook).
      transports.forEach(function(transport) {
        var connection = transport.iceTransport && transport.iceTransport.connection;
        if (!connection || connection.nominated) return;
        var pairs = connection.checkList || [];
        var succeeded = pairs.filter(function(pair) { return pair.state === 3; });
        if (succeeded.length) {
          connection.nominated = succeeded[0];
          // werift only starts the consent-to-send lifecycle (which sets
          // consentFresh, required before any DTLS/SRTP is sent) when its own
          // nomination completes, so kick it off here.
          try {
            if (typeof connection.queryConsent === "function") connection.queryConsent();
            if (typeof connection.setState === "function") connection.setState("connected");
          } catch (e) { /* ignore */ }
          log.info("call", "Media: nominated " + describePair(connection.nominated) +
            " (aggressive nomination)");
          return;
        }
        pairs.forEach(function(pair) {
          var kind = ((pair.localCandidate && pair.localCandidate.transport) || "").toLowerCase();
          if (kind !== "tcp") return;
          if (pair.state === 2) return; // in progress
          try {
            connection.checkStart(pair);
          } catch (e) { /* ignore */ }
        });
      });
      // Start DTLS only once a pair is *nominated*: werift drops application
      // data (the DTLS ClientHello) while no pair is nominated, and it does
      // not retransmit the handshake, so starting early leaves DTLS stuck.
      self.attachReceiverFallback();
      transports.forEach(function(transport) {
        var connection = transport.iceTransport && transport.iceTransport.connection;
        if (self.remoteDescriptionSet && transport.state === "new" &&
          connection && connection.nominated) {
          log.info("call", "Media: starting DTLS (nominated pair ready)");
          transport.start().catch(function(e) {
            log.warn("call", "Media: DTLS start failed: " + e.message);
          });
        }
      });
      // The peer connection state is derived from the DTLS transports; when
      // the ICE layer was nominated manually that bookkeeping can lag, so the
      // "connected" side effects are triggered from the DTLS state too.
      transports.forEach(function(transport) {
        if (transport.state === "connected") self.notifyConnected();
      });
    } catch (e) { /* ignore */ }
  }, 1000);

  this.pc.onconnectionstatechange = function() {
    log.info("call", "Media: peer connection state = " + self.pc.connectionState +
      " (ice " + self.pc.iceConnectionState + ")");
    if (self.pc.connectionState === "connected") self.notifyConnected();
    // werift can report "failed" while ICE/DTLS are still up (its state
    // aggregation lags behind the manual nomination), so only a closed
    // connection stops the audio.
    if (self.pc.connectionState === "closed") self.stopAudio();
  };
}

// Side effects of a usable media path: refresh the negotiated codec, start the
// audio (unless it is held for the peer to join) and announce the connection.
MediaSession.prototype.notifyConnected = function() {
  if (this.connectedNotified) return;
  this.connectedNotified = true;
  this.refreshNegotiatedCodec();
  log.info("call", "Media: connected, outbound " + (this.outboundOpus ? "opus" : "pcmu") +
    ", inbound " + (this.inboundOpus ? "opus" : "pcmu"));
  if (this.autoStart) this.startAudio();
  else log.info("call", "Media: connected; holding the audio until the peer joins");
  if (this.onConnected) this.onConnected();
};

// Inbound RTP (from a subscribed track or the receiver's default track):
// decrypt (when the call is end-to-end encrypted) and decode.
MediaSession.prototype.handleIncomingRtp = function(rtp) {
  var self = this;
  var payload = Buffer.from(rtp.payload);
  if (!this.e2eeMedia) {
    this.onReceivedAudio(payload);
    return;
  }
  // Keep the decryption order: audio frames must be decoded in sequence.
  this.e2eeInbound = this.e2eeInbound.then(function() {
    return new Promise(function(resolve) {
      self.e2eeMedia.decrypt(payload, function(err, errorCode, plain) {
        if (err) {
          log.verbose("call", "Media: could not decrypt a frame: " + err.message);
        } else if (errorCode !== 0 || !plain) {
          log.verbose("call", "Media: dropping an undecryptable frame (error " + errorCode + ")");
        } else {
          self.onReceivedAudio(plain);
        }
        resolve();
      });
    });
  });
};

// The SFU's sendonly m-line carries no a=ssrc, so werift would drop its RTP
// (unknown SSRC). Map unknown SSRCs to the receiver's default track and feed
// that track's packets into the same decode path.
MediaSession.prototype.attachReceiverFallback = function() {
  var self = this;
  var receivers = this.pc.getReceivers ? this.pc.getReceivers() : [];
  receivers.forEach(function(receiver) {
    if (receiver.__fallbackAttached) return;
    receiver.__fallbackAttached = true;
    var original = receiver.trackBySSRC || {};
    receiver.trackBySSRC = new Proxy(original, {
      get: function(target, prop) {
        if (prop in target) return target[prop];
        return receiver.defaultTrack;
      }
    });
    if (receiver.defaultTrack) {
      receiver.defaultTrack.onReceiveRtp.subscribe(function(rtp) {
        self.handleIncomingRtp(rtp);
      });
    }
    if (receiver.onRtcp && !receiver.__rtcpCounted) {
      receiver.__rtcpCounted = true;
      receiver.__rtcpCount = 0;
      receiver.onRtcp.subscribe(function() {
        receiver.__rtcpCount++;
      });
    }
  });
};

// Windows' default ~15.6 ms timer granularity makes setInterval(20) fire every
// ~31 ms, which streams audio at ~64% of real time (it sounds slow and
// stretched). Schedule every frame against an absolute monotonic deadline so
// the average rate stays exact; the arrival jitter is what receivers' jitter
// buffers are for.
function startFramePump(session, frame, frameMs) {
  var start = Number(process.hrtime.bigint());
  var target = start + frameMs * 1e6;
  function tick() {
    if (!session.pump) return;
    var now = Number(process.hrtime.bigint());
    if (now + 1e6 < target) {
      // The timer fired early (the OS rounds up to its clock tick): wait it out.
      session.pump = setTimeout(tick, (target - now) / 1e6);
      return;
    }
    frame();
    target += frameMs * 1e6;
    now = Number(process.hrtime.bigint());
    // After a big stall (process suspended, heavy GC) skip the missed frames
    // instead of sending a burst of them.
    if (now - target > frameMs * 2e6) target = now + frameMs * 1e6;
    session.pump = setTimeout(tick, Math.max(0, (target - now) / 1e6));
  }
  frame();
  session.pump = setTimeout(tick, frameMs);
}

MediaSession.prototype.startAudio = function() {
  var self = this;
  if (this.pump || this.closed) return;

  function sendRtp(payload, samples) {
    var werift = loadWerift();
    var sequenceNumber = self.sequenceNumber;
    var timestamp = self.timestamp;
    self.sequenceNumber = (self.sequenceNumber + 1) & 0xffff;
    self.timestamp = (self.timestamp + samples) >>> 0;

    function write(frame) {
      var packet = new werift.RtpPacket(
        new werift.RtpHeader({
          version: 2,
          payloadType: self.codec === "opus" ? 111 : 0,
          sequenceNumber: sequenceNumber,
          timestamp: timestamp,
          ssrc: 0x12345678,
          marker: true
        }),
        frame
      );
      self.sentPackets = (self.sentPackets || 0) + 1;
      if (self.sentPackets === 1) {
        log.info("call", "Media: sending RTP (payload " + packet.header.payloadType + ", " + frame.length + " bytes/frame)");
      } else if (self.sentPackets % 500 === 0) {
        log.info("call", "Media: " + self.sentPackets + " RTP packets sent");
      }
      self.track.writeRtp(packet);
    }

    if (self.e2eeMedia) {
      // Keep the frame order: each frame waits for the previous encryption.
      self.e2eeOutbound = self.e2eeOutbound.then(function() {
        return new Promise(function(resolve) {
          self.e2eeMedia.encrypt(payload, function(err, errorCode, encrypted) {
            if (err) {
              log.verbose("call", "Media: could not encrypt a frame: " + err.message);
            } else if (errorCode !== 0 || !encrypted) {
              log.verbose("call", "Media: dropping a frame that could not be encrypted (error " + errorCode + ")");
            } else {
              write(encrypted);
            }
            resolve();
          });
        });
      });
      return;
    }

    write(payload);
  }

  function frame() {
    if (self.options.frameTrace) {
      var now = Date.now();
      self.frameDeltas = self.frameDeltas || [];
      if (self.lastFrameAt) self.frameDeltas.push(now - self.lastFrameAt);
      self.lastFrameAt = now;
      if (self.frameDeltas.length === 100) {
        var sum = self.frameDeltas.reduce(function(a, b) { return a + b; }, 0);
        log.info("call", "Media: frame interval avg=" + (sum / 100).toFixed(1) +
          "ms min=" + Math.min.apply(null, self.frameDeltas) +
          " max=" + Math.max.apply(null, self.frameDeltas) + "ms");
      }
    }
    if (self.outboundOpus) {
      var sourceFrames = Math.floor(self.sourcePcm.length / 2);
      var chunk = Buffer.alloc(OPUS_SAMPLES_PER_FRAME * 2);
      for (var n = 0; n < OPUS_SAMPLES_PER_FRAME; n++) {
        var sample = sourceFrames ? self.sourcePcm.readInt16LE(((self.offset + n) % sourceFrames) * 2) : 0;
        chunk.writeInt16LE(sample, n * 2);
      }
      self.offset = sourceFrames ? (self.offset + OPUS_SAMPLES_PER_FRAME) % sourceFrames : 0;
      sendRtp(self.opusEncoder.encode(chunk, OPUS_SAMPLES_PER_FRAME), OPUS_SAMPLES_PER_FRAME);
      return;
    }

    var ulaw = self.ulaw || pcm16ToUlawBuffer(resamplePcm(self.sourcePcm, OPUS_RATE, SAMPLE_RATE));
    var payload = Buffer.alloc(SAMPLES_PER_FRAME);
    for (var i = 0; i < SAMPLES_PER_FRAME; i++) {
      payload[i] = ulaw[self.offset % ulaw.length];
      self.offset += 1;
    }
    sendRtp(payload, SAMPLES_PER_FRAME);
  }
  startFramePump(this, frame, FRAME_MS);
};

// After SDP negotiation werift knows which codec was actually selected; the
// SFU may accept Opus while a peer picks PCMU.
MediaSession.prototype.refreshNegotiatedCodec = function() {
  try {
    var senders = this.pc.getSenders ? this.pc.getSenders() : [];
    var receivers = this.pc.getReceivers ? this.pc.getReceivers() : [];
    if (senders && senders.length && senders[0].codec && senders[0].codec.mimeType) {
      this.outboundOpus = /opus/i.test(senders[0].codec.mimeType);
    }
    if (receivers && receivers.length && receivers[0].codec && receivers[0].codec.mimeType) {
      this.inboundOpus = /opus/i.test(receivers[0].codec.mimeType);
    }
  } catch (e) {
    log.verbose("call", "Could not read the negotiated codec: " + e.message);
  }
};

MediaSession.prototype.stopAudio = function() {
  if (this.pump) clearTimeout(this.pump);
  this.pump = null;
};

MediaSession.prototype.onReceivedAudio = function(payload) {
  this.receivedPackets = (this.receivedPackets || 0) + 1;
  if (this.receivedPackets === 1) {
    log.info("call", "Media: receiving RTP from the peer");
  }
  var pcm;
  if (this.inboundOpus && this.opusDecoder) {
    try {
      pcm = resamplePcm(this.opusDecoder.decode(payload), OPUS_RATE, SAMPLE_RATE);
    } catch (e) {
      log.verbose("call", "Could not decode an Opus frame: " + e.message);
      return;
    }
  } else {
    pcm = ulawBufferToPcm16(payload);
  }
  if (this.options.recordFile) this.recorded.push(pcm);
  if (typeof this.options.onAudioData === "function") {
    try {
      this.options.onAudioData(pcm, payload);
    } catch (e) {
      log.warn("call", "onAudioData handler threw: " + e.message);
    }
  }
};

function sdpSummary(sdp) {
  var lines = (sdp || "").split(/\r?\n/);
  return ["m=", "a=fingerprint", "a=setup", "a=ice-ufrag", "a=mid"].map(function(prefix) {
    var line = lines.filter(function(l) { return l.indexOf(prefix) === 0; })[0];
    return line ? line.slice(0, 120) : prefix + "(none)";
  }).join(" | ");
}

MediaSession.prototype.setRemoteDescription = function(type, sdp, callback) {
  var self = this;
  log.info("call", "Media: remote " + type + " sdp: " + sdpSummary(sdp));
  this.pc.setRemoteDescription({ type: type, sdp: sdp }).then(function() {
    self.remoteDescriptionSet = true;
    self.refreshNegotiatedCodec();
    self.applyRemoteCname(sdp);
    self.attachReceiverFallback();
    self.flushRemoteCandidates();
    callback(null);
  }).catch(function(e) {
    callback(e);
  });
};

// The peer's media cname (`a=ssrc:<id> cname:<value>`) identifies it in the
// call E2EE key exchange; the frame decryptor is bound to it.
MediaSession.prototype.applyRemoteCname = function(sdp) {
  var match = /a=ssrc:\d+\s+cname:(\S+)/.exec(sdp || "");
  if (!match || !match[1] || this.remoteCname === match[1]) return;
  this.remoteCname = match[1];
  if (this.e2eeMedia) this.e2eeMedia.setRemoteE2eeId(this.remoteCname);
};

// Facebook's SFU expects the candidates in the SDP itself; werift only adds
// them to `localDescription` once gathering finishes, so wait for it.
MediaSession.prototype.waitForGathering = function(callback) {
  var self = this;
  var started = Date.now();
  var timer = setInterval(function() {
    if (self.closed || self.pc.iceGatheringState === "complete" || Date.now() - started > 8000) {
      clearInterval(timer);
      callback();
    }
  }, 200);
};

MediaSession.prototype.logCandidateTypes = function(sdp) {
  var types = {};
  (sdp.match(/a=candidate[^\r\n]*/g) || []).forEach(function(candidate) {
    var match = /typ (\w+)/.exec(candidate);
    if (match) types[match[1]] = (types[match[1]] || 0) + 1;
  });
  log.info("call", "Media: local candidates " + JSON.stringify(types));
};

MediaSession.prototype.createOffer = function(callback) {
  var self = this;
  this.pc.createOffer()
    .then(function(offer) {
      return self.pc.setLocalDescription(offer);
    })
    .then(function() {
      self.waitForGathering(function() {
        var sdp = self.pc.localDescription ? self.pc.localDescription.sdp : "";
        self.logCandidateTypes(sdp);
        callback(null, sdp);
      });
    })
    .catch(function(e) { callback(e); });
};

MediaSession.prototype.createAnswer = function(remoteSdp, callback) {
  var self = this;
  this.setRemoteDescription("offer", remoteSdp, function(err) {
    if (err) return callback(err);
    self.pc.createAnswer()
      .then(function(answer) {
        return self.pc.setLocalDescription(answer);
      })
      .then(function() {
        self.waitForGathering(function() {
          var sdp = self.pc.localDescription ? self.pc.localDescription.sdp : "";
          callback(null, sdp);
        });
      })
      .catch(function(e) { callback(e); });
  });
};

MediaSession.prototype.setRemoteAnswer = function(remoteSdp, callback) {
  this.setRemoteDescription("answer", remoteSdp, callback || function() {});
};

MediaSession.prototype.addRemoteCandidate = function(candidate, callback) {
  callback = callback || function() {};
  if (!this.remoteDescriptionSet) {
    this.pendingRemoteCandidates.push(candidate);
    return callback(null);
  }
  this.pc.addIceCandidate(candidate).then(function() {
    callback(null);
  }).catch(function(e) {
    callback(e);
  });
};

MediaSession.prototype.flushRemoteCandidates = function() {
  var self = this;
  var queued = this.pendingRemoteCandidates;
  this.pendingRemoteCandidates = [];
  queued.forEach(function(candidate) {
    self.pc.addIceCandidate(candidate).catch(function(e) {
      log.warn("call", "Could not add a remote ICE candidate: " + e.message);
    });
  });
};

// Logs the ICE check list so connectivity problems are visible: pairs stuck
// in "frozen"/"waiting" mean checks are not being sent, "failed" pairs mean
// the peer/relay did not answer.
var iceStateNames = { 0: "frozen", 1: "waiting", 2: "in-progress", 3: "succeeded", 4: "failed" };

function describePair(pair) {
  var local = pair.localCandidate || {};
  var remote = pair.remoteCandidate || {};
  return (local.type || "?") + "@" + (local.host || "?") + ":" + (local.port || "?") +
    " -> " + (remote.type || "?") + "@" + (remote.host || "?") + ":" + (remote.port || "?") +
    " [" + (iceStateNames[pair.state] || pair.state) + "]";
}

// Returns the ICE connection of the first media transport, or null.
MediaSession.prototype.iceConnection = function() {
  var transport = (this.pc.dtlsTransports || [])[0];
  if (!transport || !transport.iceTransport) return null;
  return transport.iceTransport.connection || null;
};

MediaSession.prototype.logIceDiagnostics = function() {
  try {
    (this.pc.dtlsTransports || []).forEach(function(transport) {
      var ice = transport.iceTransport;
      if (!ice) return;
      var connection = ice.connection || {};
      var pairs = connection.checkList || ice.checkList || [];
      if (!pairs.length) {
        log.info("call", "Media: ICE has no candidate pairs (remote candidates=" +
          ((connection._remoteCandidates || []).length) + ", remote ufrag=" +
          (connection.remoteUsername || "?") + ")");
        return;
      }
      var succeeded = pairs.filter(function(pair) { return pair.state === 3; }).length;
      if (connection.nominated) {
        var nominated = connection.nominated;
        var local = nominated.localCandidate || {};
        var remote = nominated.remoteCandidate || {};
        log.info("call", "Media: ICE nominated " + describePair(nominated) +
          " (protocol " + (local.protocol || local.transport || "?") +
          " -> " + (remote.protocol || remote.transport || "?") + ")");
      }
      log.info("call", "Media: ICE checks (" + pairs.length + ", " + succeeded + " succeeded): " +
        pairs.slice(0, 32).map(describePair).join(" | "));
    });
  } catch (e) {
    log.verbose("call", "Media: ICE diagnostics failed: " + e.message);
  }
};

// Facebook hands out TURN relays for peer-to-peer calls in the join/ring
// response (`relayInfo`); applying them makes media work behind NAT.
MediaSession.prototype.setIceServers = function(iceServers) {
  iceServers = turn.orderForTransport(iceServers, this.options.turnTransport);
  this.options.iceServers = iceServers;
  try {
    this.pc.setConfiguration({ iceServers: iceServers });
    // Gather again so relay candidates are emitted (the client trickles them
    // to the peer even after the initial offer).
    if (typeof this.pc.gatherCandidates === "function") {
      Promise.resolve(this.pc.gatherCandidates()).catch(function(e) {
        log.verbose("call", "Media: re-gathering after relay update failed: " + e.message);
      });
    }
  } catch (e) {
    log.warn("call", "Could not apply the relay configuration: " + e.message);
  }
};

// relayInfo: the thrift `RelayInfo` from a join response or RING. Every
// transport the server offers is included (TURN over UDP, plain TCP and TLS);
// the session picks the first one that matches its `turnTransport` option.
function iceServersFromRelayInfo(relayInfo) {
  if (!relayInfo) return [];
  var servers = turn.toIceServers(relayInfo);
  if (!servers.length && relayInfo.turnUsername && relayInfo.turnPassword) {
    servers.push({
      urls: "turn:turn.facebook.com:3478?transport=udp",
      username: relayInfo.turnUsername,
      credential: relayInfo.turnPassword
    });
  }
  return servers;
}

MediaSession.prototype.close = function() {
  if (this.closed) return;
  this.closed = true;
  if (this.dtlsTimer) clearInterval(this.dtlsTimer);
  this.stopAudio();
  if (this.options.recordFile && this.recorded.length) {
    try {
      writeWav(this.options.recordFile, Buffer.concat(this.recorded));
      log.info("call", "Recorded call audio to " + this.options.recordFile);
    } catch (e) {
      log.warn("call", "Could not write the call recording: " + e.message);
    }
  }
  try {
    this.pc.close();
  } catch (e) {
    log.warn("call", "Error closing the peer connection: " + e.message);
  }
};

// Engine selection: `options.engine` forces "wrtc" (full libwebrtc, supports
// TURN-TCP / DTLS over ICE-TCP) or "werift". When not forced, the full
// libwebrtc binding is preferred if it is installed, because it is the only
// one that works on networks blocking outbound UDP to Facebook.
//
// End-to-end encrypted calls always use werift: SFrame encryption has to
// happen on the encoded frames, and werift gives raw RTP access
// (@roamhq/wrtc has no insertable streams).
function createMediaSession(options) {
  options = options || {};
  if (options.e2eeMedia) {
    var weriftForE2ee = loadWerift();
    if (!weriftForE2ee) return null;
    return new MediaSession(weriftForE2ee, options);
  }
  if (options.engine !== "werift") {
    var wrtcEngine = null;
    try {
      wrtcEngine = require("./mediaWrtc");
    } catch (e) {
      wrtcEngine = null;
    }
    if (wrtcEngine && wrtcEngine.isAvailable()) {
      return wrtcEngine.createSession(options);
    }
    if (options.engine === "wrtc") return null;
  }
  var werift = loadWerift();
  if (!werift) return null;
  return new MediaSession(werift, options);
}

module.exports = {
  createMediaSession: createMediaSession,
  iceServersFromRelayInfo: iceServersFromRelayInfo,
  // Shared by the alternative engine (mediaWrtc.js).
  wavToPcm: wavToPcm,
  resamplePcm: resamplePcm,
  writeWav: writeWav,
  startFramePump: startFramePump,
  isAvailable: function() {
    var wrtc = false;
    try {
      wrtc = require("./mediaWrtc").isAvailable();
    } catch (e) { /* not installed */ }
    return wrtc || !!loadWerift();
  }
};
