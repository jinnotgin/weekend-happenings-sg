// Shared bounded downloads, including the response body (not just headers).
export async function fetchBytes(url, { maxBytes = 5 * 1024 * 1024, timeoutMs = 30000, ...options } = {}) {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only HTTP(S) URLs are supported");
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
        await response.body?.cancel();
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        error.retryAfter = response.headers.get("retry-after");
        throw error;
    }
    if (Number(response.headers.get("content-length")) > maxBytes) {
        await response.body?.cancel();
        throw new Error("Response exceeds download limit");
    }
    const parts = [];
    let size = 0;
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) throw new Error("Response exceeds download limit");
        parts.push(chunk);
    }
    return { bytes: Buffer.concat(parts), contentType: response.headers.get("content-type"), url: response.url };
}
