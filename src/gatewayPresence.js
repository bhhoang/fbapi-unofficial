"use strict";

// Reports the account's presence ("Active now") to Facebook's gateway, the way
// the web client does. The legacy edge-chat MQTT connection doesn't update the
// active status anymore: the browser opens the gateway's streamcontroller
// socket, subscribes to PresenceUnifiedJSON and publishes its presence there
// (a reporting request, then amendments). This client does the same while the
// `online` option is on; stopping it (or `online: false`) lets the account
// drop back to "Active ... ago".
//
// The frames are binary: [type][channel: u16le][length: u24le] payload, with
// type 0x0f for a subscribe and 0x0d for a publish. The presence payload is
// JSON, prefixed by the fields captured from the web client.

var crypto = require("crypto");
var log = require("npmlog");
var websocket = require("./websocket");

var APP_ID = "2220391788200892";
var CHANNEL = 0;
var RECONNECT_DELAY = 5000;

var SUBSCRIBE_JSON =
  '{"x-dgw-app-XRSS-method":"PresenceUnifiedJSON","x-dgw-app-xrs-body":"true",' +
  '"x-dgw-app-XRS-Accept-Ack":"RSAck",' +
  '"x-dgw-app-XRSS-http_referer":"https://www.facebook.com/messages/"}';

function varint(value) {
  var bytes = [];
  var v = value;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function subscribeFrame() {
  var json = Buffer.from(SUBSCRIBE_JSON);
  var header = Buffer.alloc(6);
  header[0] = 0x0f;
  header.writeUInt16LE(CHANNEL, 1);
  header.writeUIntLE(json.length, 3, 3);
  return Buffer.concat([header, json]);
}

function publishFrame(headerHex, json) {
  var jsonBuf = Buffer.from(json);
  var jsonLength = varint(jsonBuf.length);
  var extra = Buffer.from(headerHex, "hex");
  var header = Buffer.alloc(6);
  header[0] = 0x0d;
  header.writeUInt16LE(CHANNEL, 1);
  header.writeUIntLE(extra.length + jsonLength.length + jsonBuf.length + 2, 3, 3);
  return Buffer.concat([header, extra, jsonLength, jsonBuf, Buffer.from("0000", "hex")]);
}

function presenceRequest() {
  return publishFrame("00802c18",
    '{"appFamily":1,"pollingMode":1,"appId":"' + APP_ID + '","presenceReportingRequest":{' +
    '"capabilities":"10","mutationId":"' + crypto.randomUUID() + '","availability":2},' +
    '"publishEncoding":2}');
}

function presenceAmendment(availability, foregrounded) {
  return publishFrame(foregrounded ? "03803c160418" : "01803c160018",
    '{"payload":{"presenceReportingAmendment":{"reportingArguments":{' +
    '"availability":' + availability + ',"foregrounded":' + foregrounded + ',' +
    '"mutationId":"' + crypto.randomUUID() + '","capabilities":"10"}}}}');
}

function GatewayPresence(ctx) {
  this.ctx = ctx;
  this.socket = null;
  this.stopped = true;
  this.reconnectTimer = null;
}

GatewayPresence.prototype.url = function() {
  return "wss://gateway.facebook.com/ws/streamcontroller?x-dgw-appid=" + APP_ID +
    "&x-dgw-appversion=0&x-dgw-authtype=1:0&x-dgw-version=5&x-dgw-uuid=" + this.ctx.userID +
    "&x-dgw-tier=prod&x-dgw-deviceid=" + crypto.randomUUID() + "&x-dgw-app-stream-group=group1";
};

GatewayPresence.prototype.start = function() {
  this.stopped = false;
  this.connect();
};

GatewayPresence.prototype.stop = function() {
  this.stopped = true;
  if (this.reconnectTimer) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
  var socket = this.socket;
  this.socket = null;
  if (socket) {
    try {
      // Tell the gateway the account is no longer available; just closing the
      // socket leaves the last reported availability in place until it ages
      // out, so the account would keep showing as "Active now".
      if (socket.readyState === 1) {
        socket.send(presenceAmendment(0, false));
      }
    } catch (_e) { /* already closing */ }
    // Give the report a moment to flush before closing.
    setTimeout(function() {
      try { socket.close(); } catch (_e) { /* already closed */ }
    }, 500);
  }
};

GatewayPresence.prototype.connect = function() {
  if (this.stopped || this.socket) return;
  var self = this;
  var socket;
  try {
    socket = websocket.gateway(this.url(), {
      headers: {
        "Cookie": this.ctx.jar.getCookies("https://www.facebook.com").join("; "),
        "Origin": "https://www.facebook.com",
        "User-Agent": this.ctx.globalOptions.userAgent
      }
    });
  } catch (err) {
    log.warn("presence", "Could not open the presence socket: " + (err && err.message || err));
    this.scheduleReconnect();
    return;
  }
  this.socket = socket;

  socket.on("open", function() {
    if (self.socket !== socket || self.stopped) return;
    log.info("presence", "Connected to the presence gateway");
    socket.send(subscribeFrame());
    setTimeout(function() {
      if (self.socket !== socket || self.stopped) return;
      socket.send(presenceRequest());
    }, 200);
    setTimeout(function() {
      if (self.socket !== socket || self.stopped) return;
      socket.send(presenceAmendment(2, false));
    }, 500);
    setTimeout(function() {
      if (self.socket !== socket || self.stopped) return;
      socket.send(presenceAmendment(1, true));
    }, 1800);
  });

  socket.on("close", function() {
    if (self.socket === socket) self.socket = null;
    self.scheduleReconnect();
  });

  socket.on("error", function(err) {
    log.verbose("presence", "Presence socket error: " + (err && err.message || err));
  });
};

GatewayPresence.prototype.scheduleReconnect = function() {
  if (this.stopped || this.reconnectTimer) return;
  var self = this;
  this.reconnectTimer = setTimeout(function() {
    self.reconnectTimer = undefined;
    self.connect();
  }, RECONNECT_DELAY);
};

module.exports = GatewayPresence;
