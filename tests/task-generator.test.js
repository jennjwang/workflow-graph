// Tests for the task-generation prompt builders (prompts/task-generator.js).
// Focus on the invariants the pipeline relies on: the anchored-mode rewrites,
// the burnout-count ceiling, the mentioned-tasks block, and the task-splitting
// rule in the interview extractor. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UPPER_LEVEL_TASKS_SYSTEM_PROMPT,
  buildUpperLevelTasksPrompt,
  INTERVIEW_TASK_EXTRACTOR_PROMPT,
  mentionedTasksBlock,
  buildAnchoredTaskSystemPrompt,
  buildGapProbeMessages,
} from '../prompts/task-generator.js';

test('non-anchored prompt is the base prompt verbatim', () => {
  assert.equal(buildUpperLevelTasksPrompt({ anchored: false }), UPPER_LEVEL_TASKS_SYSTEM_PROMPT);
  assert.equal(buildUpperLevelTasksPrompt(), UPPER_LEVEL_TASKS_SYSTEM_PROMPT);
});

test('anchored prompt relaxes collective-exhaustiveness', () => {
  const anchored = buildUpperLevelTasksPrompt({ anchored: true, count: 20 });
  // The base MECE line is rewritten; exhaustiveness moves to the interview.
  assert.notEqual(anchored, UPPER_LEVEL_TASKS_SYSTEM_PROMPT);
  assert.match(anchored, /ANCHORED COVERAGE/);
  assert.doesNotMatch(anchored, /Aim for 25–30 tasks/);
});

test('anchored prompt enforces the count ceiling only when count is valid', () => {
  assert.match(buildUpperLevelTasksPrompt({ anchored: true, count: 20 }), /must not exceed 20/);
  assert.match(buildUpperLevelTasksPrompt({ anchored: true, count: 12.6 }), /must not exceed 13/); // rounded
  assert.doesNotMatch(buildUpperLevelTasksPrompt({ anchored: true }), /must not exceed/);
  assert.doesNotMatch(buildUpperLevelTasksPrompt({ anchored: true, count: 0 }), /must not exceed/);
});

test('mentionedTasksBlock is empty for no tasks and lists each task otherwise', () => {
  assert.equal(mentionedTasksBlock([]), '');
  assert.equal(mentionedTasksBlock(), '');

  const block = mentionedTasksBlock(['Write proposals', 'Grade exams']);
  assert.match(block, /EXPLICITLY MENTIONED/);
  assert.match(block, /- Write proposals/);
  assert.match(block, /- Grade exams/);
});

test('interview extractor carries the split-bundled-objects rule', () => {
  assert.match(INTERVIEW_TASK_EXTRACTOR_PROMPT, /ONE THING PER TASK/);
  assert.match(INTERVIEW_TASK_EXTRACTOR_PROMPT, /DON'T OVER-SPLIT/);
  // Output contract is a JSON object with a tasks array.
  assert.match(INTERVIEW_TASK_EXTRACTOR_PROMPT, /\{"tasks":/);
});

test('anchored system prompt threads the count through and names the mode', () => {
  const prompt = buildAnchoredTaskSystemPrompt(15);
  assert.match(prompt, /PARTICIPANT-ANCHORED MODE/);
  assert.match(prompt, /must not exceed 15/);
});

test('gap-probe messages enforce filler ban, verbatim anchors, and the area cap', () => {
  const msgs = buildGapProbeMessages({
    jobTitle: 'Auditor',
    responsibilities: 'Assist foreign audit teams',
    typicalWeek: 'Review financial statements',
    transcript: 'Q: Walk me through a week.\nA: I review balance sheets.',
    maxAreas: 3,
  });
  assert.equal(msgs.length, 2);
  const [system, user] = msgs;
  assert.match(system.content, /BAN GENERIC FILLER/);
  assert.match(system.content, /VERBATIM ONLY/);
  assert.match(system.content, /MUST NOT LEAD/);
  assert.match(system.content, /AT MOST 3 areas/);
  assert.match(user.content, /Auditor/);
  assert.match(user.content, /I review balance sheets/); // transcript embedded for anchoring
});

test('gap-probe renders "(none)" placeholders when tasks/transcript are empty', () => {
  const [, user] = buildGapProbeMessages({ jobTitle: 'Nurse', maxAreas: 2 });
  assert.match(user.content, /\(none\)/);
});
