const rows = new Map();
let calls = 0;
export function resetModelMetrics() { rows.clear(); calls = 0; }
export function beginModelCall(provider, model, task = "unspecified") {
    const limit = Number(process.env.MAX_LLM_REQUESTS_PER_RUN ?? 1000);
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid MAX_LLM_REQUESTS_PER_RUN");
    if (calls >= limit) throw new Error("LLM per-run request budget exhausted");
    calls++;
    const key = `${task}:${provider}:${model}`;
    if (!rows.has(key)) rows.set(key, { task, provider, model, requests: 0, completed: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 });
    rows.get(key).requests++;
    return key;
}
export function finishModelCall(key, usage = {}) {
    const row = rows.get(key);
    row.completed++;
    row.inputTokens += usage.prompt_tokens ?? usage.promptTokenCount ?? 0;
    row.outputTokens += usage.completion_tokens ?? usage.candidatesTokenCount ?? 0;
    row.reasoningTokens += usage.completion_tokens_details?.reasoning_tokens ?? usage.thoughtsTokenCount ?? 0;
}
export const getModelMetrics = () => ({ llmRequests: calls, models: [...rows.values()] });
