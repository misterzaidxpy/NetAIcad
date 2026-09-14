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

function buildMatchingPrompt(rows) {
  const rowsFormatted = rows
    .map((row, idx) => {
      const optionsFormatted = row.options
        .map((opt, optIdx) => `   ${optIdx + 1}. ${opt}`)
        .join('\n');
      return `Row ${idx + 1}: "${row.prompt}"\nOptions for Row ${idx + 1}:\n${optionsFormatted}`;
    })
    .join('\n\n');

  return `This is a matching question. For each numbered row, pick the single best-matching option from that row's own option list.

CRITICAL RULES:
1. Output EXACTLY one line per row, in the format "Row N: <option text>"
2. Use the option text exactly as written in that row's list — do not paraphrase
3. No explanation, no extra text, no blank lines

${rowsFormatted}

Answer with one "Row N: <option text>" line per row:`;
}

function parseMatchingAnswer(rawText, rows) {
  const text = (rawText || '').trim();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const rowAnswers = [];

  rows.forEach((row, idx) => {
    const rowNumber = idx + 1;
    const linePattern = new RegExp(`^Row\\s*${rowNumber}\\s*:\\s*(.+)$`, 'i');
    const matchingLine = lines.find((l) => linePattern.test(l));
    if (!matchingLine) {
      throw new Error(`Could not find an answer for Row ${rowNumber} in the AI's response: ${text}`);
    }
    const rawOption = matchingLine.match(linePattern)[1].trim();
    const bestOption =
      row.options.find((opt) => opt.toLowerCase() === rawOption.toLowerCase()) ||
      row.options.find(
        (opt) =>
          rawOption.toLowerCase().includes(opt.toLowerCase()) ||
          opt.toLowerCase().includes(rawOption.toLowerCase())
      );
    if (!bestOption) {
      throw new Error(
        `AI's answer for Row ${rowNumber} ("${rawOption}") doesn't match any of that row's options: ${row.options.join(', ')}`
      );
    }
    rowAnswers.push({ index: idx, option: bestOption });
  });

  return rowAnswers;
}

// Expose to Node for unit tests; ignored by the browser (module is undefined there).
if (typeof module !== 'undefined') {
  module.exports = { buildPrompt, parseAnswerLetters, buildMatchingPrompt, parseMatchingAnswer };
}
