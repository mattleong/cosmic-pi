import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["index.ts", "testing.ts"],
  format: "esm",
  fixedExtension: false,
  sourcemap: false,
  dts: true,
});
