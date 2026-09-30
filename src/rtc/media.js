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
var childProcess = require("child_process");
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

// Loading werift and its dependencies takes ~0.6 s the first time, which used
// to block the event loop (signaling included) while a call was being placed.
// connectCalls loads them ahead of time.
function preloadEngines() {
  loadWerift();
  loadOpus();
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

// Decodes a video file's soundtrack to mono 16-bit PCM at `rate` with ffmpeg,
// in the background (~0.4 s for a 2-minute file, which used to block the event
// loop during the call setup). Calls back with null when the file has no audio
// track or ffmpeg isn't available.
function videoSoundtrack(file, rate, callback) {
  var chunks = [];
  var stderr = "";
  var proc;
  try {
    proc = childProcess.spawn("ffmpeg", [
      "-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"
    ]);
  } catch (e) {
    log.warn("call", "Media: could not read the video's audio (" + e.message + "); sending silence");
    return setImmediate(function() { callback(null); });
  }
  var done = false;
  function finish(pcm, reason) {
    if (done) return;
    done = true;
    if (!pcm) {
      log.warn("call", "Media: could not read the video's audio (" + reason + "); sending silence");
    } else {
      log.info("call", "Media: using the video's soundtrack (" + (pcm.length / 2 / rate).toFixed(1) + " s)");
    }
    callback(pcm);
  }
  proc.stdout.on("data", function(chunk) { chunks.push(chunk); });
  proc.stderr.on("data", function(chunk) { stderr = (stderr + chunk).slice(-400); });
  proc.on("error", function(err) { finish(null, err.message); });
  proc.on("close", function(code) {
    var pcm = Buffer.concat(chunks);
    if (code !== 0 || !pcm.length) finish(null, stderr.trim().slice(0, 200) || "no audio track");
    else finish(pcm);
  });
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

  // `videoFile` streams a video as an H.264 track: ffmpeg decodes/encodes the
  // file (in a loop), the NAL units are packetized into RTP (RFC 6184,
  // packetization-mode=1) and written to the track, and the E2EE layer
  // encrypts every packet payload the same way it does for audio. Messenger's
  // conference rejects offers without H.264 ("codecs are incompatible").
  this.videoCodecs = this.options.videoFile
    ? [werift.useH264({
      payloadType: 97,
      rtcpFeedback: [werift.useNACK(), werift.usePLI(), werift.useFIR(), werift.useREMB(), werift.useTWCC()]
    })]
    : [];
  // The conference only accepts (and uses) header extensions that are
  // negotiated properly: werift puts them in the SDP and writes mid,
  // abs-send-time and transport-wide sequence numbers into every packet it
  // sends. Extensions pasted into the SDP text afterwards were dropped by the
  // server and never appeared in our packets. The generic frame descriptor is
  // written by hand (see packetizeNalUnits) but still has to be negotiated.
  this.videoHeaderExtensions = this.options.videoFile
    ? [werift.useSdesMid(), werift.useAbsSendTime(), werift.useTransportWideCC(),
      { uri: GENERIC_FRAME_DESCRIPTOR_URI }, { uri: VIDEO_LAYERS_ALLOCATION_URI }]
    : [];

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
    codecs: { audio: audioCodecs, video: this.videoCodecs },
    headerExtensions: { video: this.videoHeaderExtensions },
    // One bundled transport, like browsers. werift's default ("max-compat")
    // gives our offers a transport per m-line, and those never connected.
    bundlePolicy: "max-bundle"
  });
  this.countIncomingRtcp();
  this.track = new werift.MediaStreamTrack({ kind: "audio" });
  // The stream id makes werift emit `a=msid:<stream> <track>` in the SDP; the
  // SFU uses the track id to map our published media status to this stream,
  // and without it the peer never receives our audio. werift assigns the
  // track's WebRTC `id` when it is registered on the sender, so read it
  // after addTrack.
  this.mediaStream = new werift.MediaStream([this.track]);
  this.pc.addTrack(this.track, this.mediaStream);
  this.trackIds = { audio: this.track.id, video: null };
  if (this.options.videoFile) {
    this.videoTrack = new werift.MediaStreamTrack({ kind: "video" });
    this.pc.addTrack(this.videoTrack, this.mediaStream);
    this.trackIds.video = this.videoTrack.id;
    // Simulcast layers, like the web client: three encodings of the same
    // source, each with its own SSRC (announced via a=ssrc-group:SIM).
    var layerConfigs = Array.isArray(this.options.videoLayers) && this.options.videoLayers.length
      ? this.options.videoLayers
      : DEFAULT_VIDEO_LAYERS;
    // One ffprobe for everything (each run blocks for ~120 ms).
    var probed = probeVideo(this.options.videoFile);
    var source = probed.width > 0 && probed.height > 0 ? { width: probed.width, height: probed.height } : null;
    this.videoDurationMs = probed.durationMs;
    // In stream-copy mode the encoder cannot override the file's frame rate,
    // so take it from the file; otherwise the RTP timestamps would run at the
    // configured rate and the picture would play too fast or too slow.
    if (this.options.videoStreamCopy) {
      var probedFps = probed.fps;
      if (probedFps) {
        layerConfigs = layerConfigs.map(function(config) {
          return Object.assign({}, config, { fps: probedFps });
        });
      }
    }
    this.videoLayers = layerConfigs.map(function(config, index) {
      return {
        config: config,
        ssrc: (Math.random() * 0xffffffff) >>> 0,
        sequenceNumber: 1,
        timestamp: 0,
        frameId: 0,
        // Each simulcast encoding is its own single-spatial-layer stream, so
        // the descriptor's spatial bitmask is 1 for every layer. Encoding the
        // layer index here (1, 2, 4) made the receiver wait for spatial layers
        // that never arrive on that stream and ask for keyframes forever.
        spatialBit: 1,
        vlaIndex: index,
        width: config.width,
        height: source ? Math.max(2, Math.round(config.width * source.height / source.width / 2) * 2) : 0,
        proc: null,
        buffer: Buffer.alloc(0),
        accessUnit: []
      };
    });
  }
  // Messenger web offers only its own audio and video (plus a data channel):
  // the SFU then renegotiates to add the other participant's streams, and that
  // offer's a=ssrc cname ("<userId>:<cname>") is how the E2EE stack learns the
  // peer's media identity. Pre-opening receive-only m-lines meant the SFU never
  // renegotiated, so in calls we placed the key exchange never started and the
  // peer couldn't decrypt our media. Kept behind an option.
  // Messenger web's offers always end with a data channel m-line
  // (m=application ... webrtc-datachannel); the SFU's later offer adds the
  // other participant's streams after it. Offer one too.
  // Nothing is sent over it, so it's pre-negotiated with a fixed id: an
  // in-band opened channel crashed the process in werift's SCTP code
  // (dataChannelFlush reads an unset stream id) once the association came up.
  if (this.options.dataChannel !== false && typeof this.pc.createDataChannel === "function") {
    try {
      this.dataChannel = this.pc.createDataChannel("data", { negotiated: true, id: 1 });
    } catch (e) {
      log.verbose("call", "Media: could not add the data channel: " + e.message);
    }
  }
  if (this.options.receiveOnlyMLines === true && typeof this.pc.addTransceiver === "function") {
    try {
      this.receiveTransceiver = this.pc.addTransceiver("audio", { direction: "recvonly" });
      if (this.options.videoFile) {
        // The web client also opens a receive-only video m-line; the SFU
        // forwards the peer's video through it.
        this.videoReceiveTransceiver = this.pc.addTransceiver("video", { direction: "recvonly" });
      }
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
  } else if (this.options.videoFile && this.options.videoAudio !== false) {
    // No separate audio file: send the video's own soundtrack. It is decoded in
    // the background; the media starts seconds later (once the peer joins),
    // and startAudio waits for it if it isn't ready yet.
    var session = this;
    this.sourcePcm = Buffer.alloc(sourceRate * 2);
    this.soundtrackPending = true;
    videoSoundtrack(this.options.videoFile, sourceRate, function(pcm) {
      session.soundtrackPending = false;
      if (pcm) {
        session.sourcePcm = pcm;
        // The PCMU payload is derived from the source (see startAudio).
        session.ulaw = session.codec === "pcmu" ? pcm16ToUlawBuffer(pcm) : null;
      }
      if (session.startAudioWhenReady) {
        session.startAudioWhenReady = false;
        session.startAudio();
      }
    });
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
    // Only audio is decoded; the peer's video would otherwise go through the
    // decrypt round trip and the Opus decoder for nothing.
    if (track.kind !== "audio") return;
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
        // Feedback about what we send (receiver reports, PLI/FIR, NACK, REMB,
        // transport-cc), per SSRC we send on (see countIncomingRtcp).
        if (self.rtcpAbout) {
          traffic += " feedback=" + JSON.stringify(self.rtcpAbout);
        }
        if (self.rembBps) {
          traffic += " remb=" + JSON.stringify(self.rembBps);
        }
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
        if (transport.state === "connected") {
          self.guardDtlsTransport(transport);
          self.notifyConnected();
        }
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

// werift fails a DTLS transport on any error while handling a handshake record,
// including one arriving after the handshake (the SFU retransmitting its last
// flight). The SRTP keys are unaffected, but werift's senders drop every
// packet while the transport isn't "connected", so all outbound media went
// silent mid-call while ICE stayed up. Once the handshake has completed, such
// a failure is logged and the transport put back to "connected".
MediaSession.prototype.guardDtlsTransport = function(transport) {
  if (transport.__mediaGuarded || !transport.onStateChange) return;
  transport.__mediaGuarded = true;
  var self = this;
  if (transport.dtls && transport.dtls.onError) {
    transport.dtls.onError.subscribe(function(error) {
      log.warn("call", "Media: DTLS error after the handshake: " +
        (error && (error.stack || error.message) || error));
    });
  }
  transport.onStateChange.subscribe(function(state) {
    if (state !== "failed" || self.closed) return;
    // Restored after werift's own state-change handling has run.
    setImmediate(function() {
      if (self.closed || transport.state !== "failed" || !transport.srtp) return;
      var ice = self.pc && self.pc.iceConnectionState;
      if (ice !== "connected" && ice !== "completed") {
        log.warn("call", "Media: DTLS failed with ICE " + ice + "; not recovering");
        return;
      }
      self.dtlsRecoveries = (self.dtlsRecoveries || 0) + 1;
      log.warn("call", "Media: DTLS reported failed after the handshake (ICE " + ice +
        "); keeping the SRTP session (recovery #" + self.dtlsRecoveries + ")");
      transport.setState("connected");
    });
  });
};

// werift drops RTP silently unless a DTLS transport is connected; the send
// counters only count packets that can actually leave.
MediaSession.prototype.canSendRtp = function() {
  var transports = (this.pc && this.pc.dtlsTransports) || [];
  var up = transports.some(function(t) { return t.state === "connected"; });
  if (up) {
    if (this.blockedPackets) {
      log.info("call", "Media: sending again after " + this.blockedPackets + " blocked RTP packets");
      this.blockedPackets = 0;
    }
    return true;
  }
  this.blockedPackets = (this.blockedPackets || 0) + 1;
  if (this.blockedPackets === 1) {
    log.warn("call", "Media: no connected DTLS transport (" +
      transports.map(function(t) { return t.state; }).join(",") + "); RTP is not being sent");
  }
  return false;
};

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
  // The runner answers requests in the order they were sent, so frames are
  // still decoded in sequence without waiting for each one.
  this.e2eeMedia.decrypt(payload, function(err, errorCode, plain) {
    if (err) {
      log.verbose("call", "Media: could not decrypt a frame: " + err.message);
    } else if (errorCode !== 0 || !plain) {
      log.verbose("call", "Media: dropping an undecryptable frame (error " + errorCode + ")");
    } else {
      self.onReceivedAudio(plain);
    }
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
    if (receiver.defaultTrack && receiver.kind === "audio") {
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

// Diagnostics for the verbose traffic log: counts incoming RTCP by the SSRC it
// is about and by type, before werift routes it. werift only knows each
// sender's original SSRC, so feedback about our simulcast layers never reaches
// a sender and can't be observed there. Packets are passed on unchanged.
MediaSession.prototype.countIncomingRtcp = function() {
  var self = this;
  var router = this.pc && this.pc.router;
  if (!router || typeof router.routeRtcp !== "function" || router.__counted) return;
  router.__counted = true;
  this.rtcpAbout = {};
  var route = router.routeRtcp;
  function label(ssrc) {
    if (ssrc == null) return "?";
    var layer = (self.videoLayers || []).filter(function(l) { return l.ssrc === ssrc; })[0];
    if (layer) return "video" + layer.config.width;
    var audio = (self.pc.getSenders() || []).filter(function(s) { return s.track && s.track.kind === "audio"; })[0];
    if (audio && audio.ssrc === ssrc) return "audio";
    return "other";
  }
  function add(ssrc, type) {
    var key = label(ssrc);
    var counts = self.rtcpAbout[key] = self.rtcpAbout[key] || {};
    counts[type] = (counts[type] || 0) + 1;
  }
  router.routeRtcp = function(packet) {
    try {
      var name = packet && packet.constructor ? packet.constructor.name : "";
      var feedback = packet && packet.feedback;
      var fname = feedback && feedback.constructor ? feedback.constructor.name : "";
      if (name === "RtcpRrPacket") {
        (packet.reports || []).forEach(function(r) { add(r.ssrc, "RR"); });
      } else if (name === "RtcpSrPacket") {
        (packet.reports || []).forEach(function(r) { add(r.ssrc, "SR-report"); });
      } else if (fname === "ReceiverEstimatedMaxBitrate") {
        (feedback.ssrcFeedbacks || []).forEach(function(s) { add(s, "REMB"); });
        self.rembBps = self.rembBps || {};
        if (feedback.bitrate != null) {
          // werift exposes the REMB bitrate as a BigInt.
          var total = Math.round(Number(feedback.bitrate));
          self.lastRembAt = Date.now();
          (feedback.ssrcFeedbacks || []).forEach(function(s) {
            self.rembBps[s] = total;
          });
        }
        self.scheduleBitrateAdaptation();
      } else if (fname === "PictureLossIndication") {
        add(feedback.mediaSsrc, "PLI");
        self.onKeyFrameRequest(feedback.mediaSsrc);
      } else if (fname === "FullIntraRequest") {
        (feedback.fir || []).forEach(function(f) { add(f.ssrc, "FIR"); });
        if (!(feedback.fir || []).length) add(feedback.mediaSsrc, "FIR");
        if ((feedback.fir || []).length) {
          (feedback.fir || []).forEach(function(f) { self.onKeyFrameRequest(f.ssrc); });
        } else {
          self.onKeyFrameRequest(feedback.mediaSsrc);
        }
      } else if (fname === "GenericNack") {
        add(feedback.mediaSourceSsrc, "NACK");
      } else if (fname === "TransportWideCC") {
        add(feedback.mediaSourceSsrc, "TWCC");
      }
    } catch (_e) { /* diagnostics only */ }
    return route.apply(this, arguments);
  };
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
  if (this.pump || this.closed || this.onFirstVideoFrame) return;
  if (this.soundtrackPending) {
    // The soundtrack is still being decoded; start with it.
    this.startAudioWhenReady = true;
    return;
  }

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
      if (!self.canSendRtp()) return;
      self.sentPackets = (self.sentPackets || 0) + 1;
      if (self.sentPackets === 1) {
        log.info("call", "Media: sending RTP (payload " + packet.header.payloadType + ", " + frame.length + " bytes/frame)");
      } else if (self.sentPackets % 500 === 0) {
        log.info("call", "Media: " + self.sentPackets + " RTP packets sent");
      }
      self.track.writeRtp(packet);
    }

    if (self.e2eeMedia) {
      // Frames are pipelined: the runner answers in request order, so audio
      // is not held behind a video keyframe's round trip.
      try {
        self.e2eeMedia.encrypt(payload, 0, function(err, errorCode, encrypted) {
          if (err) {
            log.verbose("call", "Media: could not encrypt a frame: " + err.message);
          } else if (errorCode !== 0 || !encrypted) {
            log.verbose("call", "Media: dropping a frame that could not be encrypted (error " + errorCode + ")");
          } else {
            write(encrypted);
          }
        });
      } catch (e) {
        log.warn("call", "Media: audio encryption threw: " + e.message);
      }
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

    // An Opus session that negotiated PCMU converts its 48 kHz source once,
    // not on every frame.
    if (!self.ulaw) self.ulaw = pcm16ToUlawBuffer(resamplePcm(self.sourcePcm, OPUS_RATE, SAMPLE_RATE));
    var ulaw = self.ulaw;
    var payload = Buffer.alloc(SAMPLES_PER_FRAME);
    for (var i = 0; i < SAMPLES_PER_FRAME; i++) {
      payload[i] = ulaw[self.offset % ulaw.length];
      self.offset += 1;
    }
    sendRtp(payload, SAMPLES_PER_FRAME);
  }

  // `mediaEpoch` is when position 0 of the file played; video restarts seek
  // relative to it so the picture stays on the audio's timeline.
  function startPump() {
    if (self.pump || self.closed) return;
    if (self.audioHoldTimer) clearTimeout(self.audioHoldTimer);
    self.audioHoldTimer = null;
    self.onFirstVideoFrame = null;
    self.mediaEpoch = Date.now();
    startFramePump(self, frame, FRAME_MS);
  }
  if (this.heldVideo) {
    // The encoders were prewarmed (prewarmVideo): send the held frames and
    // start the audio with them, or with the first frame if none came yet.
    var held = this.heldVideo;
    this.heldVideo = null;
    if (held.length) {
      startPump();
      held.forEach(function(entry) {
        var pending = entry.layer.accessUnit;
        entry.layer.accessUnit = entry.unit;
        self.flushAccessUnit(entry.layer);
        entry.layer.accessUnit = pending;
      });
    } else {
      this.onFirstVideoFrame = startPump;
      this.audioHoldTimer = setTimeout(startPump, 2000);
    }
    return;
  }
  if (this.videoTrack && this.options.videoFile && !this.videoStarted) {
    // ffmpeg needs ~0.4 s to produce its first frame, and audio started
    // right away ran that far ahead of the picture. Start the audio with the
    // first video frame (or after 2 s if no video comes out).
    this.onFirstVideoFrame = startPump;
    this.audioHoldTimer = setTimeout(startPump, 2000);
    this.startVideo();
    return;
  }
  startPump();
  this.startVideo();
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
  if (this.audioHoldTimer) clearTimeout(this.audioHoldTimer);
  this.audioHoldTimer = null;
  this.onFirstVideoFrame = null;
  this.heldVideo = null;
  this.stopVideo();
};

// ---------------------------------------------------------------------------
// Video (options.videoFile)
// ---------------------------------------------------------------------------

// Simulcast layers (mirroring the web client): each layer is encoded from the
// same file at its own resolution/frame rate and sent under its own SSRC; the
// conference picks a layer per receiver.
var DEFAULT_VIDEO_LAYERS = [
  { width: 320, fps: 30, bitrate: 300000 },
  { width: 640, fps: 30, bitrate: 700000 },
  { width: 1280, fps: 30, bitrate: 1500000 }
];

// The generic frame descriptor (WebRTC's early dependency descriptor). With
// end-to-end encryption the receiver cannot parse the frame payload, so it
// relies on this extension to find frame boundaries (which packet starts and
// ends a frame). Wire format from WebRTC's
// rtp_generic_frame_descriptor_extension.cc:
//   byte 0: |B|E|F|L|D| T T T|   B first packet, E last packet of the frame,
//                                F/L always set in v00, D dependencies, T layer
//   byte 1: spatial layer bitmask
//   bytes 2-3: frame id (little endian)
//   bytes 4-7: width / height (big endian), first packet only
var GENERIC_FRAME_DESCRIPTOR_URI =
  "http://www.webrtc.org/experiments/rtp-hdrext/generic-frame-descriptor-00";

// Video layers allocation (draft-ietf-avtext-lrr, WebRTC's
// rtp_video_layers_allocation_extension). The web and iOS clients use it to
// learn each stream's resolution/frame rate/bitrate before decoding; without
// it they never set up the picture (Android infers the size from the SPS).
var VIDEO_LAYERS_ALLOCATION_URI =
  "http://www.webrtc.org/experiments/rtp-hdrext/video-layers-allocation00";

function writeLeb128(value) {
  var bytes = [];
  do {
    var byte = value & 0x7f;
    value >>>= 7;
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);
  return bytes;
}

// Faithful port of RtpVideoLayersAllocationExtension::Write for a single
// active spatial layer (this stream's layer, spatial id 0, one temporal
// layer):
//   byte 0: rtp_stream_index << 6 | (max_index << 4) | spatial bitmask
//   (when the per-stream bitmasks differ, the bitmasks follow packed)
//   temporal layer counts (2 bits per layer)
//   target bitrate per temporal layer (LEB128, kbps)
//   width-1 (u16 BE), height-1 (u16 BE), frame rate (u8)
function buildVideoLayersAllocation(layer) {
  var index = layer.vlaIndex || 0;
  var bytes = [];
  if (index === 0) {
    bytes.push(0x01);
  } else {
    bytes.push((index << 6) | (index << 4));
    var masks = [0];
    for (var i = 1; i <= index; i++) masks.push(i === index ? 1 : 0);
    for (var m = 0; m < masks.length; m += 2) {
      bytes.push(((masks[m] || 0) << 4) | (masks[m + 1] || 0));
    }
  }
  bytes.push(0x00); // one temporal layer
  var kbps = Math.max(1, Math.round((layer.activeBitrate || layer.config.bitrate) / 1000));
  bytes = bytes.concat(writeLeb128(kbps));
  var width = Math.max(1, layer.width || 0);
  var height = Math.max(1, layer.height || 0);
  bytes.push((width - 1) >> 8 & 0xff, (width - 1) & 0xff,
    (height - 1) >> 8 & 0xff, (height - 1) & 0xff,
    layer.config.fps & 0xff);
  return Buffer.from(bytes);
}

// The source's size (resolution fields of the frame descriptor), duration
// (an encoder restart resumes at the current position instead of the start)
// and frame rate (RTP timestamps in stream-copy mode), from a single ffprobe.
function probeVideo(file) {
  var info = { width: 0, height: 0, fps: 0, durationMs: 0 };
  try {
    var out = JSON.parse(childProcess.execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height,r_frame_rate:format=duration", "-of", "json", file
    ], { encoding: "utf8" }));
    var stream = (out.streams || [])[0] || {};
    info.width = parseInt(stream.width, 10) || 0;
    info.height = parseInt(stream.height, 10) || 0;
    var rate = String(stream.r_frame_rate || "").split("/");
    var fps = parseInt(rate[0], 10) / (parseInt(rate[1], 10) || 1);
    if (fps > 0 && fps < 240) info.fps = fps;
    var seconds = parseFloat(out.format && out.format.duration);
    if (seconds > 0) info.durationMs = seconds * 1000;
  } catch (e) {
    log.verbose("call", "Media: could not probe the video: " + e.message);
  }
  return info;
}

// Starts the encoders while the media is still held (the peer just joined),
// so ffmpeg's ~0.4 s to the first frame overlaps the start delay instead of
// adding to it. Their frames are held until startAudio releases them.
MediaSession.prototype.prewarmVideo = function() {
  if (this.videoStarted || this.pump || this.closed || !this.videoTrack || !this.options.videoFile) return;
  this.heldVideo = [];
  this.startVideo();
};

// ffmpeg decodes and encodes the file to H.264 (Constrained Baseline) in a
// loop, writing Annex-B NAL units to stdout; the NAL units are packetized
// into RTP (RFC 6184, packetization-mode=1) and written to the video track.
MediaSession.prototype.startVideo = function() {
  if (this.videoStarted || this.closed || !this.videoTrack || !this.options.videoFile) return;
  this.videoStarted = true;
  this.videoStartedAt = Date.now();
  var self = this;
  this.videoLayers.forEach(function(layer) { self.startVideoLayer(layer); });
};

MediaSession.prototype.startVideoLayer = function(layer) {
  var self = this;
  if (layer.proc || this.closed) return;
  var config = layer.config;
  var proc;
  try {
    var args = ["-stream_loop", "-1", "-re"];
    // A restart (forced keyframe) resumes where the stream was; without a
    // seek the file would start over and the receiver would see it loop.
    if (layer.resumeOffsetMs) {
      args = args.concat(["-ss", (layer.resumeOffsetMs / 1000).toFixed(3)]);
    }
    var bitrate = layer.activeBitrate || config.bitrate;
    if (this.options.videoStreamCopy) {
      // The file was pre-encoded offline at exactly this resolution/bitrate
      // with a strong preset, so the live session only remuxes it: even frame
      // sizes (no encoder bursts stalling the TCP path) and no CPU cost.
      args = args.concat([
        "-i", this.options.videoFile,
        "-an",
        "-c:v", "copy",
        "-bsf:v", "h264_mp4toannexb",
        "-f", "h264", "-"
      ]);
    } else {
      args = args.concat([
        "-i", this.options.videoFile,
        "-an",
        "-vf", "scale=" + config.width + ":-2",
        "-r", String(config.fps),
        "-c:v", "libx264",
        // "ultrafast" is realtime with plenty of headroom and keeps the output
        // cadence steady; stronger presets compressed better but the picture
        // stuttered more on this (TCP-only) path.
        "-preset", this.options.videoPreset || "ultrafast",
        "-tune", "zerolatency",
        "-profile:v", "baseline", "-level", "3.1", "-pix_fmt", "yuv420p",
        "-g", String(config.fps), "-keyint_min", "1",
        // One slice per frame: zerolatency turns on sliced threads, whose
        // multi-slice frames strict receivers (web, iOS) handle worst.
        "-x264-params", "repeat_headers=1:sliced-threads=0",
        "-b:v", String(bitrate),
        "-f", "h264", "-"
      ]);
    }
    proc = childProcess.spawn("ffmpeg", args);
  } catch (e) {
    log.warn("call", "Media: could not start ffmpeg for a video layer: " + e.message);
    return;
  }
  layer.proc = proc;
  layer.buffer = Buffer.alloc(0);
  layer.accessUnit = [];
  // Startup time to the first frame is measured (see flushAccessUnit) so a
  // restart can seek ahead by it.
  layer.spawnedAt = Date.now();
  layer.firstFrameSeen = false;

  proc.stdout.on("data", function(chunk) {
    self.pushH264Chunk(layer, chunk);
  });
  // Only the tail of ffmpeg's output is kept, for the warnings below.
  var stderrTail = "";
  proc.stderr.on("data", function(chunk) {
    stderrTail = (stderrTail + chunk).slice(-600);
  });
  proc.on("error", function(err) {
    log.warn("call", "Media: ffmpeg video layer failed: " + err.message);
    if (layer.proc === proc) layer.proc = null;
  });
  // An encoder that exits on its own, or never produces a frame, would leave
  // the video stopped for the rest of the call (a restarted ffmpeg once went
  // silent and the receiver got no more frames), so it is restarted.
  function recover(reason) {
    if (layer.proc !== proc || self.closed) return;
    layer.encoderRecoveries = (layer.encoderRecoveries || 0) + 1;
    if (layer.encoderRecoveries > 5) {
      log.warn("call", "Media: video" + config.width + " encoder " + reason + "; giving up after 5 restarts");
      layer.proc = null;
      return;
    }
    log.warn("call", "Media: video" + config.width + " encoder " + reason +
      "; restarting it. ffmpeg: " + stderrTail.trim().split(/\r?\n/).slice(-3).join(" | "));
    self.restartVideoLayer(layer);
  }
  var watchdog = setTimeout(function() {
    if (!layer.firstFrameSeen) recover("produced no frame in 4 s");
  }, 4000);
  if (watchdog.unref) watchdog.unref();
  proc.on("close", function(code) {
    clearTimeout(watchdog);
    if (layer.proc !== proc || self.closed) return;
    recover("exited (code " + code + ")");
  });
  log.info("call", "Media: sending video layer " + config.width + "px@" + config.fps +
    " (" + config.bitrate + " bps, ssrc " + layer.ssrc + ")");
};

MediaSession.prototype.stopVideo = function() {
  if (this.bitrateTimer) {
    clearInterval(this.bitrateTimer);
    this.bitrateTimer = null;
  }
  if (this.pacerTimer) {
    clearInterval(this.pacerTimer);
    this.pacerTimer = null;
  }
  this.pacerQueue = [];
  (this.videoLayers || []).forEach(function(layer) {
    this.stopVideoLayer(layer);
  }, this);
};

MediaSession.prototype.stopVideoLayer = function(layer) {
  if (layer.proc) {
    try { layer.proc.kill(); } catch (e) { /* already gone */ }
    layer.proc = null;
  }
};

// The receiver asks for a keyframe (PLI/FIR) whenever it loses or cannot
// decode a frame. Without one the picture freezes until the next scheduled
// IDR, which is what made the video stutter. Restarting the layer's encoder
// produces SPS/PPS + IDR immediately; requests are rate limited.
MediaSession.prototype.onKeyFrameRequest = function(ssrc) {
  var layer = (this.videoLayers || []).filter(function(l) { return l.ssrc === ssrc; })[0];
  if (!layer || !layer.proc || this.closed) return;
  var now = Date.now();
  // Measured behaviour on the TCP-only path: a fresh keyframe within a few
  // seconds of the receiver asking is what re-syncs it (waiting for the next
  // scheduled IDR alone left it black for long stretches), so restarts are
  // allowed every five seconds.
  if (layer.lastKeyframeAt && now - layer.lastKeyframeAt < 5000) return;
  // A restart costs a 0.4-2 s gap in the video, and a live-encoded layer
  // sends a keyframe every second anyway: skip the restart when the next
  // scheduled one is due within 1.5 s (an overdue one means the encoder
  // stalled, which a restart does fix). In group calls every receiver's
  // requests reach us, so this is what keeps the encoders from cycling.
  if (layer.lastIdrAt && layer.idrIntervalMs) {
    var dueIn = layer.lastIdrAt + layer.idrIntervalMs - now;
    if (dueIn > -500 && dueIn < 1500) return;
  }
  layer.lastKeyframeAt = now;
  log.info("call", "Media: keyframe requested for video" + layer.config.width +
    "; restarting the encoder");
  this.restartVideoLayer(layer, now);
};

// Restarts a layer's encoder at the position the stream reached, keeping the
// file from looping back to the start. The seek lands where the audio will be
// when the new encoder's first frame comes out (its measured startup time
// later), so the picture doesn't fall behind the sound.
MediaSession.prototype.restartVideoLayer = function(layer, now) {
  now = now || Date.now();
  if (this.videoDurationMs && this.mediaEpoch != null) {
    layer.resumeOffsetMs = (now - this.mediaEpoch + (layer.startupMs || 400)) % this.videoDurationMs;
  }
  this.stopVideoLayer(layer);
  this.startVideoLayer(layer);
};

// The SFU's REMB estimate is the bandwidth the path can take. Keep the video
// inside it by scaling the layers' bitrates, restarting an encoder only when
// its target moved by more than 20%.
MediaSession.prototype.scheduleBitrateAdaptation = function() {
  if (this.bitrateTimer || this.closed) return;
  var self = this;
  this.bitrateTimer = setInterval(function() {
    self.adaptVideoBitrate();
  }, 3000);
  if (this.bitrateTimer.unref) this.bitrateTimer.unref();
};

MediaSession.prototype.adaptVideoBitrate = function() {
  if (this.closed || !this.videoLayers || !this.videoLayers.length) return;
  // A stream-copied file's bitrate can't change; a restart would only add a
  // gap in the video.
  if (this.options.videoStreamCopy) return;
  var now = Date.now();
  if (!this.rembBps || !this.lastRembAt || now - this.lastRembAt > 10000) return;
  var estimates = Object.keys(this.rembBps).map(function(ssrc) { return this.rembBps[ssrc]; }, this);
  if (!estimates.length) return;
  var budget = Math.min.apply(null, estimates) - 40000; // audio keeps its share
  if (!(budget > 0)) return;
  var nominal = this.videoLayers.reduce(function(sum, layer) {
    return sum + (layer.config.bitrate || 0);
  }, 0);
  var scale = Math.max(0.25, Math.min(1, budget / nominal));
  var self = this;
  this.videoLayers.forEach(function(layer) {
    var target = Math.max(120000, Math.round(layer.config.bitrate * scale));
    var current = layer.activeBitrate || layer.config.bitrate;
    if (Math.abs(target - current) / current < 0.2) {
      layer.pendingDirection = 0;
      return;
    }
    // Every change restarts the encoder (a 0.4-2 s gap in the video), and the
    // estimate swings while it ramps up at the start of a call (seen: 250 ->
    // 460 -> 610 -> 700 kbps in 10 s). A change is only applied when two
    // checks in a row (3 s apart) agree on its direction, and the bitrate is
    // not raised during the first 10 s of video.
    var direction = target > current ? 1 : -1;
    if (direction > 0 && self.videoStartedAt && now - self.videoStartedAt < 10000) return;
    if (layer.pendingDirection !== direction) {
      layer.pendingDirection = direction;
      return;
    }
    layer.pendingDirection = 0;
    layer.activeBitrate = target;
    log.info("call", "Media: adapting video" + layer.config.width + " to " +
      Math.round(target / 1000) + " kbps (REMB " + Math.round(budget / 1000) + " kbps)");
    if (layer.proc) self.restartVideoLayer(layer, now);
  });
};

// Splits the Annex-B byte stream into NAL units; the trailing (possibly
// incomplete) NAL stays buffered until its end is seen.
MediaSession.prototype.pushH264Chunk = function(layer, chunk) {
  layer.buffer = layer.buffer.length ? Buffer.concat([layer.buffer, chunk]) : chunk;
  var buf = layer.buffer;
  var lastStart = 0;
  var i = 0;
  while (i + 3 < buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 &&
      (buf[i + 2] === 1 || (buf[i + 2] === 0 && buf[i + 3] === 1))) {
      if (i > lastStart) this.onH264Nal(layer, buf.subarray(lastStart, i));
      i += buf[i + 2] === 1 ? 3 : 4;
      lastStart = i;
    } else {
      i++;
    }
  }
  layer.buffer = Buffer.from(buf.subarray(lastStart));
};

// Access unit (frame) boundaries per H.264 section 7.4.1.2.3. Once the
// current unit has a slice, the next frame starts at an AUD (9), SPS (7),
// PPS (8), SEI (6) or NAL types 14-18, or at a slice whose first_mb_in_slice
// is 0 (ue(v) 0 is the single bit 1, so the first bit after the NAL header is
// set). A live x264 encode emits several slices per frame; treating each one
// as a frame gave every slice its own timestamp, marker bit, frame descriptor
// and E2EE frame, and pushed the next frame's SPS/PPS/SEI onto the previous
// one. Android tolerated that; the web and iOS decoders stayed black.
function startsAccessUnit(nal) {
  var type = nal[0] & 0x1f;
  if (type === 1 || type === 5) return nal.length > 1 && (nal[1] & 0x80) !== 0;
  return type === 6 || type === 7 || type === 8 || type === 9 || (type >= 14 && type <= 18);
}

MediaSession.prototype.onH264Nal = function(layer, nal) {
  if (!nal.length) return;
  if (!layer.accessUnit) layer.accessUnit = [];
  if (startsAccessUnit(nal)) {
    var hasVcl = layer.accessUnit.some(function(n) {
      var t = n[0] & 0x1f;
      return t === 1 || t === 5;
    });
    if (hasVcl) this.flushAccessUnit(layer);
  }
  layer.accessUnit.push(Buffer.from(nal));
};

// RFC 6184 packetization: small NAL units go in a single packet, larger ones
// are fragmented (FU-A). The marker bit is set on the last packet of the frame.
MediaSession.prototype.flushAccessUnit = function(layer) {
  var unit = layer.accessUnit;
  layer.accessUnit = [];
  if (!unit || !unit.length || this.closed || !this.videoTrack) return;
  var self = this;
  if (!layer.firstFrameSeen) {
    layer.firstFrameSeen = true;
    layer.encoderRecoveries = 0;
    var startup = Date.now() - layer.spawnedAt;
    layer.startupMs = layer.startupMs ? Math.round((layer.startupMs + startup) / 2) : startup;
    log.verbose("call", "Media: video" + layer.config.width + " first frame after " + startup + " ms");
    if (this.onFirstVideoFrame) this.onFirstVideoFrame();
  }
  if (this.heldVideo) {
    // Prewarmed and not released yet: keep only the frames since the latest
    // keyframe, so the first frame sent can be decoded.
    var heldKeyframe = unit.some(function(nal) { return (nal[0] & 0x1f) === 5; });
    if (heldKeyframe) {
      this.heldVideo = this.heldVideo.filter(function(entry) { return entry.layer !== layer; });
    }
    if (heldKeyframe || this.heldVideo.some(function(entry) { return entry.layer === layer; })) {
      this.heldVideo.push({ layer: layer, unit: unit });
    }
    return;
  }
  // When keyframes go out, and how far apart, decides whether a keyframe
  // request needs an encoder restart (see onKeyFrameRequest).
  if (unit.some(function(nal) { return (nal[0] & 0x1f) === 5; })) {
    var sentAt = Date.now();
    if (layer.lastIdrAt && sentAt - layer.lastIdrAt > 200) layer.idrIntervalMs = sentAt - layer.lastIdrAt;
    layer.lastIdrAt = sentAt;
  }
  var timestamp = layer.timestamp;
  var step = Math.max(1, Math.round(90000 / layer.config.fps));
  layer.timestamp = (layer.timestamp + step) >>> 0;

  if (this.e2eeMedia) {
    // After a dropped frame the layer's following frames can't be decoded,
    // so skip them until the next keyframe instead of sending a broken
    // picture (which makes the receiver ask for keyframes).
    if (layer.awaitKeyframe) {
      var isKeyframe = unit.some(function(nal) { return (nal[0] & 0x1f) === 5; });
      if (!isKeyframe) return;
      layer.awaitKeyframe = false;
    }
    // E2EE video encrypts the whole encoded frame in one call (the wasm's
    // H264 frame data handler keeps the NAL headers clear and escapes the
    // encrypted bodies, exactly like the web client's encoded transform);
    // the resulting frame is then packetized like any Annex-B frame. All
    // layers share the frame counter, exactly like the web client (one
    // encryptor per track).
    var frame = Buffer.concat(unit.map(function(nal) {
      return Buffer.concat([Buffer.from([0, 0, 0, 1]), nal]);
    }));
    var handler = this.options.videoEncryptionHandler != null
      ? this.options.videoEncryptionHandler
      : 3;
    try {
      self.e2eeMedia.encrypt(frame, handler, "video", function(err, errorCode, encrypted) {
        if (err || errorCode !== 0 || !encrypted) {
          log.verbose("call", "Media: dropping a video frame that could not be encrypted (" +
            (err ? err.message : "error " + errorCode) + ")");
          layer.awaitKeyframe = true;
          return;
        }
        if (!self.encryptedVideoLogged) {
          self.encryptedVideoLogged = true;
          log.verbose("call", "Media: E2EE video frame " + frame.length + " -> " +
            encrypted.length + " bytes, head " +
            Buffer.from(encrypted.subarray(0, 24)).toString("hex") +
            " (plain head " + Buffer.from(frame.subarray(0, 24)).toString("hex") + "), tail " +
            Buffer.from(encrypted.subarray(-8)).toString("hex"));
        }
        self.packetizeNalUnits(layer, self.splitAnnexB(encrypted), timestamp);
      });
    } catch (e) {
      log.warn("call", "Media: video encryption threw: " + e.message);
    }
    return;
  }

  this.packetizeNalUnits(layer, unit, timestamp);
};

// Splits an Annex-B buffer into NAL units (start codes stripped).
MediaSession.prototype.splitAnnexB = function(buf) {
  var nals = [];
  var lastStart = -1;
  var i = 0;
  while (i + 3 <= buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 &&
      (buf[i + 2] === 1 || (i + 3 < buf.length && buf[i + 2] === 0 && buf[i + 3] === 1))) {
      if (lastStart >= 0 && i > lastStart) nals.push(buf.subarray(lastStart, i));
      i += buf[i + 2] === 1 ? 3 : 4;
      lastStart = i;
    } else {
      i++;
    }
  }
  if (lastStart >= 0 && lastStart < buf.length) nals.push(buf.subarray(lastStart));
  return nals;
};

