import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new WeakMap();
export function validatePayload(value, responseSchema) {
    if (!responseSchema) return value;
    const schema = responseSchema.schema ?? responseSchema;
    let validate = validators.get(schema);
    if (!validate) {
        validate = ajv.compile(schema);
        validators.set(schema, validate);
    }
    if (!validate(value)) throw new Error(`Invalid model output: ${ajv.errorsText(validate.errors)}`);
    return value;
}

export function validateDateRange(range) {
    if (!Array.isArray(range) || range.length !== 2) throw new Error("Expected two dates");
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const timestamps = range.map(value => {
        if (value === null) return null;
        const match = typeof value === "string" && /^(\d{2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(value);
        if (!match) throw new Error("Invalid date format");
        const month = months.indexOf(match[2]);
        const date = new Date(`${match[3]}-${String(month + 1).padStart(2, "0")}-${match[1]}T00:00:00Z`);
        if (month < 0 || !Number.isFinite(+date) || date.getUTCDate() !== Number(match[1]) || date.getUTCMonth() !== month) {
            throw new Error("Invalid calendar date");
        }
        return +date;
    });
    if (timestamps.every(x => x !== null) && timestamps[0] > timestamps[1]) throw new Error("Reversed date range");
    return range;
}
