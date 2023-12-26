import fs from "fs";
import path from "path";
import logger from "#lib/logger.js";
import {
	S3Client,
	ListObjectsV2Command,
	PutObjectCommand,
	DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import {
	R2_ACCOUNT_ID,
	R2_BUCKET_NAME,
	R2_ACCESS_KEY_ID,
	R2_SECRET_ACCESS_KEY,
} from "#config/secrets.js";

const r2Destination = new S3Client({
	region: "auto",
	endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
	credentials: {
		accessKeyId: R2_ACCESS_KEY_ID,
		secretAccessKey: R2_SECRET_ACCESS_KEY,
	},
});

const deleteFolder = async (bucket, folder) => {
	let continuationToken;

	do {
		const listParams = {
			Bucket: bucket,
			Prefix: folder, // Folder name in the bucket
			ContinuationToken: continuationToken,
		};

		const listedObjects = await r2Destination.send(
			new ListObjectsV2Command(listParams)
		);

		if (!Array.isArray(listedObjects?.Contents)) {
			throw new Error("Folder does not exist");
		}

		if (listedObjects?.Contents.length === 0) return;

		const deleteParams = {
			Bucket: bucket,
			Delete: { Objects: listedObjects.Contents.map(({ Key }) => ({ Key })) },
		};
		logger.info(
			`Deleting ${folder} from ${bucket} (${listedObjects.Contents.length} items)`
		);

		await r2Destination.send(new DeleteObjectsCommand(deleteParams));

		continuationToken = listedObjects.NextContinuationToken;
	} while (continuationToken);
};

const uploadFolder = async (sourceFolderPath, bucket, destinationFolder) => {
	const files = fs.readdirSync(sourceFolderPath);

	for (const file of files) {
		const filePath = path.join(sourceFolderPath, file);
		const fileContent = fs.readFileSync(filePath);
		const key = `${destinationFolder}/${file}`;

		const putObjectParams = {
			Bucket: bucket,
			Key: key,
			Body: fileContent,
		};
		logger.info(`Uploading ${filePath} to ${bucket} at ${key}`);

		await r2Destination.send(new PutObjectCommand(putObjectParams));
	}
};

const uploadAndUpdateLatest = async (sourceFolderPath) => {
	try {
		const now = new Date();
		const archiveFolder = `archive-${now.getFullYear()}${String(
			now.getMonth() + 1
		).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(
			now.getHours()
		).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(
			now.getSeconds()
		).padStart(2, "0")}`;

		// Delete existing 'latest' folder
		await deleteFolder(R2_BUCKET_NAME, "latest");

		// Upload to 'latest'
		await uploadFolder(sourceFolderPath, R2_BUCKET_NAME, "latest");

		// Upload to 'archive'
		await uploadFolder(sourceFolderPath, R2_BUCKET_NAME, archiveFolder);

		return true;
	} catch (error) {
		logger.error("Upload error:", { error });
		return false;
	}
};

export { uploadAndUpdateLatest };
