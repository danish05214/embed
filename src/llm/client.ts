import OpenAI from "openai";
import { config } from "../config.js";

/**
 * Azure OpenAI via its v1 (OpenAI-compatible) API.
 * AZURE_OPENAI_ENDPOINT should be the v1 base URL, e.g. https://<resource>.openai.azure.com/openai/v1
 * The `model` parameter in each call is the Azure *deployment name*.
 */
export const openai = new OpenAI({
  baseURL: config.azureOpenAI.endpoint,
  apiKey: config.azureOpenAI.apiKey,
  defaultHeaders: { "api-key": config.azureOpenAI.apiKey },
  maxRetries: 5, // built-in exponential backoff for 429 / 5xx
  timeout: 60_000,
});
