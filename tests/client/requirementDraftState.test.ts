import test from "node:test";
import assert from "node:assert/strict";
import { initialRequirementState, latestPersistedRequirementFields, mergeRequirementText, receiveRequirementSnapshot, resolveRequirementConflict, restoreRequirementState } from "../../src/client/task-mode/requirementDraftState.ts";
import type { RequirementDraftSnapshot } from "../../src/shared/requirementDraftTypes.ts";

const snapshot = (descriptionMd: string, version = 1): RequirementDraftSnapshot => ({ draftId: "draft", version, fields: { title: "需求", descriptionMd, acceptanceCriteriaMd: "" }, createdAt: "", updatedAt: "" });

test("merges independent concurrent edits within the same paragraph", () => {
  assert.deepEqual(mergeRequirementText("颜色蓝色，大小十厘米。", "颜色红色，大小十厘米。", "颜色蓝色，大小二十厘米。"), { text: "颜色红色，大小二十厘米。", conflicts: [] });
});
test("merges multiple disjoint edits and retains attachments and references", () => {
  const base = "标题\n第一段\n![图](blob:abc)\n[引用](task://123)\n第二段\n结尾";
  const result = mergeRequirementText(base, base.replace("标题", "新标题").replace("结尾", "新结尾"), base.replace("第二段", "改第二段"));
  assert.equal(result.text, base.replace("标题", "新标题").replace("结尾", "新结尾").replace("第二段", "改第二段"));
  assert.equal(result.conflicts.length, 0);
});
test("overlapping edits preserve both versions and local text until chosen", () => {
  const state = receiveRequirementSnapshot({ ...initialRequirementState(snapshot("a blue b")), fields: snapshot("a red b").fields }, snapshot("a green b", 2), 8);
  assert.equal(state.fields.descriptionMd, "a red b");
  assert.equal(state.conflicts.length, 1);
  assert.equal(resolveRequirementConflict(state, state.conflicts[0].id, "assistant").fields.descriptionMd, "a green b");
  const both = resolveRequirementConflict(state, state.conflicts[0].id, "both");
  assert.ok(both.fields.descriptionMd.includes("red"));
  assert.ok(both.fields.descriptionMd.includes("green"));
});
test("conflict choice rebases around later independent user edits", () => {
  const state = receiveRequirementSnapshot({ ...initialRequirementState(snapshot("a blue b")), fields: snapshot("a red b").fields }, snapshot("a green b", 2));
  state.fields.descriptionMd += " user suffix";
  assert.equal(resolveRequirementConflict(state, state.conflicts[0].id, "assistant").fields.descriptionMd, "a green b user suffix");
});
test("later edits in conflict region require a fresh choice", () => {
  const state = receiveRequirementSnapshot({ ...initialRequirementState(snapshot("blue")), fields: snapshot("red").fields }, snapshot("green", 2));
  state.fields.descriptionMd = "yellow";
  const next = resolveRequirementConflict(state, state.conflicts[0].id, "assistant");
  assert.equal(next.fields.descriptionMd, "yellow");
  assert.ok(next.conflicts.length > 0);
});
test("replayed, stale, and other draft events cannot reapply edits", () => {
  const state = receiveRequirementSnapshot(initialRequirementState(snapshot("one")), snapshot("two", 2), 5);
  state.fields.descriptionMd = "my unsent edit";
  assert.equal(receiveRequirementSnapshot(state, snapshot("one"), 4), state);
  assert.equal(receiveRequirementSnapshot(state, { ...snapshot("attack", 9), draftId: "other" }, 9), state);
  assert.equal(receiveRequirementSnapshot(state, snapshot("two", 2), 5).fields.descriptionMd, "my unsent edit");
});
test("same concurrent insertion is applied only once", () => {
  assert.deepEqual(mergeRequirementText("ab", "a!b", "a!b"), { text: "a!b", conflicts: [] });
});

test("existing-task recovery restores unsubmitted fields, not the saved task initialization", () => {
  const saved = initialRequirementState(snapshot("Unsubmitted content", 3));
  const opening = snapshot("Saved task content").fields;
  const restored = restoreRequirementState(saved, opening, opening);
  assert.equal(restored.fields.descriptionMd, "Unsubmitted content");
  assert.deepEqual(restored.server, saved.server);
  assert.deepEqual(restored.conflicts, []);
});
test("input typed during recovery merges with independent restored edits", () => {
  const saved = initialRequirementState(snapshot("alpha beta gamma"));
  saved.fields.descriptionMd = "alpha beta restored";
  const opening = snapshot("alpha beta gamma").fields;
  const current = { ...opening, descriptionMd: "typed beta gamma" };
  const restored = restoreRequirementState(saved, opening, current);
  assert.equal(restored.fields.descriptionMd, "typed beta restored");
  assert.equal(restored.conflicts.length, 0);
});
test("overlapping input typed during recovery keeps both versions", () => {
  const saved = initialRequirementState(snapshot("old"));
  saved.fields.descriptionMd = "restored";
  const opening = snapshot("old").fields;
  const restored = restoreRequirementState(saved, opening, snapshot("typed").fields);
  assert.equal(restored.fields.descriptionMd, "typed");
  assert.equal(restored.conflicts.length, 1);
  assert.equal(restored.conflicts[0].assistant, "restored");
});
test("authoritative form restoration preserves remapped attachment URLs and new input", () => {
  const saved = initialRequirementState(snapshot("![file](blob:old)"));
  const current = snapshot("![file](blob:new)\nTyped after loading").fields;
  const restored = restoreRequirementState(saved, saved.fields, current, true);
  assert.equal(restored.fields.descriptionMd, current.descriptionMd);
  assert.equal(restored.server.fields.descriptionMd, "![file](blob:old)");
});
test("newest persisted text wins; conversation-only timestamps cannot select older text", () => {
  const form = { fields: snapshot("new form content").fields, savedAt: 20 };
  const helper = { fields: snapshot("old helper content").fields, savedAt: 10 };
  assert.equal(latestPersistedRequirementFields(form, helper), form.fields);
  assert.equal(latestPersistedRequirementFields(form, { ...helper, savedAt: 30 }), helper.fields);
  assert.equal(latestPersistedRequirementFields(undefined, helper), helper.fields);
  assert.equal(latestPersistedRequirementFields({ ...form, savedAt: undefined }, { ...helper, savedAt: undefined }), form.fields);
});
