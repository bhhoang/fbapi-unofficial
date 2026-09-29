"use strict";

// Offline tests for listenMqtt's startup, with the sequence-ID request stubbed
// and a local WebSocket MQTT server standing in for edge-chat.facebook.com.

var assert = require("assert");
var WebSocket = require("ws");
var mqttPacket = require("mqtt-packet");
var http = require("../../src/http");
var websocket = require("../../src/websocket");
var login = require("../../index");

// Facebook separates the objects of a batch reply with \r\n.
var SEQ_ID_BODY = '{"o0":{"data":{"viewer":{"message_threads":{"sync_sequence_id":"4242"}}}}}\r\n' +
  '{"successful_results":1,"error_results":0}';
var EMPTY_BODY = 'for (;;);{"__ar":1,"payload":{}}';

function appState() {
  return [
    { key: "c_user", value: "100000000000001", domain: "facebook.com", path: "/" },
    { key: "xs", value: "x", domain: "facebook.com", path: "/" }
  ];
}

function guard(done, fn) {
  return function() {
    try {
      fn.apply(this, arguments);
    } catch (err) {
      done(err);
    }
  };
}

describe("listenMqtt startup", function() {
  var wss;
  var events;
  var originalRequest = http.request;
  var originalMqtt = websocket.mqtt;
  var seqIdReply;

  beforeEach(function(done) {
    events = [];
    wss = new WebSocket.Server({ port: 0, host: "127.0.0.1" }, done);
    wss.on("connection", function(socket) {
      events.push("websocket connected");
      var parser = mqttPacket.parser({ protocolVersion: 3 });
      parser.on("packet", function(packet) {
        if (packet.cmd === "connect") {
          socket.send(mqttPacket.generate({ cmd: "connack", returnCode: 0 }));
        } else if (packet.cmd === "publish") {
          events.push({ topic: packet.topic, payload: packet.payload.toString() });
          if (packet.qos === 1) {
            socket.send(mqttPacket.generate({ cmd: "puback", messageId: packet.messageId }));
          }
        }
      });
      socket.on("message", function(data) { parser.parse(data); });
    });
    var url = function() { return "ws://127.0.0.1:" + wss.address().port + "/chat"; };
    websocket.mqtt = function(host, options) { return originalMqtt(url(), options); };
    http.request = function(op) {
      var target = String(op.url || op.uri);
      var reply = { statusCode: 200, headers: {}, request: { uri: { href: target }, headers: {}, method: op.method || "GET" } };
      if (/\/ajax\/dtsg\//.test(target)) {
        reply.body = 'for (;;);{"payload":{"token":"t"}}';
        return Promise.resolve(reply);
      }
      if (/graphqlbatch/.test(target)) {
        events.push("seqId requested");
        return seqIdReply().then(function(body) {
          events.push("seqId answered");
          reply.body = body;
          return reply;
        });
      }
      reply.body = 'for (;;);{"payload":{}}';
      return Promise.resolve(reply);
    };
  });

  afterEach(function(done) {
    http.request = originalRequest;
    websocket.mqtt = originalMqtt;
    wss.close(function() { done(); });
    wss.clients.forEach(function(c) { c.terminate(); });
  });

  function delayed(body, ms) {
    return function() {
      return new Promise(function(resolve) { setTimeout(function() { resolve(body); }, ms); });
    };
  }

  it("connects while the sequence ID is still being fetched, then creates the sync queue", function(done) {
    seqIdReply = delayed(SEQ_ID_BODY, 150);
    login({ appState: appState() }, { logLevel: "silent" }, guard(done, function(err, api) {
      if (err) return done(err);
      var stop = api.listenMqtt(function(listenErr) { if (listenErr) done(listenErr); });
      var started = Date.now();
      (function wait() {
        var queue = events.filter(function(e) { return e.topic === "/messenger_sync_create_queue"; })[0];
        if (!queue) {
          if (Date.now() - started > 3000) return done(new Error("no sync queue; events: " + JSON.stringify(events)));
          return setTimeout(wait, 10);
        }
        try {
          var order = events.map(function(e) { return typeof e === "string" ? e : e.topic; });
          assert(order.indexOf("websocket connected") < order.indexOf("seqId answered"),
            "the websocket should connect before the sequence ID arrives: " + order.join(", "));
          assert(order.indexOf("seqId answered") < order.indexOf("/messenger_sync_create_queue"),
            "the sync queue needs the sequence ID: " + order.join(", "));
          assert.strictEqual(JSON.parse(queue.payload).initial_titan_sequence_id, "4242");
          stop();
          done();
        } catch (e) {
          stop();
          done(e);
        }
      })();
    }));
  });

  it("closes the connection and reports the error when the sequence ID can't be fetched", function(done) {
    seqIdReply = delayed(EMPTY_BODY, 150);
    login({ appState: appState() }, { logLevel: "silent" }, guard(done, function(err, api) {
      if (err) return done(err);
      api.listenMqtt(guard(done, function(listenErr) {
        assert(listenErr && /empty response/i.test(listenErr.error), String(listenErr && listenErr.error));
        // Give a would-be reconnect time to show up.
        setTimeout(guard(done, function() {
          var connects = events.filter(function(e) { return e === "websocket connected"; }).length;
          assert(connects <= 1, "reconnected " + connects + " times");
          assert.strictEqual(wss.clients.size, 0, "the MQTT connection is still open");
          done();
        }), 1500);
      }));
    }));
  });
});
