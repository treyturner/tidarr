const assert = require("node:assert/strict");
const test = require("node:test");

const { queueDb } = require("../dist/src/services/db-json.js");
const {
  loadQueueFromFile,
} = require("../dist/src/helpers/queue_save_file.js");

test("persisted numeric processing IDs are migrated to strings", async (t) => {
  const persistedItem = {
    id: 515863434,
    artist: "Tricky",
    title: "Different When It's Silent",
    type: "album",
    status: "finished",
    quality: "high",
    url: "album/515863434",
    loading: false,
    error: false,
    source: "tidarr",
  };
  const writes = [];

  t.mock.method(queueDb, "getData", async () => [persistedItem]);
  t.mock.method(queueDb, "push", async (path, value) => {
    writes.push([path, value]);
  });

  const records = await loadQueueFromFile();

  assert.equal(records[0].id, "515863434");
  assert.equal(typeof records[0].id, "string");
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], "/");
  assert.equal(writes[0][1][0].id, "515863434");
});
