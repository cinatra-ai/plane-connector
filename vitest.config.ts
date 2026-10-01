import { defineConfig } from "vitest/config";
import * as path from "node:path";

const serverOnlyStub = path.join(__dirname, "tests/__stubs__/server-only.ts");

export default defineConfig({
  resolve: {
    alias: [
      { find: "@cinatra-ai/design-primitives", replacement: path.join(__dirname, "src/__tests__/fixtures/design-primitives.tsx") },
      { find: "server-only", replacement: serverOnlyStub },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
