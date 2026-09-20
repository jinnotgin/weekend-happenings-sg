import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { uploadAndUpdateLatest } from "../lib/upload-r2.js";
import { assertPublishable } from "../lib/publication.js";

async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "events-publish-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const events = [{ title: "Test event", thumbnail: "new.jpg" }];
    for (const [file, content] of Object.entries({ "events.json": JSON.stringify(events), "sources.json": "[]", "generationTime.json": '"now"', "new.jpg": "image" })) await fs.writeFile(path.join(dir, file), content);
    return dir;
}
function fakeClient({ failKey } = {}) {
    const objects = new Map([["latest/events.json", Buffer.from('[{"title":"Old event","thumbnail":"old.jpg"}]')], ["latest/old.jpg", Buffer.from("old image")]]);
    const writes = [];
    return { objects, writes, send: async command => {
        const { Key, Body } = command.input;
        switch (command.constructor.name) {
            case "GetObjectCommand":
                if (!objects.has(Key)) { const e = new Error("Not found"); e.name = "NoSuchKey"; throw e; }
                return { Body: { transformToString: async () => objects.get(Key).toString() } };
            case "PutObjectCommand":
                if (failKey?.(Key)) throw new Error("Simulated upload failure");
                objects.set(Key, Body); writes.push(Key); return {};
            case "HeadObjectCommand": return { ContentLength: objects.get(Key)?.length };
            case "ListObjectsV2Command": return { Contents: [] };
            default: throw new Error(`Unexpected command ${command.constructor.name}`);
        }
    } };
}

test("publication guards reject empty results, failed coverage and drastic drops", () => {
    assert.throws(() => assertPublishable({ events: [], sourceCount: 1, attemptedSources: 1 }), /few events/);
    assert.throws(() => assertPublishable({ events: [{}], sourceCount: 1, attemptedSources: 10 }), /coverage/);
    assert.throws(() => assertPublishable({ events: [{}], sourceCount: 1, attemptedSources: 1, previousEventCount: 20 }), /dropped/);
});

test("upload failure before promotion preserves previous live events and images", async t => {
    const dir = await fixture(t);
    const client = fakeClient({ failKey: key => key === "latest/new.jpg" });
    await assert.rejects(uploadAndUpdateLatest(dir, { mode: "production", sourceCount: 1, attemptedSources: 1, client, bucket: "test" }), /Simulated/);
    assert.match(client.objects.get("latest/events.json").toString(), /Old event/);
    assert.equal(client.objects.get("latest/old.jpg").toString(), "old image");
    assert(client.writes.some(key => key.startsWith("archive-")));
});

test("verified archive precedes events commit; staging cannot write production", async t => {
    const dir = await fixture(t);
    const client = fakeClient();
    await uploadAndUpdateLatest(dir, { mode: "staging", sourceCount: 1, attemptedSources: 1, client, bucket: "test" });
    assert(client.writes.every(key => key.startsWith("staging/")));
    assert.equal(client.writes.at(-1), "staging/latest/events.json");
    assert.match(client.objects.get("latest/events.json").toString(), /Old event/);
});
