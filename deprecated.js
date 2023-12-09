async function getMedianOutputArray(times) {
	let arrays = [];
	logger.info(
		`Running the function "combineDedupVerifyParseJson" ${times} times to find the median array`
	);

	for (let i = 0; i < times; i++) {
		try {
			logger.info(`Attempt ${i + 1} of "combineDedupVerifyParseJson"`);
			const eventsList = await retryAsyncFunction(
				combineDedupVerifyParseJson,
				RETRY_COUNT
			);
			saveAsText(JSON.stringify(eventsList), `combined-${i + 1}.json`);
			logger.info(`Current iteration array ${eventsList.length} items`);

			if (Array.isArray(eventsList)) {
				arrays.push(eventsList);
			}
		} catch (error) {
			logger.error(`ERROR: Attempt ${i + 1} failed. ${error.message}`);
		}
	}

	// Sort arrays by length
	arrays.sort((a, b) => a.length - b.length);

	// Find the median array
	const medianIndex = Math.floor(arrays.length / 2);
	const medianArray =
		arrays.length % 2 !== 0 ? arrays[medianIndex] : arrays[medianIndex - 1];

	return medianArray;
}
