import logger from "#lib/logger.js";
import { uploadAndUpdateLatest } from "#lib/upload-r2.js";
import { retryAsyncFunction } from "#lib/utils.js";

// Persist identities before exposing them in latest/. A failed database commit must
// leave the previous public feed intact. Thumbnail keys are saved separately, once
// the archive containing those files has actually been uploaded.
export async function publishCompiledArtifacts(sourceFolderPath, {
	registry = null,
	upload = uploadAndUpdateLatest,
	retry = retryAsyncFunction,
} = {}) {
	if (registry) {
		logger.info("Stage: Saving registry identities before publication");
		const statementCount = await retry(() => registry.commit(), 2);
		logger.summary("Registry identities saved", { statementCount, ...registry.stats });
	}

	logger.info("Stage: Uploading compiled artifacts to R2");
	const result = await retry(async () => {
		const uploaded = await upload(sourceFolderPath);
		if (!uploaded) throw new Error("Upload to R2 reported failure.");
		return uploaded;
	}, 2);
	logger.summary("Remote upload completed successfully.");

	if (registry && result.archiveFolder) {
		registry.setThumbnailKeys(
			(filename) => `${result.archiveFolder}/${filename}`,
			new Set(result.uploadedFiles ?? [])
		);
		await retry(() => registry.commit(), 2);
	}
	return result;
}
