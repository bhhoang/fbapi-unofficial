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
