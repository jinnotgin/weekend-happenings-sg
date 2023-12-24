import { JSDOM } from "jsdom";

export async function fetchOgImage(url) {
	try {
		const response = await fetch(url);
		const response_html = await response.text();
		const dom = new JSDOM(response_html);
		const document = dom.window.document;

		const metaOgImage = document.querySelector("meta[property='og:image']");

		if (metaOgImage && metaOgImage.hasAttribute("content")) {
			const imageUrl = metaOgImage.getAttribute("content");
			const extension = imageUrl.split(".").pop();

			if (extension === "jpg" || extension === "jpeg" || extension === "png") {
				return imageUrl;
			}
		}

		return false;
	} catch (error) {
		console.error("Error fetching URL:", error);
		return false;
	}
}
