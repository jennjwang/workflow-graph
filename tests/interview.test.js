// Tests for the background-interview prompt builders (prompts/interview.js).
// These guard the wording invariants the interview behavior depends on —
// especially the anti-leading rule and the strict/lenient + follow-up logic.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateAnswerMessages,
  rewordQuestionMessages,
  checkCoverageMessages,
} from '../prompts/interview.js';

const baseArgs = {
  question: 'What did you work on this week?',
  answer: 'Mostly building an app.',
  criteria: ['Named at least one real activity.', 'Gave concrete substance.'],
};

test('evaluateAnswerMessages returns a [system, user] pair', () => {
  const msgs = evaluateAnswerMessages(baseArgs);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].role, 'user');
});

test('system prompt forbids leading questions (anti-leading rule present)', () => {
  const [system] = evaluateAnswerMessages(baseArgs);
  // The rule we added: the interviewer must not plant activities the
  // participant never mentioned. Keep this assertion broad enough to survive
  // light rewording but specific enough to catch the rule being dropped.
  assert.match(system.content, /NEVER LEAD/);
  assert.match(system.content, /hasn't already said|never an activity you've supplied/i);
});

test('user message embeds the question, the answer, and every criterion', () => {
  const [, user] = evaluateAnswerMessages(baseArgs);
  assert.match(user.content, /What did you work on this week\?/);
  assert.match(user.content, /Mostly building an app\./);
  for (const c of baseArgs.criteria) assert.ok(user.content.includes(c));
});

test('declares the JSON output contract', () => {
  const [system] = evaluateAnswerMessages(baseArgs);
  assert.match(system.content, /"allCovered"/);
  assert.match(system.content, /"followUp"/);
  assert.match(system.content, /"skipRequested"/);
});

test('carries the skip-detection rule (and protects real negative answers)', () => {
  const [system] = evaluateAnswerMessages(baseArgs);
  assert.match(system.content, /SKIP DETECTION/);
  // A bare "no"/"none" must NOT be treated as a skip — the rule says so.
  assert.match(system.content, /is NOT a skip/i);
});

test('minimum-follow-up block appears only when below the floor', () => {
  const below = evaluateAnswerMessages({ ...baseArgs, minFollowups: 2, followupCount: 0 });
  assert.match(below[1].content, /MINIMUM FOLLOW-UPS/);
  // ...and it forces another follow-up regardless of coverage.
  assert.match(below[1].content, /at least 2/);

  const met = evaluateAnswerMessages({ ...baseArgs, minFollowups: 2, followupCount: 2 });
  assert.doesNotMatch(met[1].content, /MINIMUM FOLLOW-UPS/);
});

test('conversation transcript is included only when provided', () => {
  const withConvo = evaluateAnswerMessages({
    ...baseArgs,
    conversation: 'Interviewer: hi\nParticipant: hello',
  });
  assert.match(withConvo[1].content, /THE CONVERSATION SO FAR/);
  assert.match(withConvo[1].content, /Participant: hello/);

  const without = evaluateAnswerMessages(baseArgs);
  assert.doesNotMatch(without[1].content, /THE CONVERSATION SO FAR/);
});

test('strict and lenient evaluation styles produce different guidance', () => {
  const strict = evaluateAnswerMessages({ ...baseArgs, evaluationStyle: 'strict' })[0].content;
  const lenient = evaluateAnswerMessages({ ...baseArgs, evaluationStyle: 'lenient' })[0].content;
  assert.notEqual(strict, lenient);
  assert.match(strict, /Apply the criteria as written/);
  assert.match(lenient, /lenient BY DEFAULT/);
});

test('rewordQuestionMessages preserves framing notes when given', () => {
  const framing = 'Keep the word "responsibilities"; do not swap in "duties".';
  const [system] = rewordQuestionMessages({
    canonicalQuestion: 'What are your primary responsibilities at work?',
    framingNotes: framing,
  });
  assert.match(system.content, /MUST preserve/);
  assert.ok(system.content.includes(framing));
});

test('rewordQuestionMessages omits the framing line when none given', () => {
  const [system] = rewordQuestionMessages({
    canonicalQuestion: 'What is your current role?',
  });
  assert.doesNotMatch(system.content, /Framing notes \(MUST preserve\)/);
  assert.match(system.content, /What is your current role\?/);
  assert.match(system.content, /"question"/);
});

test('checkCoverageMessages embeds the question + criteria and biases conservative', () => {
  const msgs = checkCoverageMessages({
    question: 'What do you produce or deliver?',
    criteria: ['Named at least one output.', 'Tasks behind it are clear.'],
    conversation: 'Interviewer: hi\nParticipant: I write the weekly report.',
  });
  assert.equal(msgs.length, 2);
  // Conservative by design: when in doubt, NOT covered (ask the question).
  assert.match(msgs[0].content, /covered=true/);
  assert.match(msgs[0].content, /CONSERVATIVE/);
  assert.match(msgs[0].content, /"covered"/);
  // The upcoming question, its criteria, and the transcript are all present.
  assert.match(msgs[1].content, /What do you produce or deliver\?/);
  assert.match(msgs[1].content, /Named at least one output\./);
  assert.match(msgs[1].content, /weekly report/);
});

test('checkCoverageMessages omits the transcript block when none given', () => {
  const [, user] = checkCoverageMessages({
    question: 'Q?',
    criteria: ['c'],
  });
  assert.doesNotMatch(user.content, /THE CONVERSATION SO FAR/);
});
