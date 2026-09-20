import { JSDOM } from "jsdom";
import { fetchBytes } from "#lib/http.js";

export async function fetchOgImage(url) {
    try {
        const { bytes, url: finalUrl } = await fetchBytes(url, { maxBytes: 2 * 1024 * 1024, timeoutMs: 15000 });
        const dom = new JSDOM(bytes.toString("utf8"));
        const value = dom.window.document.querySelector("meta[property='og:image'], meta[name='twitter:image']")?.getAttribute("content");
        dom.window.close();
        if (!value) return null;
        const image = new URL(value, finalUrl || url);
        return ["http:", "https:"].includes(image.protocol) ? image.href : null;
    } catch {
        return null;
    }
}
