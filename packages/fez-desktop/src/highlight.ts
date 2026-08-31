import hljs from "highlight.js/lib/core";
import python from "highlight.js/lib/languages/python";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import rust from "highlight.js/lib/languages/rust";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";

/**
 * Fenced-code highlighting for chat. Core + the dozen languages agents
 * actually post (a full hljs build is 1MB of grammars for languages
 * nobody here writes). Registered once at module load; `highlightCode`
 * returns hljs's escaped HTML, or undefined for languages we don't
 * know — the caller falls back to plain text, never guesses.
 */
for (const [name, lang] of Object.entries({
  python, javascript, typescript, rust, json, bash, xml, css, go, sql, yaml, markdown,
})) {
  hljs.registerLanguage(name, lang);
}
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["js", "jsx", "mjs"], { languageName: "javascript" });
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["sh", "shell", "zsh"], { languageName: "bash" });
hljs.registerAliases(["html", "svg"], { languageName: "xml" });
hljs.registerAliases(["yml"], { languageName: "yaml" });
hljs.registerAliases(["md"], { languageName: "markdown" });

export function highlightCode(code: string, lang: string): string | undefined {
  if (!hljs.getLanguage(lang)) return undefined;
  try {
    return hljs.highlight(code, { language: lang }).value;
  } catch {
    return undefined;
  }
}
