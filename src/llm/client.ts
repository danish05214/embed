import OpenAI from "openai";
import { config } from "../config.js";

export const openai = new OpenAI({
  baseURL: config.azureOpenAI.endpoint,
  apiKey: config.azureOpenAI.apiKey,
  defaultHeaders: { "api-key": config.azureOpenAI.apiKey },
  maxRetries: 5, /
  timeout: 60_000,
});
