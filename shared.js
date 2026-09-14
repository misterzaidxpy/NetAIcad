// shared.js - pure helper functions shared between the OpenAI/Gemini API
// code paths and the ChatGPT-web/Gemini-web automation code paths in
// background.js. Loaded into the service worker via importScripts('shared.js'),
// and requireable directly from Node for the tests in tests/shared.test.js.

function buildPrompt(question, options, isMultipleAnswer, requiredAnswers) {
  const letters = options.map((_, idx) => String.fromCharCode(65 + idx));
  const formattedOptions = options
    .map((opt, idx) => `${letters[idx]}. ${opt}`)
    .join('\n');
  const availableLetters = letters.join(', ');

  if (isMultipleAnswer) {
    return `IMPORTANT: This is a multiple-answer question. You MUST select EXACTLY ${requiredAnswers} correct answer(s). Not more, not less.

CRITICAL RULES:
1. You MUST provide EXACTLY ${requiredAnswers} letters
2. Separate letters with commas (e.g., "A,B" or "A,C,D")
3. Only use available letters: ${availableLetters}
4. No explanation, no extra text, no reasoning
5. ONLY output the ${requiredAnswers} correct letter(s)

Question: ${question}

Options:
${formattedOptions}

Answer with EXACTLY ${requiredAnswers} letter(s) separated by commas:`;
  }

  return `Answer this question with ONLY ONE letter from the available options: ${availableLetters}

CRITICAL RULES:
1. Output ONLY ONE letter
2. No explanation, no extra text
3. Only use available letters: ${availableLetters}

Question: ${question}

Options:
${formattedOptions}

Answer with only ONE letter:`;
}

function parseAnswerLetters(rawText, options, isMultipleAnswer, requiredAnswers) {
  const answerText = (rawText || '').trim().toUpperCase();
  const validLetters = options.map((_, idx) => String.fromCharCode(65 + idx)).join('');
  const validLetterPattern = new RegExp(`[${validLetters}]`, 'g');

  if (isMultipleAnswer) {
    const letterMatches = answerText.match(validLetterPattern);
    if (!letterMatches || letterMatches.length === 0) {
      throw new Error(`Invalid answer format. Expected letters from ${validLetters}, got: ${answerText}`);
    }
    const answerIndices = [...new Set(letterMatches)].map(letter => letter.charCodeAt(0) - 65);
    if (answerIndices.length > requiredAnswers) {
      answerIndices.splice(requiredAnswers);
    }
    return answerIndices;
  }

  const letterMatch = answerText.match(validLetterPattern);
  if (!letterMatch) {
    throw new Error(`Invalid answer format. Expected one letter from ${validLetters}, got: ${answerText}`);
  }
  return letterMatch[0].charCodeAt(0) - 65;
}

// Expose to Node for unit tests; ignored by the browser (module is undefined there).
if (typeof module !== 'undefined') {
  module.exports = { buildPrompt, parseAnswerLetters };
}