// A negotiated RTP header extension's id, or null when the conference did not
// accept it (then it is never written into a packet).
MediaSession.prototype.negotiatedExtensionId = function(uri) {
  this.extensionIds = this.extensionIds || {};
  if (this.extensionIds[uri] !== undefined) return this.extensionIds[uri];
  var id = null;
  try {
    if (!this.videoSender) {
      this.videoSender = (this.pc.getSenders ? this.pc.getSenders() : []).filter(function(s) {
        return s.track && s.track.kind === "video";
      })[0];
    }
    var sender = this.videoSender;
    if (sender && sender.headerExtensions) {
      var found = sender.headerExtensions.filter(function(ext) {
        return ext.uri === uri;
      })[0];
      if (found) id = found.id;
    }
    if (id == null) {
      var remote = this.pc.remoteDescription && this.pc.remoteDescription.sdp;
      if (remote) {
        var match = new RegExp("a=extmap:(\\d+) " +
          uri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).exec(remote);
        if (match) id = parseInt(match[1], 10);
      }
    }
  } catch (e) {
    id = null;
  }
  if (id != null) {
    log.verbose("call", "Media: " + uri.split("/").pop() + " negotiated with id " + id);
  }
  this.extensionIds[uri] = id;
  return id;
};

// The negotiated id of the generic frame descriptor extension, or null when
// the conference did not accept it (then no descriptor is written at all).
MediaSession.prototype.frameDescriptorId = function() {
  return this.negotiatedExtensionId(GENERIC_FRAME_DESCRIPTOR_URI);
};

