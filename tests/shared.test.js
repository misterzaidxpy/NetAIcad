const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt, parseAnswerLetters } = require('../shared.js');

test('buildPrompt formats a single-answer question with lettered options', () => {
  const prompt = buildPrompt('What is 2+2?', ['3', '4', '5'], false, 1);
  assert.match(prompt, /A\. 3/);
  assert.match(prompt, /B\. 4/);
  assert.match(prompt, /C\. 5/);
  assert.match(prompt, /Answer with only ONE letter:$/);
});

test('buildPrompt formats a multiple-answer question requiring N letters', () => {
  const prompt = buildPrompt('Pick two', ['a', 'b', 'c', 'd'], true, 2);
  assert.match(prompt, /EXACTLY 2 correct answer/);
  assert.match(prompt, /Answer with EXACTLY 2 letter\(s\) separated by commas:$/);
});

test('parseAnswerLetters extracts a single letter for single-answer questions', () => {
  const result = parseAnswerLetters('B', ['x', 'y', 'z'], false, 1);
  assert.equal(result, 1);
});

test('parseAnswerLetters extracts a single letter even with extra text around it', () => {
  const result = parseAnswerLetters('Letter C', ['x', 'y', 'z'], false, 1);
  assert.equal(result, 2);
});

test('parseAnswerLetters extracts multiple letters for multiple-answer questions', () => {
  const result = parseAnswerLetters('A,C', ['w', 'x', 'y', 'z'], true, 2);
  assert.deepEqual(result, [0, 2]);
});

test('parseAnswerLetters trims extra letters down to requiredAnswers', () => {
  const result = parseAnswerLetters('A,B,C', ['w', 'x', 'y', 'z'], true, 2);
  assert.deepEqual(result, [0, 1]);
});

test('parseAnswerLetters throws on a response with no valid letters', () => {
  assert.throws(() => parseAnswerLetters('42', ['x', 'y'], false, 1));
});
