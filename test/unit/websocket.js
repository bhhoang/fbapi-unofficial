"use strict";

// Offline tests for src/websocket.js and the mqtt client built on it, using a
// local WebSocket server that speaks just enough MQTT to accept a connection.

var assert = require("assert");
var WebSocket = require("ws");
var mqtt = require("mqtt");
var mqttPacket = require("mqtt-packet");
var websocket = require("../../src/websocket");

describe("src/websocket", function() {
  var wss;
  var url;
  var lastHeaders;
  var sockets = [];

  before(function(done) {
    wss = new WebSocket.Server({ port: 0, host: "127.0.0.1" }, function() {
      url = "ws://127.0.0.1:" + wss.address().port + "/chat";
      done();
    });
    wss.on("connection", function(socket, req) {
      lastHeaders = req.headers;
      sockets.push(socket);
      var parser = mqttPacket.parser({ protocolVersion: 3 });
      parser.on("packet", function(packet) {
        if (packet.cmd === "connect") {
          socket.send(mqttPacket.generate({ cmd: "connack", returnCode: 0 }));
          socket.send(
            mqttPacket.generate({ cmd: "publish", topic: "/t_ms", payload: Buffer.from("hello"), qos: 0 })
          );
        }
      });
      socket.on("message", function(data) {
        if (data.toString() === "echo") return socket.send("echo");
        parser.parse(data);
      });
    });
  });

  after(function(done) {
    wss.close(done);
  });

  it("carries binary data both ways and emits close", function(done) {
    var stream = websocket(url, { headers: { Cookie: "a=1" }, origin: "https://www.facebook.com" });
    stream.on("data", function(chunk) {
      assert(Buffer.isBuffer(chunk));
      assert.strictEqual(chunk.toString(), "echo");
      assert.strictEqual(lastHeaders.cookie, "a=1");
      assert.strictEqual(lastHeaders.origin, "https://www.facebook.com");
      sockets[sockets.length - 1].close();
    });
    stream.on("close", function() {
      done();
    });
    stream.write(Buffer.from("echo"));
  });

  it("drives an mqtt client like listenMqtt does", function(done) {
    var client = new mqtt.Client(function() {
      return websocket(url, { headers: { Cookie: "a=1" } });
    }, { clientId: "mqttwsclient", protocolId: "MQIsdp", protocolVersion: 3, clean: true, reconnectPeriod: 0 });
    client.on("error", done);
    client.on("message", function(topic, message) {
      assert.strictEqual(topic, "/t_ms");
      assert.strictEqual(message.toString(), "hello");
      sockets[sockets.length - 1].close();
    });
    client.on("close", function() {
      client.end(true);
      done();
    });
  });
});
