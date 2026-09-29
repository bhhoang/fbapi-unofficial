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
        if (packet.cmd === "publish" && packet.topic === "/ls_req") {
          // Facebook's broker acks with reserved flag bits set (0x42 instead
          // of 0x40), which strict MQTT parsers reject.
          var puback = Buffer.from([0x42, 0x02, packet.messageId >> 8, packet.messageId & 0xff]);
          if (packet.payload.toString() === "split") {
            // One packet spread over two WebSocket messages.
            socket.send(puback.subarray(0, 1));
            socket.send(puback.subarray(1));
          } else {
            // Two packets in one WebSocket message.
            socket.send(Buffer.concat([
              puback,
              mqttPacket.generate({ cmd: "publish", topic: "/ls_resp", payload: Buffer.from("after"), qos: 0 })
            ]));
          }
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

  it("backs off between reconnect attempts and resets once connected", function(done) {
    var attempts = [];
    var dropping = new WebSocket.Server({ port: 0, host: "127.0.0.1" }, function() {
      var dropUrl = "ws://127.0.0.1:" + dropping.address().port + "/chat";
      var client = new mqtt.Client(function() {
        return websocket.mqtt(dropUrl, {});
      }, { clientId: "backoff", protocolId: "MQIsdp", protocolVersion: 3, reconnectPeriod: 40 });
      websocket.mqttReconnectBackoff(client, { min: 40, max: 160 });
      client.on("error", function() {});
      dropping.on("connection", function(socket) {
        attempts.push(Date.now());
        socket.terminate();
        if (attempts.length < 6) return;
        client.end(true);
        dropping.close();
        var gaps = attempts.slice(1).map(function(t, i) { return t - attempts[i]; });
        try {
          // 40, 80, 160, 160, 160 (plus connection time).
          assert(gaps[1] >= 70, "second gap " + gaps[1]);
          assert(gaps[2] >= 140, "third gap " + gaps[2]);
          assert(gaps[4] < 400, "capped gap " + gaps[4]);
          assert.strictEqual(client.options.reconnectPeriod, 160);
        } catch (err) {
          return done(err);
        }
        // A successful connection resets the delay.
        var good = new mqtt.Client(function() {
          return websocket.mqtt(url, {});
        }, { clientId: "backoff2", protocolId: "MQIsdp", protocolVersion: 3, reconnectPeriod: 40 });
        websocket.mqttReconnectBackoff(good, { min: 40, max: 160 });
        good.options.reconnectPeriod = 160;
        good.on("connect", function() {
          setImmediate(function() {
            var period = good.options.reconnectPeriod;
            good.end(true);
            done(period === 40 ? null : new Error("reconnectPeriod after connect: " + period));
          });
        });
      });
    });
  });

  it("accepts Facebook's acks with reserved header flags set", function(done) {
    var client = new mqtt.Client(function() {
      return websocket.mqtt(url, { headers: { Cookie: "a=1" } });
    }, { clientId: "mqttwsclient", protocolId: "MQIsdp", protocolVersion: 3, clean: true, reconnectPeriod: 0 });
    var finished = false;
    function finish(err) {
      if (finished) return;
      finished = true;
      client.end(true);
      done(err);
    }
    client.on("error", finish);
    client.on("connect", function() {
      client.publish("/ls_req", "split", { qos: 1 }, function(err) {
        if (err) return finish(err);
        client.publish("/ls_req", "batched", { qos: 1 }, function(err2) {
          if (err2) return finish(err2);
        });
      });
    });
    client.on("message", function(topic, message) {
      if (topic !== "/ls_resp") return;
      assert.strictEqual(message.toString(), "after");
      assert.strictEqual(client.connected, true);
      finish();
    });
  });
});
