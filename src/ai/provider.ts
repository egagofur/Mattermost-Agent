export interface ThreadContextMessage {
  author: string;
  message: string;
  timestamp?: number;
}

export interface AIProvider {
  generate(prompt: string, context?: ThreadContextMessage[]): Promise<string>;
}

export interface OpenAIProviderOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export class OpenAIProvider implements AIProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private fetch: typeof fetch;

  constructor(options?: OpenAIProviderOptions) {
    this.apiKey = options?.apiKey || process.env.OPENAI_API_KEY || process.env.AI_API_KEY || '';
    this.model = options?.model || process.env.AI_MODEL || 'gpt-4o-mini';
    this.baseUrl = (options?.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.fetch = options?.fetchFn || globalThis.fetch;

    if (!this.apiKey) {
      throw new Error('OpenAIProvider requires an API key (OPENAI_API_KEY or AI_API_KEY).');
    }
  }

  public async generate(prompt: string, context: ThreadContextMessage[] = []): Promise<string> {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content: 'You are an intelligent AI assistant operating directly inside Mattermost. Provide clear, helpful, concise responses. Use markdown formatting where appropriate.',
      },
    ];

    // Append thread context if available
    if (context && context.length > 0) {
      const formattedContext = context
        .map((c) => `[${c.author}]: ${c.message}`)
        .join('\n');
      messages.push({
        role: 'user',
        content: `Thread conversation history:\n${formattedContext}\n\nCurrent instruction:\n${prompt}`,
      });
    } else {
      messages.push({
        role: 'user',
        content: prompt,
      });
    }

    const res = await this.fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.7,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI API returned status ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as any;
    const answer = data.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      throw new Error('OpenAI returned an empty response.');
    }

    return answer;
  }
}

export interface GeminiProviderOptions {
  apiKey?: string;
  model?: string;
  fetchFn?: typeof fetch;
}

export class GeminiProvider implements AIProvider {
  private apiKey: string;
  private model: string;
  private fetch: typeof fetch;

  constructor(options?: GeminiProviderOptions) {
    this.apiKey = options?.apiKey || process.env.GEMINI_API_KEY || process.env.AI_API_KEY || '';
    this.model = options?.model || process.env.AI_MODEL || 'gemini-1.5-flash';
    this.fetch = options?.fetchFn || globalThis.fetch;

    if (!this.apiKey) {
      throw new Error('GeminiProvider requires an API key (GEMINI_API_KEY or AI_API_KEY).');
    }
  }

  public async generate(prompt: string, context: ThreadContextMessage[] = []): Promise<string> {
    let fullPrompt = prompt;
    if (context && context.length > 0) {
      const formattedContext = context.map((c) => `[${c.author}]: ${c.message}`).join('\n');
      fullPrompt = `Thread conversation context:\n${formattedContext}\n\nCurrent instruction:\n${prompt}`;
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: fullPrompt }] }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API returned status ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as any;
    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!answer) {
      throw new Error('Gemini returned an empty response.');
    }

    return answer;
  }
}

export class MockAIProvider implements AIProvider {
  private handler?: (prompt: string, context?: ThreadContextMessage[]) => Promise<string> | string;

  constructor(handler?: (prompt: string, context?: ThreadContextMessage[]) => Promise<string> | string) {
    this.handler = handler;
  }

  public async generate(prompt: string, context: ThreadContextMessage[] = []): Promise<string> {
    if (this.handler) {
      return this.handler(prompt, context);
    }
    return `[AI Response] Processed prompt: "${prompt}". Context messages: ${context.length}.`;
  }
}

/**
 * Factory to create an AI provider instance based on configuration.
 */
export function createAIProvider(type: 'openai' | 'gemini' | 'mock' = 'mock', customApiKey?: string): AIProvider {
  if (type === 'openai') {
    return new OpenAIProvider({ apiKey: customApiKey });
  }
  if (type === 'gemini') {
    return new GeminiProvider({ apiKey: customApiKey });
  }
  return new MockAIProvider();
}
