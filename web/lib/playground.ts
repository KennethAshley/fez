import { z } from 'zod';

// The TypeSafe /v1/systemone contract, also implemented by kev.serve.
const content = z.json();
const question = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), instructions: content.optional(), criteria: z.object({ true: content.optional(), false: content.optional() }).strict().optional() }).strict(),
  z.object({ type: z.literal('choice'), instructions: content.optional(), criteria: z.record(z.string().min(1).max(100), content).refine(v => Object.keys(v).length >= 1 && Object.keys(v).length <= 16, 'Use 1–16 choices.') }).strict(),
  z.object({ type: z.literal('score'), instructions: content.optional(), criteria: z.array(content).min(1).max(16) }).strict(),
]);
const requestSchema = z.object({
  state: content,
  model: z.string().min(1).max(200),
  questions: z.record(z.string().min(1).max(100), question).refine(v => Object.keys(v).length >= 1 && Object.keys(v).length <= 8, 'Use 1–8 questions.'),
}).strict();
const probability = z.number().min(0).max(1);
const distribution = z.record(z.string(), probability).refine(v => Object.keys(v).length > 0 && Math.abs(Object.values(v).reduce((a, b) => a + b, 0) - 1) < 0.02);
const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.discriminatedUnion('type', [
    z.object({ type: z.literal('noul'), noul: probability }),
    z.object({ type: z.literal('choice'), choice: z.string(), confidence: probability, probabilities: distribution }),
    z.object({ type: z.literal('score'), score: z.number().min(0), confidence: probability, probabilities: distribution, legend: z.record(z.string(), z.string()) }),
  ])),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
  latency_ms: z.number().nonnegative(),
});

export type DecisionRequest = z.infer<typeof requestSchema>;
export type DecisionResponse = z.infer<typeof responseSchema>;
export type Answer = DecisionResponse['answers'][string];
export type ModelOption = { id: string; label: string };

export function parseRequest(value: unknown): DecisionRequest {
  const result = requestSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`${issue.path.join('.') || 'Request'}: ${issue.message}`);
  }
  return result.data;
}

export function parseResponse(value: unknown, request: DecisionRequest): DecisionResponse {
  const result = responseSchema.parse(value);
  const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every(k => b.includes(k));
  if (!sameKeys(Object.keys(result.answers), Object.keys(request.questions))) throw new Error('Incomplete answers.');
  for (const [id, q] of Object.entries(request.questions)) {
    const a = result.answers[id];
    if (a.type !== q.type) throw new Error('Answer type mismatch.');
    if (a.type === 'choice' && q.type === 'choice') {
      if (!sameKeys(Object.keys(a.probabilities), Object.keys(q.criteria)) || !Object.hasOwn(a.probabilities, a.choice)) throw new Error('Choice mismatch.');
    }
    if (a.type === 'score' && q.type === 'score') {
      const keys = q.criteria.map((_, i) => String(i));
      if (!sameKeys(Object.keys(a.probabilities), keys) || !sameKeys(Object.keys(a.legend), keys) || a.score > keys.length - 1) throw new Error('Score mismatch.');
    }
  }
  return result;
}

export function editorRequest(state: string, questions: string, model: string): DecisionRequest {
  let parsedState: unknown = state;
  if (/^\s*[\[{]/.test(state)) {
    try { parsedState = JSON.parse(state); } catch { throw new Error('State starts with { or [ but is not valid JSON. Fix it or use plain text.'); }
  }
  let parsedQuestions: unknown;
  try { parsedQuestions = JSON.parse(questions); } catch { throw new Error('Questions must be valid JSON. Check quotes and commas.'); }
  return parseRequest({ state: parsedState, questions: parsedQuestions, model });
}

export const PRESETS: { name: string; description: string; state: DecisionRequest['state']; questions: DecisionRequest['questions'] }[] = [
  {
    name: 'Support triage', description: 'Route a customer request, check urgency, and score its tone.',
    state: 'My replacement headphones arrived yesterday, but the left ear does not work. This is the second broken pair. Please refund me instead of sending another replacement.',
    questions: {
      team: { type: 'choice', instructions: 'Which team should handle this request?', criteria: { returns: 'Faulty products, exchanges and refunds', shipping: 'Delivery tracking and missing parcels', billing: 'Duplicate charges and payment problems' } },
      resolution: { type: 'choice', instructions: 'What outcome does the customer want?', criteria: { refund: 'Return their money', replacement: 'Send another item', advice: 'Explain how to use the product' } },
      repeat_issue: { type: 'noul', instructions: 'Has the customer experienced this problem before?' },
      frustration: { type: 'score', instructions: 'How frustrated is the customer?', criteria: ['Calm', 'Frustrated', 'Very angry'] },
    },
  },
  {
    name: 'Agent routing', description: 'Choose the specialist for a task and decide whether it needs approval.',
    state: 'Review pull request #42 for accessibility issues. List any problems with keyboard navigation or screen-reader labels. Do not change files or merge the pull request.',
    questions: {
      specialist: { type: 'choice', instructions: 'Who is best suited to this task?', criteria: { reviewer: 'Reads code and reports issues', writer: 'Drafts documentation and marketing copy', researcher: 'Searches external sources for evidence' } },
      writes_allowed: { type: 'noul', instructions: 'Does the request authorize modifying files?' },
      merge_allowed: { type: 'noul', instructions: 'Does the request authorize merging the pull request?' },
    },
  },
  {
    name: 'Review rating', description: 'Turn a product review into an ordered score and a recommendation.',
    state: 'The lamp looks lovely and the brightness is perfect for reading. Assembly took five minutes. The switch feels a little flimsy, but at this price I would buy it again.',
    questions: {
      rating: { type: 'score', instructions: 'How positive is this review overall?', criteria: ['Very negative', 'Negative', 'Mixed', 'Positive', 'Very positive'] },
      recommends: { type: 'noul', instructions: 'Would this reviewer recommend buying the product?' },
    },
  },
  {
    name: 'Isolation probe', description: 'A secret appears in one question. Check whether a sibling question can see it.',
    state: 'The access code has not been provided in this document.',
    questions: {
      with_secret: { type: 'choice', instructions: 'The private access code is violet. Which code was provided in this question?', criteria: { violet: null, amber: null, unknown: null } },
      without_secret: { type: 'choice', instructions: 'What access code is provided in the document?', criteria: { violet: null, amber: null, unknown: null } },
    },
  },
];
