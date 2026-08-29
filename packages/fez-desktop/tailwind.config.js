// packages/fez-desktop/tailwind.config.js
// Safelist-driven: extensions are NOT scanned (their class strings live in
// bundles we don't compile here). We emit a generous fixed utility set the
// host document carries once, so any fez-* class an extension references
// already exists. Grow the safelist from real extensions (spec Q2).
import preset from "@fezchat/tailwind-preset";

const FEZ_COLORS = ["fg","dim","surface","elevated","base","mine","rail","accent","brand","green","red","yellow","hairline","field"];
const COLOR_PROPS = ["bg","text","border"];

export default {
  presets: [preset],
  content: [],
  corePlugins: { preflight: false }, // the host owns base styles (App.css)
  safelist: [
    "flex","grid","block","inline-block","hidden","flex-col","flex-row","flex-1","flex-wrap",
    "items-center","items-start","items-end","justify-center","justify-between","justify-start","justify-end",
    "w-full","h-full","max-w-full","min-w-0","overflow-auto","overflow-hidden","truncate","relative","absolute",
    "rounded","rounded-md","rounded-lg","border","font-mono","font-medium","font-semibold",
    "text-xs","text-sm","text-base","text-lg",
    { pattern: /^(gap|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr)-(0|1|2|3|4|5|6|8)$/ },
    { pattern: new RegExp(`^(${COLOR_PROPS.join("|")})-fez-(${FEZ_COLORS.join("|")})$`),
      variants: ["hover","focus","focus-within","disabled"] },
    { pattern: /^(flex|grid|hidden|items-center|justify-between)$/, variants: ["sm","md","lg"] },
  ],
};
