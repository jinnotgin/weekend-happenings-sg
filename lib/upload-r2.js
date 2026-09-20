import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { S3Client, ListObjectsV2Command, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import logger from "#lib/logger.js";
import { assertPublishable } from "#lib/publication.js";

const missing = error => error?.$metadata?.httpStatusCode === 404 || ["NoSuchKey", "NotFound"].includes(error?.name);
function createClient() {
    for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]) {
        if (!process.env[name]) throw new Error(`Missing ${name}`);
    }
    return new S3Client({ region: "auto", endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }, maxAttempts: 2 });
}
const mime = file => ({ ".json": "application/json", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" }[path.extname(file)] ?? "application/octet-stream");

export async function uploadAndUpdateLatest(sourceFolderPath, { mode = "staging", sourceCount, attemptedSources, client, bucket = process.env.R2_BUCKET_NAME } = {}) {
    if (!["staging", "production"].includes(mode)) throw new Error("Invalid upload mode");
    client ??= createClient();
    if (!bucket) throw new Error("Missing R2_BUCKET_NAME");
    const send = command => client.send(command, { abortSignal: AbortSignal.timeout(30000) });
    const prefix = mode === "staging" ? "staging/" : "";
    const files = await fs.readdir(sourceFolderPath);
    const payloads = new Map(await Promise.all(files.map(async file => [file, await fs.readFile(path.join(sourceFolderPath, file))])));
    const events = JSON.parse(payloads.get("events.json")?.toString() ?? "null");
    for (const event of events ?? []) {
        if (event.thumbnail && (!payloads.has(event.thumbnail) || path.basename(event.thumbnail) !== event.thumbnail)) throw new Error("Missing or invalid event thumbnail");
    }
    let previousEventCount = 0;
    try {
        const old = await send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}latest/events.json` }));
        const previous = JSON.parse(await old.Body.transformToString());
        if (!Array.isArray(previous)) throw new Error("Existing events payload is invalid");
        previousEventCount = previous.length;
    } catch (error) { if (!missing(error)) throw error; }
    assertPublishable({ events, sourceCount, attemptedSources, previousEventCount });
    const archive = `${prefix}archive-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    async function putVerified(file, destination, cacheControl) {
        const body = payloads.get(file);
        await send(new PutObjectCommand({ Bucket: bucket, Key: `${destination}/${file}`, Body: body, ContentType: mime(file), CacheControl: cacheControl }));
        const head = await send(new HeadObjectCommand({ Bucket: bucket, Key: `${destination}/${file}` }));
        if (head.ContentLength !== body.length) throw new Error(`Upload verification failed for ${file}`);
    }
    // Every file must exist in the immutable archive before the live payload changes.
    for (const file of files) await putVerified(file, archive, "public, max-age=31536000, immutable");
    // Keep old thumbnail objects: existing events remain usable during an upload failure.
    // events.json is the commit point for the existing frontend contract.
    for (const file of files.filter(f => f !== "events.json")) {
        await putVerified(file, `${prefix}latest`, file.endsWith(".json") ? "no-cache" : "public, max-age=31536000, immutable");
    }
    await putVerified("events.json", `${prefix}latest`, "no-cache");
    logger.summary("Published verified event dataset", { mode, archive, eventCount: events.length });
    try { await cleanup(send, bucket, prefix, archive); }
    catch (error) { logger.warn("Archive cleanup failed after successful publication", { errorMessage: error.message }); }
    return true;
}

async function cleanup(send, bucket, prefix, currentArchive) {
    const objects = [];
    let token;
    do {
        const page = await send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}archive-`, ContinuationToken: token }));
        objects.push(...(page.Contents ?? []));
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    const folderOf = key => key.slice(0, key.lastIndexOf("/"));
    const folders = [...new Set(objects.map(x => folderOf(x.Key)))].sort();
    const stale = new Set(folders.slice(0, Math.max(0, folders.length - 30)).filter(f => f !== currentArchive));
    const deletions = objects.filter(x => stale.has(folderOf(x.Key))).map(({ Key }) => ({ Key }));
    for (let i = 0; i < deletions.length; i += 1000) {
        const result = await send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: deletions.slice(i, i + 1000) } }));
        if (result.Errors?.length) throw new Error("Some archive deletions failed");
    }
}
