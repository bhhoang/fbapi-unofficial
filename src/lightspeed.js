"use strict";

// Minimal Lightspeed (gateway.facebook.com/ws/lightspeed) client. The web
// client's task queues live here: polls, pins and other lightweight writes are
// published as tasks on channel 23 with a `{"app_id","payload","request_id",
// "type":3}` envelope. The task labels and envelopes were captured from the
// web client creating a poll:
//
//   {"app_id":"2220391788200892","payload":"{\"epoch_id\":<ms<<22>,
//    \"tasks\":[{\"failure_count\":null,\"label\":\"163\",
//      \"payload\":\"{\\\"question_text\\\":...,\\\"thread_key\\\":...,\\
//      \"options\\\":[...],\\\"sync_group\\\":1}\",
//      \"queue_name\":\"poll_creation\",\"task_id\":N}],
//    \"version_id\":\"<queue version>\"}","request_id":N,"type":3}
//
// Frames are binary: [type][channel: u16le][length: u24le] payload, with 0x0f
// for a subscribe and 0x0d for a publish. Publish payloads are prefixed by
// 00 80.

var crypto = require("crypto");
var log = require("npmlog");
var websocket = require("./websocket");

var APP_ID = "2220391788200892";
var TASK_CHANNEL = 23;
// The queue configuration version the web client reports; stable across
// sessions but ties to Facebook's deploys, so createPoll accepts an override.
var TASK_VERSION_ID = "27900070029672763";

function snowflake() {
  return (BigInt(Date.now()) << 22n).toString();
}

function frame(type, channel, payload) {
  var header = Buffer.alloc(6);
  header[0] = type;
  header.writeUInt16LE(channel, 1);
  header.writeUIntLE(payload.length, 3, 3);
  return Buffer.concat([header, payload]);
}

function subscribeFrame(channel) {
  return frame(0x0f, channel, Buffer.from("{}"));
}

function publishFrame(channel, json) {
  return frame(0x0d, channel, Buffer.concat([Buffer.from([0x00, 0x80]), Buffer.from(json)]));
}

// Parses a received frame into [{type, channel, payload}].
function parseFrames(buf) {
  var messages = [];
  var offset = 0;
  while (offset + 6 <= buf.length) {
    var type = buf[offset];
    var channel = buf.readUInt16LE(offset + 1);
    var length = buf[offset + 3] | (buf[offset + 4] << 8) | (buf[offset + 5] << 16);
    if (offset + 6 + length > buf.length) break;
    messages.push({ type: type, channel: channel, payload: buf.slice(offset + 6, offset + 6 + length) });
    offset += 6 + length;
  }
  return messages;
}

function LightspeedClient(ctx) {
  this.ctx = ctx;
  this.socket = null;
  this.opening = null;
  this.requestId = 1;
  this.taskId = 1;
  this.pending = [];
}

LightspeedClient.prototype.url = function() {
  return "wss://gateway.facebook.com/ws/lightspeed?x-dgw-appid=" + APP_ID +
    "&x-dgw-appversion=0&x-dgw-authtype=1:0&x-dgw-version=5&x-dgw-uuid=" + this.ctx.userID +
    "&x-dgw-tier=prod&x-dgw-loggingid=" + crypto.randomUUID() +
    "&x-dgw-deviceid=" + crypto.randomUUID();
};

LightspeedClient.prototype.connect = function(callback) {
  var self = this;
  if (this.socket && this.socket.readyState === 1) return callback(null);
  if (this.opening) {
    this.opening.push(callback);
    return;
  }
  this.opening = [callback];
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
    var opening = this.opening;
    this.opening = null;
    opening.forEach(function(cb) { cb(err); });
    return;
  }
  this.socket = socket;
  var settled = false;

  socket.on("open", function() {
    if (self.socket !== socket) return;
    settled = true;
    var opening = self.opening || [];
    self.opening = null;
    opening.forEach(function(cb) { cb(null); });
  });

  socket.on("message", function(data) {
    var buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    parseFrames(buf).forEach(function(message) {
      if (message.channel !== TASK_CHANNEL) return;
      var text = message.payload.toString("utf8");
      log.verbose("lightspeed", "channel 23 frame type " + message.type + ": " +
        text.replace(/[^\x20-\x7e]/g, ".").slice(0, 300));
      // A bare {"code":N} is just the gateway acknowledging the subscribe;
      // the task's own result (if any) follows as a richer frame.
      if (/^\s*\{\s*"code"\s*:\s*\d+\s*\}\s*$/.test(text)) return;
      var waiter = self.pending.shift();
      if (waiter) waiter(null, text);
    });
  });

  socket.on("close", function() {
    if (self.socket === socket) self.socket = null;
    if (!settled) {
      settled = true;
      var opening = self.opening || [];
      self.opening = null;
      opening.forEach(function(cb) { cb(new Error("lightspeed socket closed")); });
    }
    // Fail any waiting response callbacks so callers are not left hanging.
    var pending = self.pending;
    self.pending = [];
    pending.forEach(function(waiter) { waiter(new Error("lightspeed socket closed"), null); });
  });

  socket.on("error", function(err) {
    log.verbose("lightspeed", "socket error: " + (err && err.message || err));
  });
};

