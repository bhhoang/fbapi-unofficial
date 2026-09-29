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
  var requests; // every HTTP request the library made: {method, url, form}
  var deltasToSend; // pushed on /t_ms once the sync queue is created
  var presenceToSend; // pushed on /orca_presence once the sync queue is created

  beforeEach(function(done) {
    events = [];
    requests = [];
    deltasToSend = [];
    presenceToSend = null;
    wss = new WebSocket.Server({ port: 0, host: "127.0.0.1" }, done);
    wss.on("connection", function(socket) {
      events.push("websocket connected");
      socket.on("close", function() { events.push("websocket closed"); });
      var parser = mqttPacket.parser({ protocolVersion: 3 });
      parser.on("packet", function(packet) {
        if (packet.cmd === "connect") {
          socket.send(mqttPacket.generate({ cmd: "connack", returnCode: 0 }));
        } else if (packet.cmd === "publish") {
          events.push({ topic: packet.topic, payload: packet.payload.toString() });
          if (packet.qos === 1) {
            socket.send(mqttPacket.generate({ cmd: "puback", messageId: packet.messageId }));
          }
          if (packet.topic === "/messenger_sync_create_queue" && deltasToSend.length) {
            socket.send(mqttPacket.generate({
              cmd: "publish",
              topic: "/t_ms",
              qos: 0,
              payload: Buffer.from(JSON.stringify({ deltas: deltasToSend, lastIssuedSeqId: 4243 }))
            }));
          }
        }
      });
      socket.on("message", function(data) { parser.parse(data); });
    });
    var url = function() { return "ws://127.0.0.1:" + wss.address().port + "/chat"; };
    websocket.mqtt = function(host, options) { return originalMqtt(url(), options); };
    http.request = function(op) {
      var target = String(op.url || op.uri);
      requests.push({ method: op.method || "GET", url: target, form: op.form });
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

  var ME = "100000000000001";
  var FRIEND = "100000000000002";

  function newMessage(id, sender, attachments) {
    return {
      class: "NewMessage",
      body: "hi",
      attachments: attachments || [],
      messageMetadata: {
        messageId: id,
        actorFbId: sender,
        threadKey: { otherUserFbId: FRIEND },
        timestamp: "1790000000000"
      }
    };
  }

  // Logs in, starts listenMqtt, and calls `check` once `ms` have passed after
  // the sync queue was created (so deltas and receipts had time to go out).
  function listenThen(options, ms, done, check) {
    seqIdReply = delayed(SEQ_ID_BODY, 0);
    login({ appState: appState() }, Object.assign({ logLevel: "silent" }, options), guard(done, function(err, api) {
      if (err) return done(err);
      var received = [];
      var stop = api.listenMqtt(function(listenErr, event) {
        if (listenErr) return done(listenErr);
        received.push(event);
      });
      var started = Date.now();
      (function wait() {
        var queued = events.some(function(e) { return e.topic === "/messenger_sync_create_queue"; });
        if (!queued) {
          if (Date.now() - started > 3000) return done(new Error("no sync queue"));
          return setTimeout(wait, 10);
        }
        setTimeout(guard(done, function() {
          stop();
          check(received);
          done();
        }), ms);
      })();
    }));
  }

  it("sends one delivery receipt for a burst of messages, and none for your own", function(done) {
    deltasToSend = [
      newMessage("mid.a", FRIEND),
      newMessage("mid.b", FRIEND),
      newMessage("mid.c", FRIEND),
      newMessage("mid.mine", ME)
    ];
    listenThen({}, 1500, done, function(received) {
      assert.strictEqual(received.filter(function(e) { return e.type === "message"; }).length, 3);
      var receipts = requests.filter(function(r) { return /delivery_receipts/.test(r.url); });
      assert.strictEqual(receipts.length, 1, "receipt requests: " + receipts.length);
      var ids = Object.keys(receipts[0].form)
        .filter(function(k) { return /^message_ids\[/.test(k); })
        .map(function(k) { return receipts[0].form[k]; })
        .sort();
      assert.deepStrictEqual(ids, ["mid.a", "mid.b", "mid.c"]);
      assert.deepStrictEqual(
        [receipts[0].form["thread_ids[" + FRIEND + "][0]"], receipts[0].form["thread_ids[" + FRIEND + "][2]"]],
        ["mid.a", "mid.c"]
      );
    });
  });

  it("doesn't look up photos or send receipts for your own messages when selfListen is off", function(done) {
    deltasToSend = [
      newMessage("mid.mine", ME, [{ fbid: "555", mercury: { attach_type: "photo", metadata: {} } }])
    ];
    listenThen({}, 1500, done, function(received) {
      assert.strictEqual(received.length, 0);
      var extra = requests.filter(function(r) { return /mercury\/attachments\/photo|delivery_receipts/.test(r.url); });
      assert.deepStrictEqual(extra.map(function(r) { return r.url; }), []);
    });
  });

  it("closes the previous connection when listenMqtt is called again", function(done) {
    seqIdReply = delayed(SEQ_ID_BODY, 0);
    login({ appState: appState() }, { logLevel: "silent" }, guard(done, function(err, api) {
      if (err) return done(err);
      api.listenMqtt(function() {});
      setTimeout(function() {
        var stop = api.listenMqtt(function() {});
        setTimeout(guard(done, function() {
          var connects = events.filter(function(e) { return e === "websocket connected"; }).length;
          var closes = events.filter(function(e) { return e === "websocket closed"; }).length;
          assert.strictEqual(connects, 2);
          assert.strictEqual(closes, 1, "the first connection should be closed");
          assert.strictEqual(wss.clients.size, 1);
          stop();
          done();
        }), 400);
      }, 300);
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
