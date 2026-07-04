import dotenv from 'dotenv';
dotenv.config();

// Store active quizzes in memory: map of canonicalId -> quizData
export const activeQuizzes = new Map();

/**
 * Generate a quiz question on a specific topic using OpenRouter API.
 * Returns an object with { task, options, correctIndex }
 */
export async function generateQuizQuestion(topic) {
  const openrouterApiKey = process.env.OPENROUTER_API_KEY;
  if (!openrouterApiKey) throw new Error('API Key missing');

  const isOfficialOpenAI = openrouterApiKey.startsWith('sk-proj-') || openrouterApiKey.startsWith('sk-') && !openrouterApiKey.startsWith('sk-or-');
  const apiUrl = isOfficialOpenAI ? 'https://api.openai.com/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions';
  const openrouterModel = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  const actualModel = isOfficialOpenAI && openrouterModel.startsWith('openai/') ? openrouterModel.replace('openai/', '') : openrouterModel;

  const prompt = `Generate a multiple-choice question about "${topic}" at an intermediate level. 
Output exactly and ONLY valid JSON with this structure:
{
  "task": "The question text here",
  "options": ["Option 1", "Option 2", "Option 3", "Option 4"],
  "correctIndex": 0 // The 0-based index of the correct option (0, 1, 2, or 3)
}`;

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openrouterApiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/gurpreetsinghguru77/whatsab-bot',
      'X-Title': 'WhatsApp AI Assistant'
    },
    body: JSON.stringify({
      model: actualModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) {
    throw new Error('Failed to generate question from AI');
  }

  const data = await response.json();
  const resultJson = JSON.parse(data.choices[0].message.content);
  return resultJson;
}

/**
 * Evaluate a user's answer using RapidAPI.
 */
export async function evaluateAnswer(quizData, userAnswerIndex) {
  const rapidApiKey = '565178fa95mshf88c1b7a51a8608p1dbf07jsnc6011923ae96';
  
  const response = await fetch('https://ai-learning-engine-task-creation-auto-grading-api.p.rapidapi.com/check-answer.php', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-rapidapi-host': 'ai-learning-engine-task-creation-auto-grading-api.p.rapidapi.com',
      'x-rapidapi-key': rapidApiKey
    },
    body: JSON.stringify({
      type: 'test',
      level: 'intermediate',
      topic: 'General',
      task: quizData.task,
      lang: 'English',
      options: quizData.options,
      correctIndex: quizData.correctIndex,
      explanation: 'Evaluating answer via AI learning engine...',
      userAnswer: userAnswerIndex
    })
  });

  if (!response.ok) {
    throw new Error('Failed to reach grading API');
  }

  const result = await response.json();
  return result.data;
}