LightspeedClient.prototype.close = function() {
  var socket = this.socket;
  this.socket = null;
  if (socket) {
    try { socket.close(); } catch (e) { /* already closed */ }
  }
};

// Publishes a task-queue request on channel 23 and hands the first channel-23
// response to `callback` (or times out, since the task may have been applied
// even when the response never arrives).
LightspeedClient.prototype.publishTask = function(envelope, callback) {
  var self = this;
  this.connect(function(err) {
    if (err) return callback(err);
    var socket = self.socket;
    if (!socket) return callback(new Error("lightspeed socket unavailable"));
    var payload;
    try {
      payload = JSON.stringify(envelope);
    } catch (e) {
      return callback(e);
    }
    var waiter = null;
    var timer = null;
    if (callback) {
      waiter = function(werr, text) {
        if (timer) clearTimeout(timer);
        callback(werr, text);
      };
      self.pending.push(waiter);
      timer = setTimeout(function() {
        var index = self.pending.indexOf(waiter);
        if (index !== -1) self.pending.splice(index, 1);
        log.verbose("lightspeed", "no channel 23 response within 4s; assuming the task was applied");
        callback(null, null);
      }, 4000);
    }
    socket.send(Buffer.concat([
      subscribeFrame(TASK_CHANNEL),
      publishFrame(TASK_CHANNEL, payload)
    ]));
  });
};

LightspeedClient.prototype.nextRequestId = function() {
  return this.requestId++;
};

LightspeedClient.prototype.nextTaskId = function() {
  return this.taskId++;
};

// Shared per API context so a poll (and future task writes) reuse one socket.
function clientFor(ctx) {
  if (!ctx.lightspeedClient) ctx.lightspeedClient = new LightspeedClient(ctx);
  return ctx.lightspeedClient;
}

// createPoll's publish: one poll_creation task, label 163.
function publishPoll(ctx, threadID, title, optionTexts, callback) {
  var client = clientFor(ctx);
  var threadKey = Number(threadID);
  if (!threadKey || !isFinite(threadKey)) {
    return callback({ error: "createPoll: the thread id must be numeric" });
  }
  var innerPayload = JSON.stringify({
    question_text: String(title == null ? "" : title),
    thread_key: threadKey,
    options: optionTexts,
    sync_group: 1
  });
  var payloadJson = '{"epoch_id":' + snowflake() +
    ',"tasks":[' + JSON.stringify({
      failure_count: null,
      label: "163",
      payload: innerPayload,
      queue_name: "poll_creation",
      task_id: client.nextTaskId()
    }) + '],"version_id":"' + TASK_VERSION_ID + '"}';
  var envelope = {
    app_id: APP_ID,
    payload: payloadJson,
    request_id: client.nextRequestId(),
    type: 3
  };
  client.publishTask(envelope, function(err, responseText) {
    if (err) return callback(err);
    var pollID = null;
    if (responseText) {
      var match = /"poll_id"?\s*:\s*"?(\d+)/.exec(responseText) ||
        /"pollID"?\s*:\s*"?(\d+)/.exec(responseText);
      if (match) pollID = match[1];
    }
    callback(null, { pollID: pollID, response: responseText || null });
  });
}

// Generic task publish for simple writes. Each entry: {label, payload (object,
// serialized for you), queueName}. Used by muteThread (label 144), markAsRead
// (labels 49/21) and similar task-queue writes captured from the web client.
function publishTasks(ctx, tasks, callback) {
  var client = clientFor(ctx);
  if (!callback) callback = function() {};
  var built = tasks.map(function(task) {
    return {
      failure_count: null,
      label: String(task.label),
      payload: JSON.stringify(task.payload),
      queue_name: String(task.queueName),
      task_id: client.nextTaskId()
    };
  });
  var payloadJson = '{"epoch_id":' + snowflake() +
    ',"tasks":' + JSON.stringify(built) +
    ',"version_id":"' + TASK_VERSION_ID + '"}';
  var envelope = {
    app_id: APP_ID,
    payload: payloadJson,
    request_id: client.nextRequestId(),
    type: 3
  };
  client.publishTask(envelope, function(err, responseText) {
    if (err) return callback(err);
    callback(null, { response: responseText || null });
  });
}

module.exports = {
  LightspeedClient: LightspeedClient,
  clientFor: clientFor,
  publishPoll: publishPoll,
  publishTasks: publishTasks,
  TASK_VERSION_ID: TASK_VERSION_ID
};
