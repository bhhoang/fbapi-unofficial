"use strict";

// Offline tests for the generic frame descriptor (WebRTC's early dependency
// descriptor). End-to-end encrypted video keeps the payload opaque, so the
// receiver finds frame boundaries only through this RTP header extension; the
// video stayed a black tile until the sender wrote it.
//
// Wire format (modules/rtp_rtcp/source/rtp_generic_frame_descriptor_extension.cc):
//   byte 0:  |B|E|F|L|D| T T T|   B first packet, E last packet of the frame,
//                                  F/L always set in v00, T temporal layer
//   byte 1:  spatial layer bitmask (first packet only)
//   bytes 2-3: frame id, little endian (first packet only)
//   bytes 4-7: width/height, big endian (first packet only)

var assert = require("assert");
var media = require("../../src/rtc/media");

var layer = { spatialBit: 0x02, width: 640, height: 360 };

describe("src/rtc/media frame descriptor", function() {
  it("advertises the generic frame descriptor URI", function() {
    assert.strictEqual(media.GENERIC_FRAME_DESCRIPTOR_URI,
      "http://www.webrtc.org/experiments/rtp-hdrext/generic-frame-descriptor-00");
  });

  it("writes the full descriptor on the first packet of a frame", function() {
    var d = media.buildFrameDescriptor(layer, 0x1234, true, false);
    // B|F|L set, D clear, temporal layer 0.
    assert.strictEqual(d[0], 0xb0);
    assert.strictEqual(d[1], 0x02);
    assert.strictEqual(d[2], 0x34); // frame id low byte first
    assert.strictEqual(d[3], 0x12);
    assert.strictEqual(d.readUInt16BE(4), 640);
    assert.strictEqual(d.readUInt16BE(6), 360);
  });

  it("marks a single-packet frame as both first and last", function() {
    var d = media.buildFrameDescriptor(layer, 7, true, true);
    assert.strictEqual(d[0], 0xf0);
    assert.strictEqual(d.length, 8);
  });

  it("writes only the flags on the remaining packets", function() {
    assert.deepStrictEqual(media.buildFrameDescriptor(layer, 9, false, false), Buffer.from([0x30]));
    assert.deepStrictEqual(media.buildFrameDescriptor(layer, 9, false, true), Buffer.from([0x70]));
  });

  it("omits the resolution when it is unknown", function() {
    var d = media.buildFrameDescriptor({ spatialBit: 0x01 }, 5, true, true);
    assert.strictEqual(d.length, 4);
    assert.strictEqual(d[0], 0xf0);
    assert.strictEqual(d[1], 0x01);
  });
});

describe("src/rtc/media video layers allocation", function() {
  it("advertises the video layers allocation URI", function() {
    assert.strictEqual(media.VIDEO_LAYERS_ALLOCATION_URI,
      "http://www.webrtc.org/experiments/rtp-hdrext/video-layers-allocation00");
  });

  it("writes the allocation captured from the web client", function() {
    // The browser's fake camera: 320x240 at 15 fps with a 279 kbps target,
    // byte-for-byte as captured from its RTP (ext id 5).
    var d = media.buildVideoLayersAllocation({
      vlaIndex: 0,
      width: 320,
      height: 240,
      activeBitrate: 279000,
      config: { fps: 15, bitrate: 279000 }
    });
    assert.strictEqual(d.toString("hex"), "01009702013f00ef0f");
  });

  it("keeps the multi-byte bitmask form for higher simulcast indices", function() {
    var d = media.buildVideoLayersAllocation({
      vlaIndex: 1,
      width: 640,
      height: 360,
      activeBitrate: 700000,
      config: { fps: 30, bitrate: 700000 }
    });
    // index 1: header (1<<6)|(1<<4) = 0x50, packed masks 0x01, one temporal
    // layer, then the bitrate and resolution.
    assert.strictEqual(d[0], 0x50);
    assert.strictEqual(d[1], 0x01);
    assert.strictEqual(d[2], 0x00);
    assert.strictEqual(d.readUInt16BE(d.length - 5), 639);
    assert.strictEqual(d.readUInt16BE(d.length - 3), 359);
    assert.strictEqual(d[d.length - 1], 30);
  });
});
