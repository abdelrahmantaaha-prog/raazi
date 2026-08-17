import type { Schema } from "@google/genai";

/**
 * The pipeline's schemas are written in Gemini's dialect. Everyone else takes
 * plain JSON Schema, and the two differ mainly in that Gemini uppercases its
 * type names — so this is a translation, not a rewrite.
 *
 * `strict` mode on OpenAI-compatible endpoints additionally insists that every
 * property is listed in `required` and that objects forbid extra keys. Fields
 * the pipeline treats as optional are therefore made nullable instead, which is
 * how you say "may be absent" under those rules.
 */
export function toJsonSchema(schema: Schema, strict = true): Record<string, unknown> {
  const type = String(schema.type ?? "").toLowerCase() || "object";

  const out: Record<string, unknown> = { type };
  if (schema.description) out.description = schema.description;
  if (schema.enum?.length) out.enum = schema.enum;

  if (type === "object") {
    const props: Record<string, unknown> = {};
    const declared = schema.required ?? [];
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      const converted = toJsonSchema(child as Schema, strict);
      // Optional under strict mode means "present but possibly null".
      props[name] =
        strict && !declared.includes(name)
          ? { ...converted, type: [converted.type as string, "null"] }
          : converted;
    }
    out.properties = props;
    out.required = strict ? Object.keys(props) : declared;
    out.additionalProperties = false;
  }

  if (type === "array" && schema.items) {
    out.items = toJsonSchema(schema.items as Schema, strict);
  }

  return out;
}

/**
 * Models under strict mode return `null` for anything they had nothing to say
 * about. The pipeline expects those keys to be missing, so strip them back out
 * before the data is used.
 */
export function dropNulls<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => dropNulls(v)).filter((v) => v !== null) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null) continue;
      out[k] = dropNulls(v);
    }
    return out as T;
  }
  return value;
}
