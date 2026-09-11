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
      "**/.next/**",
      "**/node_modules/**",
      "**/src-tauri/target/**",
      // web/ is a Next.js app with its own eslint setup, and its
      // eslint-plugin-react predates flat config — loading it here
      // crashes the run. `next lint` covers it there.
      "web/**",
      // Claude worktrees are full repo copies — linting them doubles
      // every finding and reports errors in code that isn't on main.
      "**/.claude/**",
      "**/.worktrees/**",
      // Build artifacts. deploy/fez-relay.mjs is an esbuild bundle
      // (deploy/deploy.sh --outfile) — 10k lines of vendored code whose
      // findings are not ours to fix and drown the ones that are.
      "deploy/*.mjs",
      "dev/experiments/coordination/.*.*/**",
      "**/*.min.js",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Underscore means "deliberately unused" — the escape hatch has to
      // exist or the rule gets turned off wholesale.
      "@typescript-eslint/no-unused-vars": [
        "error",
        // `h` is the JSX factory in shared-React extension guis
        // (--jsx-factory=h) — used by every JSX element, invisible to
        // eslint, which has no jsxFactory setting in flat config.
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_|^h$", caughtErrorsIgnorePattern: "^_" },
      ],
      // `catch {}` is how a real failure becomes a silent no-op. Today
      // it hid why an agent's mention carried no p tag.
      "no-empty": ["error", { allowEmptyCatch: false }],
      // any is sometimes the honest type at a wire boundary; warn so it
      // stays visible without blocking.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "off",
      // `let verdict = false; try { verdict = … } catch {}` — the rule is
      // right that the initial value is never read, and wrong that this
      // is a defect: the initialiser is what makes the variable defined
      // when the try throws. Editing correct code to satisfy a rule is
      // how a lint config starts costing more than it catches.
      "no-useless-assignment": "off",
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
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // Scripts and tests are allowed to be loose about console and any.
    files: ["scripts/**", "**/tests/**", "**/*.test.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  }
);
