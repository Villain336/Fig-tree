import type { Metadata } from "next";
import { DocRender } from "./doc-render";

export const metadata: Metadata = { title: "Document render harness" };

/** Renders `.figtree` documents posted by the effects reference tests (e2e/effects-reference.spec.ts). */
export default function DocRenderPage() {
  return <DocRender />;
}
