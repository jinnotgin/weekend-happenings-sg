import { beginModelCall, finishModelCall } from "#lib/model-metrics.js";
import OpenAI from "openai";
import logger from "#lib/logger.js";
import { OPENAI, OPENROUTER, NIM } from "#lib/constants.js";

const configs = {
    openai: { env: "OPENAI_API_KEY", model: OPENAI.MODEL_GPT5_6_LUNA },
    openrouter: { env: "OPENROUTER_API_KEY", baseURL: "https://openrouter.ai/api/v1", model: OPENROUTER.MODELS_FAST.GEMMA_4_31B_FREE },
    nim: { env: "NIM_API_KEY", baseURL: "https://integrate.api.nvidia.com/v1", model: NIM.MODELS_FAST.GEMMA_4_31B },
};

export function buildChatRequest(provider, promptStr = "", options = {}) {
    const model = options.model ?? configs[provider]?.model;
    if (!model) throw new Error(`Unknown chat provider: ${provider}`);
    const schema = options.responseSchema?.schema ?? options.responseSchema;
    const jsonInstruction = schema
        ? `Return ONLY one complete JSON object satisfying this schema: ${JSON.stringify(schema)}. No markdown or commentary.`
        : "Return ONLY one complete JSON object. No markdown or commentary.";
    const messages = options.messages?.length
        ? structuredClone(options.messages)
        : [{ role: "system", content: options.systemMessage ?? "" }, { role: "user", content: promptStr }];
    const system = messages.find(m => m.role === "system");
    if (system) system.content = `${system.content}\n${jsonInstruction}`;
    else messages.unshift({ role: "system", content: jsonInstruction });
    const moderateReasoning = ["UNIQUE_EVENTS", "CONSOLIDATE_EVENTS"].includes(options.task);
    const maxTokens = options.maxOutputTokens ?? 16384;
    const request = { model, messages };
    // uniqueItems is checked by our local validator; OpenAI's strict schema
    // subset does not support it. Do not mutate the canonical schema.
    const transportSchema = schema ? JSON.parse(JSON.stringify(schema, (key, value) => key === "uniqueItems" ? undefined : value)) : undefined;
    // NIM Gemma's published contract has no response_format parameter. Include
    // the full schema in the prompt and validate locally for every provider.
    if (provider !== "nim") {
        request.response_format = options.responseFormat ?? (
            schema && !model.endsWith(":free")
                ? { type: "json_schema", json_schema: { name: options.responseSchema?.name ?? "StructuredJson", schema: transportSchema, strict: true } }
                : { type: "json_object" }
        );
    }
    if (provider === "openai") {
        request.max_completion_tokens = maxTokens;
        request.reasoning_effort = options.reasoningEffort ?? (moderateReasoning ? "medium" : "none");
        // Do not forward temperature/top_p/penalties to reasoning routes.
    } else {
        request.max_tokens = maxTokens;
        if (provider === "nim") {
            request.chat_template_kwargs = { enable_thinking: moderateReasoning };
            // Some NIM Gemma deployments reject a separate system role.
            const instructions = messages.filter(m => m.role === "system").map(m => m.content).join("\n");
            request.messages = messages.filter(m => m.role !== "system");
            const user = request.messages.find(m => m.role === "user");
            if (typeof user?.content === "string") user.content = `${instructions}\n\n${user.content}`;
            else if (Array.isArray(user?.content)) user.content.unshift({ type: "text", text: instructions });
        } else {
            request.reasoning = model.includes("gpt-oss")
                ? { effort: moderateReasoning ? "medium" : "low" }
                : { enabled: moderateReasoning };
            if (schema && !model.endsWith(":free")) request.provider = { require_parameters: true };
        }
    }
    return request;
}

export async function generateChatJson(provider, promptStr, options = {}) {
    const config = configs[provider];
    const apiKey = process.env[config.env];
    if (!apiKey) throw new Error(`Missing ${config.env}`);
    const client = new OpenAI({ apiKey, baseURL: config.baseURL, timeout: 20 * 60 * 1000, maxRetries: 0, fetch: globalThis.fetch });
    const request = buildChatRequest(provider, promptStr, options);
    const metric = beginModelCall(provider, request.model, options.task);
    const started = Date.now();
    const completion = await client.chat.completions.create(request);
    finishModelCall(metric, completion.usage);
    const choice = completion.choices?.[0];
    logger.info("LLM request completed", { provider, model: completion.model ?? request.model, task: options.task, latencyMs: Date.now() - started, usage: completion.usage, finishReason: choice?.finish_reason });
    if (choice?.finish_reason !== "stop" || choice?.message?.refusal) {
        throw new Error(`${provider}: incomplete or refused response (${choice?.finish_reason})`);
    }
    const text = choice?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error(`${provider}: empty response`);
    return text;
}
