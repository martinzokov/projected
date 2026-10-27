// Lint for the framework's own packages. Example apps carry their own config
// (@projected/architecture's projectedEslint), and `projected check` enforces it.
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/.tsbuild/**", "**/node_modules/**", "examples/**", "packages/architecture/test/fixture/**"] },
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
);
