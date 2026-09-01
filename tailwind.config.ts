import type { Config } from "tailwindcss";

// Retro (Tecmo Super Bowl / 8-bit NES) design tokens.
// Later feature agents should build UI out of these tokens rather than
// introducing ad-hoc colors — keep the palette limited and saturated.
const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // Gridiron background tones — a night-game football field. Kept
        // dark enough that offwhite/yellow text stays high-contrast and
        // dark text on the yellow buttons still reads.
        field: {
          DEFAULT: "#0f5132", // rich turf green (app background)
          dark: "#07301d", // end-zone shadow (nav/header, deep panels)
          light: "#178a4c", // brighter grass (cards/panels)
        },
        // NES-style saturated accents — brightened for readability.
        retro: {
          red: "#ff5a5f",
          blue: "#4f8cff",
          yellow: "#ffdd00",
          green: "#7bffa3",
          offwhite: "#fbf8ef",
        },
      },
      fontFamily: {
        // Set from next/font/google in src/app/layout.tsx via CSS variables.
        pixel: ["var(--font-press-start)", "monospace"],
        mono: ["var(--font-vt323)", "monospace"],
      },
      borderRadius: {
        none: "0px",
        DEFAULT: "0px",
      },
      borderWidth: {
        DEFAULT: "4px",
        thick: "4px",
        thin: "2px",
      },
      boxShadow: {
        pixel: "4px 4px 0 0 #000",
        "pixel-sm": "2px 2px 0 0 #000",
      },
    },
  },
  plugins: [],
};

export default config;
