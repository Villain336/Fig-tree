import type { Metadata } from "next";
import { RenderTest } from "./render-test";

export const metadata: Metadata = { title: "Render test harness" };

/** Renders one reference scene and exposes its pixels to the Playwright pixel-quality suite. */
export default function RenderTestPage() {
  return <RenderTest />;
}