MediaSession.prototype.videoLayersAllocationId = function() {
  return this.negotiatedExtensionId(VIDEO_LAYERS_ALLOCATION_URI);
};

// One descriptor per packet: the first packet of the frame carries the full
// descriptor (frame id, spatial layer, resolution), the rest only the flags.
function buildFrameDescriptor(layer, frameId, first, last) {
  var base = 0x30 | (first ? 0x80 : 0) | (last ? 0x40 : 0);
  if (!first) return Buffer.from([base]);
  var bytes = [base, layer.spatialBit || 1, frameId & 0xff, (frameId >> 8) & 0xff];
  if (layer.width > 0 && layer.height > 0) {
    bytes.push((layer.width >> 8) & 0xff, layer.width & 0xff,
      (layer.height >> 8) & 0xff, layer.height & 0xff);
  }
  return Buffer.from(bytes);
}

MediaSession.prototype.packetizeNalUnits = function(layer, nals, timestamp) {
  var self = this;
  // RTP fragment size. Facebook's network is reached over TCP here (UDP is
  // blocked on this path), and tunnels/VPNs lower the usable MTU, so the
  // fragments are kept well below the usual 1200 bytes to avoid IP
  // fragmentation on the way to the SFU.
  var MAX_PAYLOAD = this.options.maxRtpPayload || 1000;
  var packets = [];
  nals.forEach(function(nal) {
    if (!nal.length) return;
    if (nal.length <= MAX_PAYLOAD) {
      packets.push(nal);
      return;
    }
    var nri = nal[0] & 0x60;
    var type = nal[0] & 0x1f;
    var indicator = 0x1c | nri;
    var offset = 1;
    while (offset < nal.length) {
      var end = Math.min(nal.length, offset + MAX_PAYLOAD - 2);
      var start = offset === 1;
      var last = end >= nal.length;
      packets.push(Buffer.concat([
        Buffer.from([indicator, (start ? 0x80 : 0) | (last ? 0x40 : 0) | type]),
        nal.subarray(offset, end)
      ]));
      offset = end;
    }
  });
  var gfdId = this.frameDescriptorId();
  var vlaId = this.videoLayersAllocationId();
  var frameId = layer.frameId = ((layer.frameId || 0) + 1) & 0xffff;
  packets.forEach(function(payload, index) {
    var header = {
      version: 2,
      payloadType: 97,
      sequenceNumber: layer.sequenceNumber,
      timestamp: timestamp,
      ssrc: layer.ssrc,
      marker: index === packets.length - 1
    };
    var extensions = [];
    if (gfdId != null) {
      extensions.push({
        id: gfdId,
        payload: buildFrameDescriptor(layer, frameId, index === 0, index === packets.length - 1)
      });
    }
    if (vlaId != null && index === 0) {
      // Like the web client: the allocation rides on the first packet of each
      // frame.
      extensions.push({ id: vlaId, payload: buildVideoLayersAllocation(layer) });
    }
    if (extensions.length) header.extensions = extensions;
    layer.sequenceNumber = (layer.sequenceNumber + 1) & 0xffff;
    self.writeVideoPacket(header, payload);
  });
};

