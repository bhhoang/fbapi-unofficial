"use strict";

// Offline tests for the write paths rebuilt from the web client's own traffic
// (captured 2026-09-30): muteThread (Lightspeed label 144), markAsRead /
// markAsUnread (labels 49/21 read watermarks), replies (label 46
// reply_metadata), markGroupVisited and pin/unpinGroupPost (Relay mutations).

var assert = require("assert");

var muteThread = require("../../src/muteThread");
var markAsRead = require("../../src/markAsRead");
var sendMessage = require("../../src/sendMessage");
var markGroupVisited = require("../../src/markGroupVisited");
var pinGroupPost = require("../../src/pinGroupPost");
var unpinGroupPost = require("../../src/unpinGroupPost");

describe("src/muteThread mute expiry", function() {
  it("passes permanent mutes through as -1", function() {
    assert.strictEqual(muteThread.muteExpireMs(-1), -1);
  });

  it("passes unmutes through as 0", function() {
    assert.strictEqual(muteThread.muteExpireMs(0), 0);
  });

  it("converts seconds to an absolute millisecond deadline", function() {
    assert.strictEqual(muteThread.muteExpireMs(60, 1000000), 1060000);
    assert.strictEqual(muteThread.muteExpireMs(3600, 1000), 3601000);
  });

  it("passes an existing absolute timestamp through unchanged", function() {
    // The web client sent the deadline in ms since epoch.
    assert.strictEqual(muteThread.muteExpireMs(1790754553514), 1790754553514);
  });

  it("rejects non-numeric values", function() {
    assert.strictEqual(muteThread.muteExpireMs("soon"), null);
    assert.strictEqual(muteThread.muteExpireMs(undefined), null);
  });
});

describe("src/markAsRead tasks", function() {
  it("builds the label 49 + label 21 read pair", function() {
    var tasks = markAsRead.buildReadTasks("837847712724845", 1790754536981, 1);
    assert.strictEqual(tasks.length, 2);
    assert.strictEqual(tasks[0].label, "49");
    assert.strictEqual(tasks[0].queueName, "837847712724845");
    assert.deepStrictEqual(tasks[0].payload, {
      thread_key: 837847712724845,
      last_read_watermark_timestamp_ms: 1790754536981,
      sync_group: 1,
      offline_threading_id: null
    });
    assert.strictEqual(tasks[1].label, "21");
    assert.deepStrictEqual(tasks[1].payload, {
      thread_id: 837847712724845,
      last_read_watermark_ts: 1790754536981,
      sync_group: 1,
      offline_threading_id: null
    });
  });

  it("keeps non-numeric thread ids as strings", function() {
    var tasks = markAsRead.buildReadTasks("abc", 5, 1);
    assert.strictEqual(tasks[0].payload.thread_key, "abc");
    assert.strictEqual(tasks[1].payload.thread_id, "abc");
  });

  it("marks unread with the rolled-back watermark and the thread's sync group", function() {
    var task = markAsRead.buildUnreadTask("4403802826507106", 1790754552999, 95);
    assert.strictEqual(task.label, "49");
    assert.deepStrictEqual(task.payload, {
      thread_key: 4403802826507106,
      last_read_watermark_timestamp_ms: 1790754552999,
      sync_group: 95,
      offline_threading_id: null
    });
  });

  it("never sends a negative unread watermark", function() {
    var task = markAsRead.buildUnreadTask("123", -5, 1);
    assert.strictEqual(task.payload.last_read_watermark_timestamp_ms, 0);
  });
});

describe("src/sendMessage replies", function() {
  it("builds the reply_metadata block the web client sends", function() {
    assert.deepStrictEqual(
      sendMessage.buildReplyMetadata("mid.$gAAL6BJ9K922nHi_vCGg7OqmRwmPd"),
      {
        reply_source_id: "mid.$gAAL6BJ9K922nHi_vCGg7OqmRwmPd",
        reply_source_type: 1,
        reply_type: 0,
        reply_source_attachment_id: null
      }
    );
  });

  it("omits the block for non-replies", function() {
    assert.strictEqual(sendMessage.buildReplyMetadata(null), null);
    assert.strictEqual(sendMessage.buildReplyMetadata(""), null);
  });
});

describe("src/markGroupVisited variables", function() {
  it("includes actor_id and client_mutation_id (the field_exception fix)", function() {
    var v = markGroupVisited.buildVisitVariables("1098120459377624", "61591112920161", 7);
    assert.strictEqual(v.bookmarkID, "1098120459377624");
    assert.strictEqual(v.input.actor_id, "61591112920161");
    assert.strictEqual(v.input.client_mutation_id, "7");
    assert.strictEqual(v.input.group_id, "1098120459377624");
    assert.strictEqual(v.input.environment, "COMET");
  });
});

describe("src/pinGroupPost and unpinGroupPost", function() {
  it("encodes the captured story_id vector", function() {
    assert.strictEqual(
      pinGroupPost.storyID("61591112920161", "1098120486044288"),
      "UzpfSTYxNTkxMTEyOTIwMTYxOlZLOjEwOTgxMjA0ODYwNDQyODg="
    );
    assert.strictEqual(
      unpinGroupPost.storyID("61591112920161", "1098120486044288"),
      "UzpfSTYxNTkxMTEyOTIwMTYxOlZLOjEwOTgxMjA0ODYwNDQyODg="
    );
  });

  it("sends the group id with the pin", function() {
    var v = pinGroupPost.buildPinVariables(
      "1098120486044288",
      { authorID: "61591112920161", groupID: "1098120459377624" },
      "61591112920161",
      4
    );
    assert.strictEqual(v.input.group_id, "1098120459377624");
    assert.strictEqual(v.input.story_id, "UzpfSTYxNTkxMTEyOTIwMTYxOlZLOjEwOTgxMjA0ODYwNDQyODg=");
    assert.strictEqual(v.renderLocation, "group");
    assert.strictEqual(v.useDefaultActor, true);
    assert.deepStrictEqual(v.highlighted_stories, []);
  });

  it("leaves group_id out when the caller does not know it", function() {
    var v = pinGroupPost.buildPinVariables("1", {}, "5", 1);
    assert.ok(!("group_id" in v.input));
  });

  it("unpins without a group id and with the feed flags the client sends", function() {
    var v = unpinGroupPost.buildUnpinVariables(
      "1098120486044288",
      { authorID: "61591112920161" },
      "61591112920161",
      5
    );
    assert.ok(!("group_id" in v.input));
    assert.strictEqual(v.input.client_mutation_id, "5");
    assert.strictEqual(v.feedLocation, "GROUP");
    assert.strictEqual(v.feedbackSource, 0);
    assert.strictEqual(v.useDefaultActor, false);
    assert.strictEqual(v.renderLocation, "group");
  });
});
