import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applySpanOp, applyYTextOp, spansFromYText, type Span, type TextOp } from "../src/text";

describe("text spans", () => {
  it("predict exactly what Yjs produces for any sequence of edits", () => {
    const attr = fc.constantFrom<Span["attrs"]>({}, { fontWeight: 700 }, { fontStyle: "italic" }, { fontWeight: null }, { fontWeight: 400, fontStyle: "italic" });
    const op = fc.record({ kind: fc.constantFrom("insert", "insert-styled", "delete", "format"), a: fc.nat(), b: fc.nat(), text: fc.string({ minLength: 1, maxLength: 5 }), attrs: attr });
    fc.assert(
      fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
        const doc = new Y.Doc();
        const ytext = doc.getText("t");
        let spans: Span[] = [];
        for (const o of ops) {
          const len = spans.reduce((n, s) => n + s.text.length, 0);
          let edit: TextOp;
          if (o.kind === "insert" || o.kind === "insert-styled") {
            const attrs = Object.fromEntries(Object.entries(o.attrs).filter(([, v]) => v !== null));
            edit = o.kind === "insert" ? { op: "insert", index: o.a % (len + 1), text: o.text } : { op: "insert", index: o.a % (len + 1), text: o.text, attrs };
          } else {
            if (len === 0) continue;
            const index = o.a % len;
            const length = 1 + (o.b % (len - index));
            edit = o.kind === "delete" ? { op: "delete", index, length } : { op: "format", index, length, attrs: o.attrs };
          }
          spans = applySpanOp(spans, edit);
          applyYTextOp(ytext, edit);
          expect(spansFromYText(ytext)).toEqual(spans);
        }
      }),
      { numRuns: 500 },
    );
  });
});
