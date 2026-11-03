/**
 * Safe Meta API verification.
 *
 * By default this script makes an authenticated model-list request only. It
 * does not run inference and therefore does not consume generation credits.
 *
 *   npm run verify:meta             # auth + model listing only
 *   npm run verify:meta -- --infer  # one short inference call (may cost credits)
 *
 * The API key is read from the server environment and is never printed.
 */
import OpenAI from "openai";
import { TEMPU_ROUTE_NUMBERS } from "../shared/routes";
import { createMetaClient } from "../ai/meta-client";
import { MetaAIService } from "../ai/service";
import { config } from "../config";

const argumentsSet = new Set(process.argv.slice(2));
const allowInference = argumentsSet.has("--infer");

async function main(): Promise<void> {
  if (!config.modelApiKey) {
    console.error("MODEL_API_KEY is not set. Add it to server/.env first.");
    process.exitCode = 1;
    return;
  }

  console.log(`Base URL: ${config.metaBaseUrl}`);
  console.log(`Requested model: ${config.metaModel}`);
  console.log("MODEL_API_KEY: present (not displayed)");

  const client = new OpenAI({
    apiKey: config.modelApiKey,
    baseURL: config.metaBaseUrl,
    timeout: config.aiTimeoutMs,
    maxRetries: 0,
  });

  const page = await client.models.list();
  const modelIds = page.data.map((model) => model.id);
  console.log(`Authenticated model listing: ${modelIds.length} model(s) visible.`);

  if (modelIds.length > 0) {
    console.log(`Visible models: ${modelIds.join(", ")}`);
  }

  if (!modelIds.includes(config.metaModel)) {
    console.warn(
      `Warning: "${config.metaModel}" was not present in the visible model list.`
    );
  }

  if (!allowInference) {
    console.log(
      "No inference call was made. Re-run with -- --infer to send one short question (may use provider credits)."
    );
    return;
  }

  console.log("Inference test requested: this may consume provider credits.");
  const service = new MetaAIService({
    client: createMetaClient({
      apiKey: config.modelApiKey,
      baseUrl: config.metaBaseUrl,
      timeoutMs: config.aiTimeoutMs,
    }),
    model: config.metaModel,
    baseUrl: config.metaBaseUrl,
    maxOutputTokens: config.aiMaxOutputTokens,
    timeoutMs: config.aiTimeoutMs,
    allowedRouteNumbers: TEMPU_ROUTE_NUMBERS,
  });

  const result = await service.ask({
    message: "রুট ১১-এ সিডিএ কীভাবে যাব?",
    language: "bn",
    liveSummary: {
      liveDataAvailable: true,
      totalFresh: 0,
      staleHidden: 0,
      byRoute: [],
      serverTime: new Date().toISOString(),
    },
  });

  console.log(`Model: ${result.model}`);
  console.log("Answer:");
  console.log(result.answer);
}

main().catch((error: unknown) => {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  const message = error instanceof Error ? error.message : "Unknown error";

  console.error(
    `Meta verification failed${typeof status === "number" ? ` (HTTP ${status})` : ""}${
      typeof code === "string" ? ` [${code}]` : ""
    }: ${message}`
  );
  process.exitCode = 1;
});
