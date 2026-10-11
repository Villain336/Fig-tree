"use client";
import { useEffect, useState } from "react";
export default function Probe() {
  const [out, setOut] = useState("probing");
  useEffect(() => {
    (async () => {
      const lines: string[] = [];
      lines.push("secure=" + window.isSecureContext);
      lines.push("gpu=" + ("gpu" in navigator));
      try {
        const a = await navigator.gpu?.requestAdapter();
        lines.push("adapter=" + (a ? JSON.stringify(a.info) : "null"));
        if (a) { const feats=[...a.features]; lines.push("features="+feats.join(",")); lines.push("limits.maxStorage="+a.limits.maxStorageBufferBindingSize+" wg="+a.limits.maxComputeWorkgroupStorageSize); }
      } catch (e) { lines.push("err=" + String(e)); }
      const gl = document.createElement("canvas").getContext("webgl2");
      lines.push("webgl2=" + !!gl);
      if (gl) { lines.push("renderer=" + gl.getParameter(gl.RENDERER) + " samples=" + gl.getParameter(gl.MAX_SAMPLES) + " multidraw=" + !!gl.getExtension("WEBGL_multi_draw")); }
      setOut(lines.join("\n"));
    })();
  }, []);
  return <pre id="out">{out}</pre>;
}
