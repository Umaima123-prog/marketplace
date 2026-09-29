import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Prisma Client, emitted by `prisma generate` (output is set in
    // schema.prisma). Machine-generated, gitignored, and rewritten on every
    // generate -- linting it produced ~2,300 problems in code nobody edits, and
    // drowned any real finding in our own source.
    "src/generated/**",
  ]),
]);

export default eslintConfig;
