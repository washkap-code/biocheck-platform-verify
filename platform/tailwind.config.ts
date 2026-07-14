import type { Config } from "tailwindcss";

/**
 * BioCheck design system — Tailwind theme.
 * Approved palette (Concept 1). Do not introduce off-brand colours.
 * Colour semantics: cyan = interaction/intelligence · green = successful verification ONLY
 * · violet = orchestration/AI · red = failure/critical ONLY · amber = caution/review.
 */
const config: Config = {
  content: [
    "./src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        midnight: "#07111F",
        graphite: "#182333",
        cyan: "#18D7E8",
        green: "#32E875",
        violet: "#7657FF",
        cloud: "#F7F9FC",
        slate: "#8995A7",
        line: "#DDE4ED",
        critical: "#FF5364",
        amber: "#FFB547",
      },
      fontFamily: {
        display: ["var(--font-manrope)", "system-ui", "sans-serif"],
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["var(--font-plex-mono)", "ui-monospace", "monospace"],
      },
      maxWidth: {
        content: "1440px",
      },
      borderRadius: {
        sm: "12px",
        DEFAULT: "16px",
        lg: "20px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(7,17,31,0.04), 0 8px 24px rgba(7,17,31,0.06)",
        "card-dark": "0 1px 2px rgba(0,0,0,0.3), 0 12px 40px rgba(0,0,0,0.35)",
        glow: "0 0 0 1px rgba(24,215,232,0.35), 0 0 40px rgba(24,215,232,0.18)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(12px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        scanline: {
          "0%": { top: "12%" },
          "50%": { top: "82%" },
          "100%": { top: "12%" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.6s cubic-bezier(0.22,1,0.36,1) both",
        scanline: "scanline 1.8s ease-in-out infinite",
      },
      transitionTimingFunction: {
        brand: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    },
  },
  plugins: [],
};

export default config;