// A simple token-bucket pacer for the video stream, like a streaming
// player's steady read: packets are queued and released at roughly the
// stream's bitrate (with a small burst allowance) instead of dumping a whole
// frame back to back. Bursts fill TCP windows and relay queues, which is what
// made the picture freeze and then skip.
var PACER_TICK_MS = 10;
var PACER_BURST_MS = 40;
var PACER_MAX_QUEUE = 400;

MediaSession.prototype.videoTargetBitrate = function() {
  return (this.videoLayers || []).reduce(function(sum, layer) {
    return sum + (layer.activeBitrate || layer.config.bitrate || 0);
  }, 0);
};

MediaSession.prototype.startPacer = function() {
  if (this.pacerTimer || this.closed) return;
  var self = this;
  var last = Date.now();
  this.pacerTokens = 0;
  this.pacerTimer = setInterval(function() {
    if (self.closed || !self.videoTrack) {
      clearInterval(self.pacerTimer);
      self.pacerTimer = null;
      return;
    }
    var now = Date.now();
    var elapsed = Math.min(now - last, 100);
    last = now;
    // Release at twice the stream's rate so keyframes are not held back; the
    // bucket still spreads a frame's burst over a few ticks.
    var rate = self.videoTargetBitrate() * 2;
    if (rate > 0) {
      self.pacerTokens = Math.min(
        self.pacerTokens + rate / 8 * (elapsed / 1000),
        rate / 8 * (PACER_BURST_MS / 1000));
    }
    while (self.pacerQueue.length) {
      var item = self.pacerQueue[0];
      var size = item.payload.length + 24;
      if (self.pacerTokens < size && self.pacerQueue.length < PACER_MAX_QUEUE) break;
      self.pacerQueue.shift();
      self.pacerTokens = Math.max(0, self.pacerTokens - size);
      self.sendVideoPacketNow(item.header, item.payload);
    }
  }, PACER_TICK_MS);
  if (this.pacerTimer.unref) this.pacerTimer.unref();
};

