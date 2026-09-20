import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { selectBestEventImage } from "../lib/image-selection.js";

test("image ID remains stable when a preceding candidate cannot be loaded", async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "image-selection-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
    const file = path.join(dir, "valid.png"); await fs.writeFile(file, png);
    const old = process.env.OPENROUTER_API_KEY; process.env.OPENROUTER_API_KEY = "test-only";
    t.after(() => { if (old === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = old; });
    t.mock.method(globalThis, "fetch", async (_, options) => {
        const request = JSON.parse(options.body);
        assert.match(JSON.stringify(request.messages), /Candidate 2: valid.png/);
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"best_image":2,"justification":"Event poster"}' } }] });
    });
    const result = await selectBestEventImage({ eventTitle: "Event", savedImages: [{ filename: "missing.png", absolutePath: path.join(dir, "missing.png") }, { filename: "valid.png", absolutePath: file }] });
    assert.equal(result.bestImageIndex, 2);
});
