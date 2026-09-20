export function assertPublishable({ events, sourceCount, attemptedSources, previousEventCount = 0 }) {
    const positiveInt = (key, fallback) => {
        const value = Number(process.env[key] ?? fallback);
        if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid ${key}`);
        return value;
    };
    const ratio = (key, fallback) => {
        const value = Number(process.env[key] ?? fallback);
        if (!Number.isFinite(value) || value <= 0 || value > 1) throw new Error(`Invalid ${key}`);
        return value;
    };
    if (!Array.isArray(events) || events.length < positiveInt("MIN_EVENTS", 1)) throw new Error("Publication blocked: too few events");
    if (sourceCount < positiveInt("MIN_SOURCES", 1)) throw new Error("Publication blocked: too few sources");
    if (!attemptedSources || sourceCount / attemptedSources < ratio("MIN_SOURCE_SUCCESS_RATIO", 0.5)) throw new Error("Publication blocked: source coverage below threshold");
    if (previousEventCount && events.length / previousEventCount < ratio("MIN_EVENT_RETENTION_RATIO", 0.5)) throw new Error("Publication blocked: event count dropped below threshold");
}
