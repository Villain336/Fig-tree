import type { Metadata } from "next";
import { TextRender } from "./text-render";

export const metadata: Metadata = { title: "Text render harness" };

/** Renders glyph scenes posted by the visual text conformance test (e2e/text-visual.spec.ts). */
export default function TextRenderPage() {
  return <TextRender />;
}
