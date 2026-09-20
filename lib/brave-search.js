import path from "node:path";
import { nanoid } from "nanoid";
import imageType from "image-type";
import logger from "#lib/logger.js";
import { fetchBytes } from "#lib/http.js";
import { fetchOgImage } from "#lib/fetch-og-image.js";
import { saveAs, getDirectoryPath } from "#lib/diskio.js";
import { IMAGE_SELECTION_CONFIG, BLACKLISTED_DOMAINS } from "#lib/constants.js";

// In-memory reuse only. Persistent caching requires a Brave plan with storage rights.
const cache = new Map();
let requestCount = 0;
export const getSearchMetrics = () => ({ braveRequests: requestCount });
export function resetSearchCache() { cache.clear(); requestCount = 0; }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function braveSearch(endpoint, params) {
    const key = process.env.BRAVE_SEARCH_API_KEY;
    if (!key) throw new Error("Missing BRAVE_SEARCH_API_KEY");
    const q = String(params.q ?? "").trim().split(/\s+/).slice(0, 75).join(" ").slice(0, 600);
    if (!q) throw new Error("Search query is empty");
    const url = `https://api.search.brave.com/res/v1/${endpoint}/search?${new URLSearchParams({ country: "SG", search_lang: "en", safesearch: "strict", ...params, q })}`;
    if (cache.has(url)) return cache.get(url);
    const work = (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
            const limit = Number(process.env.MAX_BRAVE_REQUESTS_PER_RUN ?? 500);
            if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid MAX_BRAVE_REQUESTS_PER_RUN");
            if (requestCount >= limit) throw new Error("Brave per-run request budget exhausted");
            requestCount++;
            try {
                const { bytes } = await fetchBytes(url, { headers: { Accept: "application/json", "X-Subscription-Token": key } });
                const result = JSON.parse(bytes.toString("utf8"));
                if (result.type === "ErrorResponse" || result.error) throw new Error("Brave returned an API error");
                return result;
            } catch (error) {
                if (attempt === 2 || ![429, 500, 502, 503, 504].includes(error.status)) throw error;
                const retrySeconds = Number(error.retryAfter);
                await sleep(Math.min(15000, Number.isFinite(retrySeconds) && retrySeconds > 0 ? retrySeconds * 1000 : 1000 * 2 ** attempt));
            }
        }
    })();
    cache.set(url, work);
    try { return await work; } catch (error) { cache.delete(url); throw error; }
}

export function usableWebResults(payload) {
    return (payload?.web?.results ?? []).filter(result => {
        try {
            const url = new URL(result.url);
            return ["http:", "https:"].includes(url.protocol) && !BLACKLISTED_DOMAINS.some(x => result.url.includes(x));
        } catch { return false; }
    });
}

export async function getSearchResultsUrls(query, pages = 1) {
    const urls = new Set();
    for (let offset = 0; offset < Math.min(pages, 10); offset++) {
        const response = await braveSearch("web", { q: query, count: "20", offset: String(offset), extra_snippets: "true" });
        for (const result of usableWebResults(response)) urls.add(result.url);
        if (!response.query?.more_results_available) break;
    }
    return [...urls];
}

const words = value => (value ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
export function rankEventResults(results, { title = "", location = "", datetime = "" } = {}) {
    const tokens = [...new Set(words(title).filter(x => x.length > 2))];
    const venueTokens = words(location).filter(x => x.length > 3);
    const years = datetime.match(/\b20\d{2}\b/g) ?? [];
    return results.map((result, index) => {
        const text = `${result.title ?? ""} ${result.description ?? ""} ${result.url}`.toLowerCase();
        const titleText = (result.title ?? "").toLowerCase();
        const overlap = tokens.filter(token => text.includes(token)).length;
        const score = overlap * 4 + tokens.filter(token => titleText.includes(token)).length * 2
            + venueTokens.filter(token => text.includes(token)).length
            + years.filter(year => text.includes(year)).length * 2
            + (/official|\.gov\.sg\//.test(text) ? 2 : 0) - index * 0.05;
        return { result, score, overlap };
    }).filter(x => tokens.length === 0 || x.overlap >= Math.max(1, Math.ceil(tokens.length * 0.4)))
        .sort((a, b) => b.score - a.score).map(x => x.result);
}

async function saveCandidate(url, folder) {
    const { bytes } = await fetchBytes(url, { maxBytes: 3 * 1024 * 1024, timeoutMs: 15000 });
    const type = await imageType(bytes);
    if (!type || !["image/jpeg", "image/png", "image/webp"].includes(type.mime)) throw new Error("Unsupported image type");
    const filename = `${nanoid()}.${type.ext}`;
    const absolutePath = path.join(getDirectoryPath(folder), filename);
    saveAs(bytes, absolutePath);
    return { filename, absolutePath, sourceUrl: url };
}

export async function getWebLinkAndSaveImage(query, options = {}) {
    const response = await braveSearch("web", { q: query, count: "10", extra_snippets: "true" });
    const results = rankEventResults(usableWebResults(response), options);
    const firstWebUrl = results[0]?.url ?? null;
    const savedImages = [];
    const seen = new Set();
    const folder = `image-candidates/${nanoid(8)}`;
    const save = async url => {
        if (!url || seen.has(url)) return;
        seen.add(url);
        try { savedImages.push(await saveCandidate(url, folder)); }
        catch (error) { logger.warn("Image candidate unavailable", { errorMessage: error.message }); }
    };
    // Prefer metadata from the selected event page before paying for image search.
    if (firstWebUrl) await save(await fetchOgImage(firstWebUrl));
    if (!savedImages.length) {
        try {
            const images = await braveSearch("images", { q: query, count: "10", spellcheck: "false" });
            for (const result of (images.results ?? []).slice(0, 10)) {
                // properties.url is the original image; url is the source web page.
                await save(result.properties?.url ?? result.thumbnail?.src);
                if (savedImages.length >= IMAGE_SELECTION_CONFIG.MAX_IMAGE_CANDIDATES) break;
            }
        } catch (error) {
            logger.warn("Image search failed; retaining event link", { errorMessage: error.message });
        }
    }
    return { firstWebUrl, savedImages };
}

export async function getLocationEvidence(name) {
    const response = await braveSearch("web", { q: `${name} Singapore address nearest MRT`, count: "5", extra_snippets: "true" });
    return usableWebResults(response).map(({ title, url, description, extra_snippets }) => ({
        title, url, description, snippets: extra_snippets ?? [],
    }));
}
