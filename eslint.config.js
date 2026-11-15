import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.wrangler/**",
      "**/.data/**",
      "**/.mail-sink/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/.worktree/**",
      ".worktree",
      // Scratch checkouts that live inside the working tree on developer
      // machines and are gitignored: throwaway `npm ci` targets and a
      // checked-out clone. They are not this repository's source, so linting
      // them only reports the state of some other commit. Root-anchored so a
      // real `origin/` or `.tmp-npmci/` source directory cannot be hidden.
      ".tmp-npmci",
      ".tmp-npmci/**",
      "origin",
      "origin/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-require-imports": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        crypto: "readonly",
      },
    },
  },
);
