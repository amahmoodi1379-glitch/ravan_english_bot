// OpenAI GPT-5.4-mini integration for automatic question generation

export interface GeneratedQuestion {
  questionText: string;
  options: [string, string, string, string];
  correctIndex: number;
  questionStyle: "en_to_fa" | "fa_to_en" | "definition_to_word" | "word_to_definition" | "cloze";
  explanation: string;
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

function buildPrompt(english: string, persian: string): string {
  return `Role: You are an expert ESL exam creator specializing in A2 (Elementary) level content.

Input Data:
- Target Word: "${english}"
- Persian Meaning: "${persian}"

Task: Generate exactly 8 multiple-choice questions based on the Input Data. The difficulty level must be strictly A2.

Question Distribution & Style Mapping:
1. Style "en_to_fa": 1 Question (English word given, find Persian meaning).
2. Style "fa_to_en": 1 Question (Persian meaning given, find English word).
3. Style "definition_to_word": 2 Questions (Definition given, find the word).
4. Style "word_to_definition": 2 Questions (Word given, find the definition).
5. Style "cloze": 2 Questions (Fill in the blank sentence).

Strict Guidelines:
- Level A2: Keep definitions and sentences simple.
- NO GRAMMAR: Strictly avoid testing grammar rules. Do not create questions where the distractors are just different verb tenses or grammatical forms. The focus must be 100% on vocabulary and the meaning of the target word.
- Variety: Ensure the definitions and sentences in styles 3, 4, and 5 are unique and different from each other.
- Distractors: Must be incorrect but plausible (same part of speech).
- Correct Index: You must calculate the index (0, 1, 2, or 3) of the correct answer within the options array.

Output Format:
Provide the result in a valid JSON array where each object contains strictly these keys:
- "questionText" (string): The question stem.
- "options" (array of 4 strings): The choices.
- "correctIndex" (integer): 0 for the first option, 1 for the second, etc.
- "questionStyle" (string): Must be exactly one of: "en_to_fa", "fa_to_en", "definition_to_word", "word_to_definition", "cloze".
- "explanation" (string): A very short explanation (e.g., "Seed implies a small object...").

Example JSON Structure:
[
  {
    "questionText": "What is the meaning of '${english}'?",
    "options": ["Persian A", "Persian B", "Persian C", "Persian D"],
    "correctIndex": 2,
    "questionStyle": "en_to_fa",
    "explanation": "'${english}' translates to Persian C."
  }
]`;
}

export async function generateWordQuestions(
  apiKey: string,
  english: string,
  persian: string,
  level: number
): Promise<{ questions: GeneratedQuestion[]; tokenUsage?: { input: number; output: number } }> {
  const prompt = buildPrompt(english, persian);

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini-2026-03-17",
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant that generates ESL vocabulary questions in valid JSON format only."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: 2000,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
  }

  const data: OpenAIResponse = await response.json();
  
  if (!data.choices || data.choices.length === 0) {
    throw new Error("OpenAI API returned no choices");
  }

  const content = data.choices[0].message.content;
  
  // Extract JSON from response (handle both plain JSON and markdown code blocks)
  let jsonStr = content;
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1];
  }

  let questions: GeneratedQuestion[];
  try {
    questions = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`Failed to parse JSON response: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Validate questions
  if (!Array.isArray(questions)) {
    throw new Error("Response is not an array");
  }

  for (const q of questions) {
    if (!q.questionText || !Array.isArray(q.options) || q.options.length !== 4 || 
        typeof q.correctIndex !== "number" || !q.questionStyle) {
      throw new Error("Invalid question structure in response");
    }
    if (q.correctIndex < 0 || q.correctIndex > 3) {
      throw new Error("Invalid correctIndex value");
    }
  }

  return {
    questions,
    tokenUsage: data.usage ? {
      input: data.usage.prompt_tokens,
      output: data.usage.completion_tokens,
    } : undefined,
  };
}
