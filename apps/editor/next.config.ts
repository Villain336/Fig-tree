import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    // harfbuzzjs imports Node's "module" builtin behind a Node-only branch; browsers get a stub.
    resolveAlias: { module: { browser: "./empty-module.js" } },
  },
};

export default nextConfig;
