/**
 * The model behind the receptionist. Anthropic's Messages API in production; a scripted fake in
 * tests and when no key is configured (so nothing silently pretends to be a real model).
 */

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
export interface Msg { role: 'user' | 'assistant'; content: string | Block[] }
export interface ToolDef { name: string; description: string; input_schema: Record<string, unknown> }
export interface LlmRequest { model: string; system: string; messages: Msg[]; tools: ToolDef[]; maxTokens?: number }
export interface LlmResult { content: Block[]; stopReason: string; inputTokens: number; outputTokens: number; model: string }

export interface Llm {
  /** 'anthropic' for a real model; 'fake' for the scripted test model. */
  readonly kind: 'anthropic' | 'fake';
  complete(req: LlmRequest): Promise<LlmResult>;
}

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export class AnthropicLlm implements Llm {
  readonly kind = 'anthropic' as const;
  constructor(private readonly apiKey: string, private readonly baseUrl = 'https://api.anthropic.com', private readonly timeoutMs = 20_000) {}

  async complete(req: LlmRequest): Promise<LlmResult> {
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: req.model, system: req.system, messages: req.messages, tools: req.tools, max_tokens: req.maxTokens ?? 400 }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new LlmError(`Anthropic API ${res.status}: ${detail.slice(0, 300)}`, res.status);
    }
    const body = await res.json() as { content: Block[]; stop_reason: string; model: string; usage?: { input_tokens: number; output_tokens: number } };
    return { content: body.content, stopReason: body.stop_reason, model: body.model, inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 };
  }
}

export type FakeStep = (req: LlmRequest) => Block[] | string;

/**
 * Scripted model for tests. Each call takes the next step; a step returns the reply blocks
 * (or plain text). With no steps left it answers with a fixed line.
 */
export class FakeLlm implements Llm {
  readonly kind = 'fake' as const;
  readonly requests: LlmRequest[] = [];
  private steps: FakeStep[] = [];
  script(...steps: (FakeStep | string | Block[])[]) {
    this.steps = steps.map((s) => (typeof s === 'function' ? s : () => s));
    return this;
  }
  async complete(req: LlmRequest): Promise<LlmResult> {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift();
    const out = step ? step(req) : 'Thank you for calling. How else can I help?';
    const content: Block[] = typeof out === 'string' ? [{ type: 'text', text: out }] : out;
    return { content, stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', inputTokens: 10, outputTokens: 5, model: 'fake' };
  }
  /** Helper: a tool call block. */
  static tool(name: string, input: Record<string, unknown>): Block {
    return { type: 'tool_use', id: `tu_${name}_${Math.random().toString(36).slice(2, 8)}`, name, input };
  }
}
