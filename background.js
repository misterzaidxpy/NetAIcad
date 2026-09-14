// Background service worker for handling AI API requests

const SYSTEM_PROMPT = `SYSTEM:
You are an AI assistant that answers multiple-choice questions with extreme precision.

CRITICAL RULES - YOU MUST FOLLOW THESE EXACTLY:
1. Think carefully before answering; simulate code or calculate math internally
2. ONLY output the letter(s) specified in the prompt (e.g., A, B, C, D, E, F)
3. If asked for ONE letter, provide EXACTLY ONE letter
4. If asked for N letters, provide EXACTLY N letters separated by commas
5. NEVER include explanations, reasoning, punctuation, or extra text
6. NEVER output more or fewer letters than requested
7. Follow the EXACT format specified in the user prompt

Your response must contain ONLY the requested letter(s) and nothing else.
End.
`
const temperature = 0;
const top_p = 1.0;
const max_tokens = 2000; // Increased for Gemini compatibility
const presence_penalty = 0;
const frequency_penalty = 0;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getAnswer') {
    handleGetAnswer(
      request.question,
      request.options,
      request.modelType,
      request.isMultipleAnswer,
      request.requiredAnswers
    )
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep message channel open for async response
  }
});

async function handleGetAnswer(question, options, modelType, isMultipleAnswer = false, requiredAnswers = 1) {
  try {
    // Get settings from storage
    const settings = await chrome.storage.sync.get([
      'geminiApiKey',
      'openAiApiKey'
    ]);

    let answerIndex;

    if (modelType === 'gpt') {
      const apiKey = settings.openAiApiKey;
      if (!apiKey) {
        throw new Error('OpenAI API key not configured. Please set it in the extension popup.');
      }
      answerIndex = await getAnswerFromOpenAI(question, options, apiKey, isMultipleAnswer, requiredAnswers);
    } else if (modelType === 'gemini') {
      const apiKey = settings.geminiApiKey;
      if (!apiKey) {
        throw new Error('Gemini API key not configured. Please set it in the extension popup.');
      }
      answerIndex = await getAnswerFromGemini(question, options, apiKey, isMultipleAnswer, requiredAnswers);
    } else {
      throw new Error('Unknown model type: ' + modelType);
    }

    return { success: true, answerIndex: answerIndex };
  } catch (error) {
    console.error('Error getting answer:', error);
    return { success: false, error: error.message };
  }
}

