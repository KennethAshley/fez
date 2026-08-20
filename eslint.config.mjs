import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * Lint config for a repo that had none.
 *
 * Calibrated to catch the bugs this codebase actually produces rather
 * than to enforce a house style. Three shipped in one afternoon:
 *
 *   - a fix that lived in source and was dead in the running system,
 *     because the build did not build that package (now build-all.mjs)
 *   - four .rail blocks fighting over one property (now check-css.mjs
 *     and stylelint)
 *   - an empty catch that swallowed the reason a mention was not tagged
 *
 * Only the third is an ESLint job, so the rules that matter here are
 * about silently discarded information: floating promises, empty
 * catches, unused results. Style is left alone — nothing in this repo
 * was ever broken by a quote character.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/src-tauri/target/**",
      // web/ is a Next.js app with its own eslint setup, and its
      // eslint-plugin-react predates flat config — loading it here
      // crashes the run. `next lint` covers it there.
      "web/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Underscore means "deliberately unused" — the escape hatch has to
      // exist or the rule gets turned off wholesale.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // `catch {}` is how a real failure becomes a silent no-op. Today
      // it hid why an agent's mention carried no p tag.
      "no-empty": ["error", { allowEmptyCatch: false }],
      // any is sometimes the honest type at a wire boundary; warn so it
      // stays visible without blocking.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: ["packages/fez-desktop/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // A stale closure in a subscription is a message that never
      // arrives — worth a warning even when the dep is deliberate.
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // Scripts and tests are allowed to be loose about console and any.
    files: ["scripts/**", "**/tests/**", "**/*.test.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  }
);
