"use strict";

// Poll deltas arrive with several stringified-JSON fields (shape captured from
// a live vote event); formatDeltaEvent should hand callers real objects.
var assert = require("assert");
var utils = require("../../utils");

describe("utils poll events", function() {
  it("parses the stringified fields of a group_poll delta", function() {
    var delta = {
      class: "AdminTextMessage",
      type: "group_poll",
      untypedData: {
        event_type: "update_vote",
        question_id: "122119794903370430",
        added_option_ids: "[1965442211531318]",
        removed_option_ids: "[]",
        new_option_ids: "[]",
        new_option_texts: "[]",
        question_json: JSON.stringify({
          id: "122119794903370430",
          text: "from the library 2",
          total_count: 2,
          voters: ["100035400259877"],
          options: [
            { id: "1965442211531318", text: "Yes", total_count: 1 },
            { id: "1083842031137195", text: "No", total_count: 0 }
          ]
        })
      },
      messageMetadata: {
        threadKey: { threadFbId: "837847712724845" }
      },
      logMessageBody: "somebody voted"
    };

    var event = utils.formatDeltaEvent(delta);

    assert.strictEqual(event.type, "event");
    assert.strictEqual(event.logMessageType, "group_poll");
    assert.strictEqual(event.threadID, "837847712724845");
    assert.deepStrictEqual(event.logMessageData.added_option_ids, [1965442211531318]);
    assert.deepStrictEqual(event.logMessageData.removed_option_ids, []);
    assert.strictEqual(event.logMessageData.question_json.text, "from the library 2");
    assert.deepStrictEqual(event.logMessageData.question_json.voters, ["100035400259877"]);
    assert.deepStrictEqual(event.logMessageData.question_json.options[0],
      { id: "1965442211531318", text: "Yes", total_count: 1 });
  });
});