async function getAnswerFromGemini(question, options, apiKey, isMultipleAnswer = false, requiredAnswers = 1) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  // Format options with letters (dynamically handle any number of options)
  const formattedOptions = options.map((opt, idx) =>
    `${String.fromCharCode(65 + idx)}. ${opt}`
  ).join('\n');

  // Get the available option letters dynamically
  const availableLetters = options.map((_, idx) => String.fromCharCode(65 + idx)).join(', ');

  let prompt;
  if (isMultipleAnswer) {
    prompt = `IMPORTANT: This is a multiple-answer question. You MUST select EXACTLY ${requiredAnswers} correct answer(s). Not more, not less.

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
  } else {
    prompt = `Answer this question with ONLY ONE letter from the available options: ${availableLetters}

CRITICAL RULES:
1. Output ONLY ONE letter
2. No explanation, no extra text
3. Only use available letters: ${availableLetters}

Question: ${question}

Options:
${formattedOptions}

Answer with only ONE letter:`;
  }

  const requestBody = {
    contents: [{
      parts: [{
        text: prompt
      }]
    }],
    generationConfig: {
      temperature: temperature,
      topP: top_p,
      maxOutputTokens: max_tokens
    },
    safetySettings: [
      {
        category: "HARM_CATEGORY_HARASSMENT",
        threshold: "BLOCK_NONE"
      },
      {
        category: "HARM_CATEGORY_HATE_SPEECH",
        threshold: "BLOCK_NONE"
      },
      {
        category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        threshold: "BLOCK_NONE"
      },
      {
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: "BLOCK_NONE"
      }
    ]
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  const data = await response.json();
  console.log('Gemini raw response:', data);
  console.log('Response status:', response.status, response.statusText);

  if (!response.ok) {
    console.error('Gemini API error response:', data);
    throw new Error(`Gemini API error: ${data.error?.message || response.statusText}`);
  }

  console.log('Gemini API response (formatted):', JSON.stringify(data, null, 2));

  // Check if response has the expected structure
  if (!data || typeof data !== 'object' || !data.candidates || data.candidates.length === 0) {
    console.error('Unexpected Gemini response structure:', data);
    console.error('data.candidates:', data.candidates);
    throw new Error('Gemini returned no candidates or an invalid response structure. Full response: ' + JSON.stringify(data));
  }

  // Log the candidate structure for debugging
  console.log('First candidate structure:', JSON.stringify(data.candidates[0], null, 2));

  // Check if content was blocked by safety filters (but MAX_TOKENS is OK if we have content)
  const candidate = data.candidates[0];
  const blockingReasons = ['SAFETY', 'RECITATION', 'OTHER'];

  if (candidate.finishReason && blockingReasons.includes(candidate.finishReason)) {
    console.error('Gemini blocked or filtered the response. Finish reason:', candidate.finishReason);
    console.error('Safety ratings:', candidate.safetyRatings);
    throw new Error(`Gemini blocked the response. Reason: ${candidate.finishReason}. This might be due to content filters.`);
  }

  // Log finish reason for debugging
  if (candidate.finishReason) {
    console.log('Gemini finish reason:', candidate.finishReason);
  }

  const answerText = data.candidates[0]?.content?.parts?.[0]?.text?.trim().toUpperCase();

  if (!answerText) {
    console.error('Could not extract answer text from candidate:', data.candidates[0]);
    console.error('Content:', data.candidates[0]?.content);
    console.error('Parts:', data.candidates[0]?.content?.parts);

    // More detailed error message
    let errorDetails = 'No answer received from Gemini. ';
    if (!data.candidates[0]?.content) {
      errorDetails += 'Response has no content. ';
    } else if (!data.candidates[0]?.content?.parts) {
      errorDetails += 'Content has no parts. ';
    } else if (!data.candidates[0]?.content?.parts?.[0]) {
      errorDetails += 'Parts array is empty. ';
    } else if (!data.candidates[0]?.content?.parts?.[0]?.text) {
      errorDetails += 'First part has no text. ';
    }
    errorDetails += 'Full response: ' + JSON.stringify(data.candidates[0]);

    throw new Error(errorDetails);
  }

  console.log('Gemini answer text:', answerText);

  // Get valid letters based on number of options
  const maxOptionIndex = options.length - 1;
  const validLetters = options.map((_, idx) => String.fromCharCode(65 + idx)).join('');
  const validLetterPattern = new RegExp(`[${validLetters}]`, 'g');

  if (isMultipleAnswer) {
    // Extract multiple letters from response (handles "A,B", "A, B", "A,C,D", etc.)
    const letterMatches = answerText.match(validLetterPattern);
    if (!letterMatches || letterMatches.length === 0) {
      throw new Error(`Invalid answer format from Gemini. Expected letters from ${validLetters}, got: ${answerText}`);
    }

    // Convert letters to indices and remove duplicates
    const answerIndices = [...new Set(letterMatches)].map(letter => letter.charCodeAt(0) - 65);

    // Validate we have the correct number of answers
    if (answerIndices.length !== requiredAnswers) {
      console.warn(`⚠️ Gemini returned ${answerIndices.length} answers but ${requiredAnswers} were required. Trying to adjust...`);

      // If we have too many, take the first N
      if (answerIndices.length > requiredAnswers) {
        answerIndices.splice(requiredAnswers);
        console.log(`✂️ Trimmed to first ${requiredAnswers} answers:`, answerIndices);
      } else {
        // If we have too few, warn but continue
        console.warn(`⚠️ Using ${answerIndices.length} answers instead of ${requiredAnswers}`);
      }
    }

    console.log('Gemini answers:', letterMatches.join(','), 'Indices:', answerIndices);
    return answerIndices;
  } else {
    // Extract single letter from response (handles "A", "A.", "Answer: A", etc.)
    const letterMatch = answerText.match(validLetterPattern);
    if (!letterMatch) {
      throw new Error(`Invalid answer format from Gemini. Expected one letter from ${validLetters}, got: ${answerText}`);
    }

    const answerLetter = letterMatch[0];
    const answerIndex = answerLetter.charCodeAt(0) - 65; // Convert A->0, B->1, etc.

    console.log('Gemini answer:', answerLetter, 'Index:', answerIndex);
    return answerIndex;
  }
}

async function getAnswerFromOpenAI(question, options, apiKey, isMultipleAnswer = false, requiredAnswers = 1) {
  const url = 'https://api.openai.com/v1/chat/completions';

  // Format options with letters (dynamically handle any number of options)
  const formattedOptions = options.map((opt, idx) =>
    `${String.fromCharCode(65 + idx)}. ${opt}`
  ).join('\n');

  // Get the available option letters dynamically
  const availableLetters = options.map((_, idx) => String.fromCharCode(65 + idx)).join(', ');

  let prompt;
  if (isMultipleAnswer) {
    prompt = `IMPORTANT: This is a multiple-answer question. You MUST select EXACTLY ${requiredAnswers} correct answer(s). Not more, not less.

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
  } else {
    prompt = `Answer this question with ONLY ONE letter from the available options: ${availableLetters}

CRITICAL RULES:
1. Output ONLY ONE letter
2. No explanation, no extra text
3. Only use available letters: ${availableLetters}

Question: ${question}

Options:
${formattedOptions}

Answer with only ONE letter:`;
  }

  const requestBody = {
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: SYSTEM_PROMPT
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    temperature: temperature,
    top_p: top_p,
    max_tokens: max_tokens,
    presence_penalty: presence_penalty,
    frequency_penalty: frequency_penalty,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestBody)
  });

  const data = await response.json();

  console.log('OpenAI full response:', JSON.stringify(data, null, 2));
  console.log('Response status:', response.status, response.statusText);

  if (!response.ok) {
    console.error('OpenAI API error response:', data);
    throw new Error(`OpenAI API error: ${data.error?.message || response.statusText}`);
  }

  const rawContent = data.choices?.[0]?.message?.content;
  const answerText = rawContent?.trim().toUpperCase();

  if (!answerText) {
    console.error('Empty or undefined answer text from OpenAI');
    console.error('Raw content:', rawContent);
    console.error('Finish reason:', data.choices?.[0]?.finish_reason);
    console.error('Full response data:', JSON.stringify(data, null, 2));

    let errorDetails = 'No answer received from OpenAI. ';
    if (!data.choices) {
      errorDetails += 'Response has no choices array. ';
    } else if (data.choices.length === 0) {
      errorDetails += 'Choices array is empty. ';
    } else if (!data.choices[0].message) {
      errorDetails += 'First choice has no message. ';
    } else if (!data.choices[0].message.content) {
      errorDetails += 'Message has no content. ';
    } else if (data.choices[0].message.content.trim() === '') {
      errorDetails += 'Message content is empty/whitespace. ';
    }

    if (data.choices[0]?.finish_reason === 'length') {
      errorDetails += 'Response was cut off due to token limit. ';
    }

    errorDetails += 'Full response: ' + JSON.stringify(data);
    throw new Error(errorDetails);
  }

  console.log('OpenAI raw answer:', answerText);

  // Get valid letters based on number of options
  const maxOptionIndex = options.length - 1;
  const validLetters = options.map((_, idx) => String.fromCharCode(65 + idx)).join('');
  const validLetterPattern = new RegExp(`[${validLetters}]`, 'g');

  if (isMultipleAnswer) {
    // Extract multiple letters from response (handles "A,B", "A, B", "A,C,D", etc.)
    const letterMatches = answerText.match(validLetterPattern);
    if (!letterMatches || letterMatches.length === 0) {
      throw new Error(`Invalid answer format from OpenAI. Expected letters from ${validLetters}, got: ${answerText}`);
    }

    // Convert letters to indices and remove duplicates
    const answerIndices = [...new Set(letterMatches)].map(letter => letter.charCodeAt(0) - 65);

    // Validate we have the correct number of answers
    if (answerIndices.length !== requiredAnswers) {
      console.warn(`⚠️ OpenAI returned ${answerIndices.length} answers but ${requiredAnswers} were required. Trying to adjust...`);

      // If we have too many, take the first N
      if (answerIndices.length > requiredAnswers) {
        answerIndices.splice(requiredAnswers);
        console.log(`✂️ Trimmed to first ${requiredAnswers} answers:`, answerIndices);
      } else {
        // If we have too few, warn but continue
        console.warn(`⚠️ Using ${answerIndices.length} answers instead of ${requiredAnswers}`);
      }
    }

    console.log('OpenAI answers:', letterMatches.join(','), 'Indices:', answerIndices, 'Model: gpt-4o-mini');
    return answerIndices;
  } else {
    // Extract single letter from response
    const letterMatch = answerText.match(validLetterPattern);
    if (!letterMatch) {
      throw new Error(`Invalid answer format from OpenAI. Expected one letter from ${validLetters}, got: ${answerText}`);
    }

    const answerLetter = letterMatch[0];
    const answerIndex = answerLetter.charCodeAt(0) - 65;

    console.log('OpenAI answer:', answerLetter, 'Index:', answerIndex, 'Model: gpt-4o-mini');
    return answerIndex;
  }
}

