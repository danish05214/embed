import { config } from "../config.js";
import { openai } from "./client.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function complete(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number } = {}) {
  const res = await openai.chat.completions.create({
    model: config.azureOpenAI.llmDeployment,
    messages,
    temperature: opts.temperature ?? 0.1,
    max_tokens: opts.maxTokens ?? 1200,
  });
  return {
    text: res.choices[0]?.message?.content ?? "",
    usage: res.usage
      ? { promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens }
      : undefined,
  };
}