MediaSession.prototype.writeVideoPacket = function(header, payload) {
  // Off by default: pacing at the stream's bitrate held keyframes back and
  // made the picture worse on this path. Enable with media.paceVideo.
  if (!this.options.paceVideo) return this.sendVideoPacketNow(header, payload);
  this.pacerQueue = this.pacerQueue || [];
  // Drop the oldest packets when the queue runs away (the receiver recovers
  // through a keyframe); keeping the newest keeps latency low.
  while (this.pacerQueue.length >= PACER_MAX_QUEUE) this.pacerQueue.shift();
  this.pacerQueue.push({ header: header, payload: payload });
  this.startPacer();
};

MediaSession.prototype.sendVideoPacketNow = function(header, payload) {
  var self = this;
  var werift = loadWerift();
  if (!this.canSendRtp()) return;
  this.videoPackets = (this.videoPackets || 0) + 1;
  if (this.videoPackets === 1) {
    log.info("call", "Media: sending video RTP (payload " + header.payloadType + ")");
  } else if (this.videoPackets % 1000 === 0) {
    log.info("call", "Media: " + this.videoPackets + " video RTP packets sent");
  }
  if (!this.videoSender) {
    this.videoSender = (this.pc.getSenders ? this.pc.getSenders() : []).filter(function(s) {
      return s.track && s.track.kind === "video";
    })[0];
  }
  // werift rewrites each packet's SSRC to the sender's; point it at the layer's
  // SSRC right before handing the packet over.
  if (this.videoSender) this.videoSender.ssrc = header.ssrc;
  var packet = new werift.RtpPacket(new werift.RtpHeader(header), payload);
  this.videoTrack.writeRtp(packet);
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

// Video m-line tweaks werift can't be configured to make: the fmtp advertises
// SPS/PPS on keyframes, and werift's single sender SSRC is replaced by our
// simulcast layers. (Header extensions and feedback are negotiated by werift
// itself; see videoHeaderExtensions.)
function withVideoRtpExtensions(sdp, session) {
  if (!sdp || sdp.indexOf("m=video") < 0) return sdp;
  var lines = sdp.split(/\r?\n/);
  var out = [];
  var inVideo = false;
  var ssrcWritten = false;
  lines.forEach(function(line) {
    if (/^m=/.test(line)) inVideo = /^m=video/.test(line);
    if (/^a=fmtp:/.test(line) && /h264|packetization-mode/i.test(line) &&
      line.indexOf("sps-pps-idr-in-keyframe") < 0) {
      line += ";sps-pps-idr-in-keyframe=1";
    }
    out.push(line);
    // The conference composes the receiver-side msid as
    // `<sender>:<cname>:<stream id from our SDP>`; browsers send the stream id
    // "DEFAULT", and the web/iOS clients only attach a received video stream
    // to the participant (instead of showing an avatar) when that matches.
    if (inVideo && /^a=msid:/.test(line)) {
      var msid = line.slice("a=msid:".length).split(/\s+/);
      if (msid.length >= 2 && msid[0] !== "DEFAULT" && msid[0] !== "-") {
        out.pop();
        out.push("a=msid:DEFAULT " + msid[1]);
      }
    }
    // Replace werift's single sender SSRC with our simulcast layers (one
    // SSRC per encoding + the SIM group), exactly like the web client. A
    // one-member SIM group is invalid SDP, so it is only added for real
    // simulcast (two or more layers).
    if (inVideo && !ssrcWritten) {
      var weriftSsrc = /^a=ssrc:(\d+)\s+cname:(\S+)/.exec(line);
      if (weriftSsrc) {
        var layerSsrcs = (session && session.videoLayers ? session.videoLayers : [])
          .map(function(layer) { return layer.ssrc; });
        if (layerSsrcs.length) {
          out.pop();
          layerSsrcs.forEach(function(ssrc) {
            out.push("a=ssrc:" + ssrc + " cname:" + weriftSsrc[2]);
          });
          if (layerSsrcs.length > 1) {
            out.push("a=ssrc-group:SIM " + layerSsrcs.join(" "));
          }
          ssrcWritten = true;
        }
      }
    }
  });
  return out.join("\r\n");
}

// werift gives every description a new random session id and version 0, so a
// renegotiation offer looked like an unrelated session and the server never
// answered it. Like browsers, keep the first session id and bump the version
// with every description sent (RFC 3264 section 8); the renegotiation message
// carries that version too (see sdpVersion).
MediaSession.prototype.stampOrigin = function(sdp) {
  var self = this;
  return String(sdp || "").replace(/^o=(\S+)\s+(\d+)\s+(\d+)(\s)/m, function(all, user, id, version, sep) {
    if (!self.sdpSessionId) self.sdpSessionId = id;
    self.sdpVersion = (self.sdpVersion || 0) + 1;
    return "o=" + user + " " + self.sdpSessionId + " " + self.sdpVersion + sep;
  });
};

MediaSession.prototype.createOffer = function(callback) {
  var self = this;
  this.pc.createOffer()
    .then(function(offer) {
      return self.pc.setLocalDescription(offer);
    })
    .then(function() {
      self.waitForGathering(function() {
        var sdp = self.stampOrigin(self.pc.localDescription ? self.pc.localDescription.sdp : "");
        if (self.options.videoFile) sdp = withVideoRtpExtensions(sdp, self);
        if (self.options.videoFile) {
          var sim = /a=ssrc-group:SIM ([^\r\n]+)/.exec(sdp);
          log.verbose("call", "Media: offer video simulcast " + (sim ? sim[1] : "(none)"));
        }
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
          var sdp = self.stampOrigin(self.pc.localDescription ? self.pc.localDescription.sdp : "");
          // Answers to the SFU's renegotiation re-announce our tracks: keep
          // the same stream id and simulcast SSRCs as the offer.
          if (self.options.videoFile) sdp = withVideoRtpExtensions(sdp, self);
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
  // Video is only implemented on the werift engine (@roamhq/wrtc has no video
  // pipeline), and group calls are exactly the video calls the libwebrtc
  // binding cannot serve; a call asked to send video therefore uses werift
  // even though the libwebrtc binding is otherwise preferred.
  var wantsVideo = !!(options.videoFile || options.video || options.wantsVideo) && options.engine !== "wrtc";
  if (!wantsVideo && options.engine !== "werift") {
    var wrtcEngine = null;
    try {
      wrtcEngine = require("./mediaWrtc");
    } catch (e) {
      // mediaWrtc is optional
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
  preloadEngines: preloadEngines,
  iceServersFromRelayInfo: iceServersFromRelayInfo,
  // Exported for the unit tests: the generic frame descriptor writer.
  buildFrameDescriptor: buildFrameDescriptor,
  GENERIC_FRAME_DESCRIPTOR_URI: GENERIC_FRAME_DESCRIPTOR_URI,
  // Exported for the unit tests: the video layers allocation writer.
  buildVideoLayersAllocation: buildVideoLayersAllocation,
  VIDEO_LAYERS_ALLOCATION_URI: VIDEO_LAYERS_ALLOCATION_URI,
  // Exported for the unit tests: DTLS failure recovery.
  MediaSession: MediaSession,
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
