import { defineConfig } from "@playwright/test";

/**
 * Chromium flags for GPU tests. On machines without a GPU, WebGPU and WebGL2
 * both run on SwiftShader; the Vulkan flags give WebGPU canvases a working
 * presentation path in headless mode.
 */
const gpuArgs = [
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--use-vulkan=swiftshader",
  "--use-angle=swiftshader",
];

const port = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${port}`,
    browserName: "chromium",
    launchOptions: { args: gpuArgs },
  },
  projects: [
    { name: "render", testMatch: /(render|editor)\.spec\.ts/, timeout: 120_000 },
    { name: "bench", testMatch: /bench\.spec\.ts/, timeout: 600_000 },
    // Layout conformance renders static HTML with page.setContent: no server needed (PW_NO_SERVER=1).
    { name: "conformance", testMatch: /conformance\.spec\.ts/, timeout: 600_000 },
  ],
  ...(process.env.PW_NO_SERVER
    ? {}
    : {
        webServer: {
          command: `npm run start -w @fig-tree/editor -- -p ${port}`,
          url: `http://localhost:${port}`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      }),
});
