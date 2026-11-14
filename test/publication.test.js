import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { S3Client, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { createSqliteExecutor } from "../lib/registry/executors.js";
import { Registry } from "../lib/registry/store.js";
import { publishCompiledArtifacts } from "../lib/publish-artifacts.js";
import { uploadAndUpdateLatest } from "../lib/upload-r2.js";

const noRetry = (operation) => operation();

test("registry failure prevents publishing new public IDs", async () => {
	let uploaded = false;
	await assert.rejects(publishCompiledArtifacts("unused", {
		registry: { commit: async () => { throw new Error("database unavailable"); } },
		upload: async () => { uploaded = true; },
		retry: noRetry,
	}), /database unavailable/);
	assert.equal(uploaded, false);
});

test("identities are durable before upload and only uploaded thumbnails get new keys", async () => {
	const executor = await createSqliteExecutor(":memory:");
	try {
		const registry = await Registry.open({ executor, today: "2026-11-14" });
		const venue = registry.createVenue("Funan");
		const old = registry.upsertEvent({ title: "Missing image", thumbnail: "old.jpg" });
		registry.setThumbnailKeys((name) => `old-archive/${name}`, new Set(["old.jpg"]));
		await registry.commit();
		registry.upsertEvent({ title: "Missing image", thumbnail: null }, old.id);
		const current = registry.upsertEvent({ title: "New image", thumbnail: "new.jpg" });

		const result = await publishCompiledArtifacts("unused", {
			registry,
			retry: noRetry,
			upload: async () => {
				assert.equal((await executor.all("SELECT id FROM venues WHERE id = ?", [venue.id])).length, 1);
				assert.equal((await executor.all("SELECT id FROM events WHERE id = ?", [current.id])).length, 1);
				return { archiveFolder: "new-archive", uploadedFiles: ["events.json", "new.jpg"] };
			},
		});
		assert.equal(result.archiveFolder, "new-archive");
		const reloaded = await Registry.open({ executor, today: "2026-11-14" });
		assert.equal(reloaded.events.get(old.id).thumbnailKey, "old-archive/old.jpg");
		assert.equal(reloaded.events.get(current.id).thumbnailKey, "new-archive/new.jpg");
	} finally {
		executor.close();
	}
});

test("failed uploads leave existing thumbnail keys intact", async () => {
	const executor = await createSqliteExecutor(":memory:");
	try {
		const registry = await Registry.open({ executor, today: "2026-11-14" });
		const event = registry.upsertEvent({ title: "Example", thumbnail: "old.jpg" });
		registry.setThumbnailKeys((name) => `old-archive/${name}`, new Set(["old.jpg"]));
		await registry.commit();
		registry.upsertEvent({ title: "Example", thumbnail: "old.jpg" }, event.id);
		await assert.rejects(publishCompiledArtifacts("unused", {
			registry,
			retry: noRetry,
			upload: async () => false,
		}), /Upload to R2 reported failure/);
		const reloaded = await Registry.open({ executor, today: "2026-11-14" });
		assert.equal(reloaded.events.get(event.id).thumbnailKey, "old-archive/old.jpg");
	} finally {
		executor.close();
	}
});

test("post-upload key persistence failure retains durable identities", async () => {
	let commits = 0;
	let uploaded = false;
	const registry = {
		async commit() {
			commits += 1;
			if (commits === 2) throw new Error("key save failed");
		},
		setThumbnailKeys() {},
	};
	await assert.rejects(publishCompiledArtifacts("unused", {
		registry,
		retry: noRetry,
		upload: async () => {
			assert.equal(commits, 1);
			uploaded = true;
			return { archiveFolder: "archive", uploadedFiles: ["image.jpg"] };
		},
	}), /key save failed/);
	assert.equal(uploaded, true);
});

test("legacy publication still works without a registry", async () => {
	const result = await publishCompiledArtifacts("compiled", {
		retry: noRetry,
		upload: async (directory) => {
			assert.equal(directory, "compiled");
			return { archiveFolder: "archive", uploadedFiles: [] };
		},
	});
	assert.equal(result.archiveFolder, "archive");
});

test("R2 publication confirms exactly the files uploaded to the archive", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "registry-publication-"));
	const originalSend = S3Client.prototype.send;
	const uploadedKeys = [];
	try {
		await fs.writeFile(path.join(directory, "events.json"), "[]");
		await fs.writeFile(path.join(directory, "image.jpg"), "test-image");
		S3Client.prototype.send = async (command) => {
			if (command instanceof ListObjectsV2Command) return { Contents: [] };
			assert.ok(command instanceof PutObjectCommand);
			uploadedKeys.push(command.input.Key);
			return {};
		};
		const result = await uploadAndUpdateLatest(directory);
		assert.ok(result);
		assert.deepEqual(result.uploadedFiles.sort(), ["events.json", "image.jpg"]);
		for (const filename of result.uploadedFiles) {
			assert.ok(uploadedKeys.includes(`${result.archiveFolder}/${filename}`));
			assert.ok(uploadedKeys.includes(`latest/${filename}`));
		}
	} finally {
		S3Client.prototype.send = originalSend;
		await fs.rm(directory, { recursive: true, force: true });
	}
});
