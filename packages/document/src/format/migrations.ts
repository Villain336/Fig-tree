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
];

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
