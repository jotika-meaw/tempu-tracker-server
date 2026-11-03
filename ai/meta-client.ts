import OpenAI from "openai";
import type { MetaClient } from "./service";

type MetaClientOptions = {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
};

export function createMetaClient(options: MetaClientOptions): MetaClient {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    timeout: options.timeoutMs,
    maxRetries: 0,
  });

  return {
    async create(params) {
      const response = await client.responses.create({
        model: params.model,
        instructions: params.instructions,
        input: params.input,
        store: params.store,
        max_output_tokens: params.max_output_tokens,
      });

      return { output_text: response.output_text };
    },
  };
}
