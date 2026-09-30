"use strict";

// Every encoder restart leaves a 0.4-2 s gap in the video. Keyframe requests
// don't restart a layer whose next scheduled keyframe is close (a live layer
// sends one every second; in group calls every receiver's requests reach
// us), and bitrate changes wait for two agreeing estimates and aren't raised
// during the first 10 s of video.

var assert = require("assert");
var media = require("../../src/rtc/media.js");

function session(layer) {
  var s = Object.create(media.MediaSession.prototype);
  s.videoLayers = [layer];
  s.options = {};
  s.restarts = 0;
  s.restartVideoLayer = function() { s.restarts++; };
  return s;
}

function liveLayer() {
  return { ssrc: 1, proc: {}, config: { width: 640, fps: 24, bitrate: 700000 } };
}

describe("src/rtc/media encoder restarts", function() {
  it("skips the restart when the next keyframe is due soon", function() {
    var layer = liveLayer();
    layer.lastIdrAt = Date.now() - 300;
    layer.idrIntervalMs = 1000;
    var s = session(layer);
    s.onKeyFrameRequest(1);
    assert.strictEqual(s.restarts, 0);
  });

  it("restarts a layer whose keyframe is overdue", function() {
    var layer = liveLayer();
    layer.lastIdrAt = Date.now() - 3000;
    layer.idrIntervalMs = 1000;
    var s = session(layer);
    s.onKeyFrameRequest(1);
    assert.strictEqual(s.restarts, 1);
  });

  it("restarts a layer with long keyframe gaps (stream copy)", function() {
    var layer = liveLayer();
    layer.lastIdrAt = Date.now() - 500;
    layer.idrIntervalMs = 10000;
    var s = session(layer);
    s.onKeyFrameRequest(1);
    assert.strictEqual(s.restarts, 1);
  });

  it("lowers the bitrate only after two agreeing estimates", function() {
    var layer = liveLayer();
    var s = session(layer);
    s.videoStartedAt = Date.now() - 60000;
    s.lastRembAt = Date.now();
    s.rembBps = { 1: 340000 };
    s.adaptVideoBitrate();
    assert.strictEqual(s.restarts, 0);
    assert.strictEqual(layer.activeBitrate, undefined);
    s.adaptVideoBitrate();
    assert.strictEqual(s.restarts, 1);
    assert.strictEqual(layer.activeBitrate, 300000);
  });

  it("resets a pending change when the estimate recovers", function() {
    var layer = liveLayer();
    var s = session(layer);
    s.videoStartedAt = Date.now() - 60000;
    s.lastRembAt = Date.now();
    s.rembBps = { 1: 340000 };
    s.adaptVideoBitrate();
    s.rembBps = { 1: 900000 };
    s.adaptVideoBitrate();
    s.rembBps = { 1: 340000 };
    s.adaptVideoBitrate();
    assert.strictEqual(s.restarts, 0);
  });

  it("doesn't raise the bitrate during the first 10 s of video", function() {
    var layer = liveLayer();
    layer.activeBitrate = 300000;
    var s = session(layer);
    s.videoStartedAt = Date.now() - 2000;
    s.lastRembAt = Date.now();
    s.rembBps = { 1: 2500000 };
    s.adaptVideoBitrate();
    s.adaptVideoBitrate();
    assert.strictEqual(s.restarts, 0);
    s.videoStartedAt = Date.now() - 20000;
    s.adaptVideoBitrate();
    s.adaptVideoBitrate();
    assert.strictEqual(s.restarts, 1);
    assert.strictEqual(layer.activeBitrate, 700000);
  });
});
