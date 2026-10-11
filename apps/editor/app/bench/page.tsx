import type { Metadata } from "next";
import { Bench } from "./bench";

export const metadata: Metadata = { title: "Renderer benchmark · Fig Tree" };

export default function BenchPage() {
  return <Bench />;
}
