import { generateChatJson } from "#lib/llm-chat.js";
export const generateJson = (prompt, options) => generateChatJson("nim", prompt, options);
