const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt, parseAnswerLetters, buildMatchingPrompt, parseMatchingAnswer } = require('../shared.js');

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

test('buildMatchingPrompt formats each row with its own numbered option list', () => {
  const prompt = buildMatchingPrompt([
    { prompt: 'Organized Crime', options: ['Financially motivated group', 'Government-backed group'] },
    { prompt: 'Hacktivist', options: ['Politically motivated individual', 'Insider employee'] },
  ]);
  assert.match(prompt, /Row 1: "Organized Crime"/);
  assert.match(prompt, /1\. Financially motivated group/);
  assert.match(prompt, /2\. Government-backed group/);
  assert.match(prompt, /Row 2: "Hacktivist"/);
  assert.match(prompt, /Answer with one "Row N: <option text>" line per row:$/);
});

test('parseMatchingAnswer maps each row to its answered option', () => {
  const rows = [
    { options: ['Financially motivated group', 'Government-backed group'] },
    { options: ['Politically motivated individual', 'Insider employee'] },
  ];
  const rawText = 'Row 1: Financially motivated group\nRow 2: Politically motivated individual';
  const result = parseMatchingAnswer(rawText, rows);
  assert.deepEqual(result, [
    { index: 0, option: 'Financially motivated group' },
    { index: 1, option: 'Politically motivated individual' },
  ]);
});

test('parseMatchingAnswer is case-insensitive and tolerates surrounding whitespace', () => {
  const rows = [{ options: ['Alpha', 'Beta'] }];
  const result = parseMatchingAnswer('  row 1:   alpha  ', rows);
  assert.deepEqual(result, [{ index: 0, option: 'Alpha' }]);
});

test('parseMatchingAnswer throws when a row is missing from the response', () => {
  const rows = [{ options: ['Alpha'] }, { options: ['Beta'] }];
  assert.throws(() => parseMatchingAnswer('Row 1: Alpha', rows), /Row 2/);
});

test('parseMatchingAnswer throws when the answered text matches none of that row\'s options', () => {
  const rows = [{ options: ['Alpha', 'Beta'] }];
  assert.throws(() => parseMatchingAnswer('Row 1: Gamma', rows), /doesn't match any/);
});
