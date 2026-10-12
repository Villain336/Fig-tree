import { FORMAT_VERSION } from "../schema";

/**
 * Upgrades `document.json` from one format version to the next. Migrations
 * run on plain JSON before validation, in order, until the file reaches
 * {@link FORMAT_VERSION}. Add an entry here (and bump `FORMAT_VERSION`)
 * whenever stored semantics change, including schema defaults.
 */
export interface Migration {
  readonly from: number;
  readonly to: number;
  readonly description: string;
  migrate(json: Record<string, unknown>): Record<string, unknown>;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    from: 1,
    to: 2,
    description:
      "Boolean groups (groups with `booleanOperation` and paints) and vertex handle mirroring. Additive: every version 1 document is a valid version 2 document; the bump lets older readers refuse files that use the new properties.",
    migrate: (json) => json,
  },
  {
    from: 2,
    to: 3,
    description:
      "Effects module: layer masks (`mask`) and typed shader paints (`shader` names a built-in shader, `params` its parameters). Version 2 reserved shader paints (`shader` with free-form `uniforms`) were never drawn and have no typed equivalent: they are removed from paint stacks.",
    migrate: (json) => dropReservedShaders(json) as Record<string, unknown>,
  },
];

/** Removes version 2's reserved shader paints (free-form `uniforms`) from every paint stack, recursively. */
function dropReservedShaders(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((v) => !(v && typeof v === "object" && (v as { type?: unknown }).type === "shader" && !("params" in (v as object))))
      .map(dropReservedShaders);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = dropReservedShaders(v);
    return out;
  }
  return value;
}

export class FormatError extends Error {
  constructor(message: string, readonly issues: readonly string[] = []) {
    super(issues.length ? `${message}:\n  ${issues.join("\n  ")}` : message);
    this.name = "FormatError";
  }
}

/** Brings a parsed `document.json` up to the current version. */
export function migrate(json: unknown, migrations: readonly Migration[] = MIGRATIONS, target = FORMAT_VERSION): Record<string, unknown> {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new FormatError("document.json must be an object");
  let doc = json as Record<string, unknown>;
  if (doc.format !== "figtree") throw new FormatError(`not a Fig Tree document (format is ${JSON.stringify(doc.format)})`);
  const raw = doc.version;
  if (typeof raw !== "number" || !Number.isInteger(raw)) throw new FormatError(`invalid format version ${JSON.stringify(raw)}`);
  let version: number = raw;
  if (version > target) throw new FormatError(`this document was written by a newer version of Fig Tree (format ${version}, this build reads up to ${target})`);
  while (version < target) {
    const step = migrations.find((m) => m.from === version);
    if (!step) throw new FormatError(`no migration from format version ${version}`);
    doc = { ...step.migrate(doc), version: step.to };
    version = step.to;
  }
  return doc;
}
