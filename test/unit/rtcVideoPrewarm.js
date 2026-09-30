"use strict";

// The video encoders are started as soon as the peer joins, while the media is
// still held for `audioDelayMs`, so ffmpeg's startup doesn't add to the delay.
// Their frames are held until the media is released; only the frames since
// the latest keyframe are kept, so the first frame sent can be decoded.

var assert = require("assert");
var media = require("../../src/rtc/media.js");

var IDR = Buffer.from([0x65, 0x88]);
var P = Buffer.from([0x41, 0x9a]);

function session() {
  var s = Object.create(media.MediaSession.prototype);
  s.videoTrack = {};
  s.heldVideo = [];
  return s;
}

function layer(width) {
  return { config: { width: width, fps: 24 }, firstFrameSeen: true, timestamp: 0, accessUnit: [] };
}

function flush(s, l, nal) {
  l.accessUnit = [nal];
  s.flushAccessUnit(l);
}

describe("src/rtc/media video prewarm", function() {
  it("holds nothing until a keyframe comes out", function() {
    var s = session();
    var l = layer(640);
    flush(s, l, P);
    assert.strictEqual(s.heldVideo.length, 0);
  });

  it("keeps the frames since the latest keyframe", function() {
    var s = session();
    var l = layer(640);
    flush(s, l, IDR);
    flush(s, l, P);
    flush(s, l, P);
    assert.strictEqual(s.heldVideo.length, 3);
    flush(s, l, IDR);
    assert.strictEqual(s.heldVideo.length, 1);
    assert.strictEqual(s.heldVideo[0].unit[0], IDR);
    assert.strictEqual(l.timestamp, 0, "held frames get their timestamps when they are sent");
  });

  it("keeps each layer's frames separately", function() {
    var s = session();
    var low = layer(320);
    var high = layer(640);
    flush(s, low, IDR);
    flush(s, high, IDR);
    flush(s, low, IDR);
    assert.deepStrictEqual(s.heldVideo.map(function(e) { return e.layer.config.width; }), [640, 320]);
  });
});

describe("src/rtc/media soundtrack decoding", function() {
  it("starts the media only once the soundtrack is decoded", function() {
    var s = Object.create(media.MediaSession.prototype);
    s.soundtrackPending = true;
    s.startAudio();
    assert.strictEqual(s.startAudioWhenReady, true);
    assert.ok(!s.pump, "nothing is played before the soundtrack is ready");
  });
});
