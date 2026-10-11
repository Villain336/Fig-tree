import Link from "next/link";

const panels = {
  layers: ["Page 1", "Frame", "Rectangle", "Ellipse"],
  properties: ["Position", "Layout", "Fill", "Stroke", "Effects"],
};

/** Editor shell. The canvas, panels and tools arrive with the document model and layout modules. */
export default function EditorShell() {
  return (
    <div className="flex h-dvh flex-col bg-neutral-100 text-neutral-900">
      <header className="flex h-11 items-center justify-between border-b border-neutral-200 bg-white px-4">
        <span className="text-sm font-semibold tracking-tight">Fig Tree</span>
        <nav className="flex items-center gap-4 text-sm text-neutral-600">
          <Link className="hover:text-neutral-900" href="/bench">
            Renderer benchmark
          </Link>
        </nav>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="w-60 border-r border-neutral-200 bg-white p-3">
          <h2 className="mb-2 text-xs font-medium text-neutral-500">Layers</h2>
          <ul className="space-y-1 text-sm">
            {panels.layers.map((name) => (
              <li key={name} className="rounded px-2 py-1 text-neutral-400">
                {name}
              </li>
            ))}
          </ul>
        </aside>
        <main className="flex flex-1 items-center justify-center">
          <p className="max-w-sm text-center text-sm text-neutral-500">
            The canvas lands here once the document model is wired to the renderer. Until then, the
            benchmark shows the renderer on its own.
          </p>
        </main>
        <aside className="w-64 border-l border-neutral-200 bg-white p-3">
          <h2 className="mb-2 text-xs font-medium text-neutral-500">Properties</h2>
          <ul className="space-y-1 text-sm">
            {panels.properties.map((name) => (
              <li key={name} className="rounded px-2 py-1 text-neutral-400">
                {name}
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
