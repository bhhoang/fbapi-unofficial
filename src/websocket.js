"use strict";

// Opens a WebSocket and exposes it as a Duplex stream of binary chunks,
// replacing the unmaintained `websocket-stream` package (whose `ws@3`
// dependency has known DoS advisories). The MQTT clients and the E2EE Noise
// socket are built on this.
//
// ws's createWebSocketStream() only emits 'close' when the stream is destroyed
// locally, not when the server drops the connection, but mqtt and
// e2ee/noise.js rely on it to notice a dropped connection. So 'close' is also
// emitted when the socket closes, and deduplicated so it fires exactly once.

var WebSocket = require("ws");

module.exports = function websocketStream(url, options) {
  var socket = new WebSocket(url, options);
  var duplex = WebSocket.createWebSocketStream(socket);
  var closed = false;

  var emit = duplex.emit;
  duplex.emit = function(event) {
    if (event === "close") {
      if (closed) return false;
      closed = true;
    }
    return emit.apply(this, arguments);
  };

  socket.once("close", function() {
    process.nextTick(function() {
      duplex.emit("close");
    });
  });

  duplex.socket = socket;
  return duplex;
};

// Header flag bits each MQTT packet type must carry (publish, type 3, uses its
// flags for dup/qos/retain and isn't listed).
var MQTT_REQUIRED_FLAGS = {
  1: 0, 2: 0, 4: 0, 5: 0, 6: 2, 7: 0, 8: 2, 9: 0, 10: 2, 11: 0, 12: 0, 13: 0, 14: 0, 15: 0
};

// A websocket stream for the MQTT clients. Facebook's broker sends some packets
// (e.g. PUBACK as 0x42) with reserved header flag bits set, and mqtt-packet 9
// treats that as a protocol error and drops the connection, so every send
// after the first one would fail. The flags carry no meaning for these packet
// types, so they are reset to the required value before mqtt parses them.
// Packets can span or share websocket messages, so boundaries are tracked
// across chunks.
module.exports.mqtt = function mqttWebsocketStream(url, options) {
  var duplex = module.exports(url, options);
  var push = duplex.push;
  var bodyLeft = 0; // bytes of the current packet's body still to skip
  var readingLength = false; // inside the remaining-length varint
  var length = 0;
  var multiplier = 1;

  duplex.push = function(chunk) {
    if (chunk === null || !Buffer.isBuffer(chunk)) return push.apply(this, arguments);
    var copied = false;
    var i = 0;
    while (i < chunk.length) {
      if (bodyLeft > 0) {
        var skip = Math.min(bodyLeft, chunk.length - i);
        bodyLeft -= skip;
        i += skip;
      } else if (readingLength) {
        var b = chunk[i++];
        length += (b & 127) * multiplier;
        multiplier *= 128;
        if (!(b & 128)) {
          readingLength = false;
          bodyLeft = length;
        }
      } else {
        var required = MQTT_REQUIRED_FLAGS[chunk[i] >> 4];
        if (required !== undefined && (chunk[i] & 15) !== required) {
          if (!copied) {
            chunk = Buffer.from(chunk);
            copied = true;
          }
          chunk[i] = (chunk[i] & 0xf0) | required;
        }
        i++;
        readingLength = true;
        length = 0;
        multiplier = 1;
      }
    }
    return push.call(this, chunk);
  };
  return duplex;
};
