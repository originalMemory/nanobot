const animate = require("tailwindcss-animate");
const typography = require("@tailwindcss/typography");

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["selector", '[data-theme="dark"],[data-theme="midnight"],[data-theme="neon"]'],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        sans: [
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          '"Segoe UI"',
          "Roboto",
          '"Helvetica Neue"',
          "Arial",
          '"Noto Sans"',
          '"Noto Sans SC"',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          "sans-serif",
          '"Apple Color Emoji"',
          '"Segoe UI Emoji"',
        ],
        mono: [
          '"JetBrains Mono"',
          '"Fira Code"',
          '"Cascadia Code"',
          '"Source Code Pro"',
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      colors: {
        background:
          "hsl(var(--background) / calc(var(--wp-alpha-bg, 1) * <alpha-value>))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT:
            "hsl(var(--card) / calc(var(--wp-alpha-surface, 1) * <alpha-value>))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT:
            "hsl(var(--popover) / calc(var(--wp-alpha-surface, 1) * <alpha-value>))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT:
            "hsl(var(--primary) / calc(var(--wp-alpha-primary, 1) * <alpha-value>))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT:
            "hsl(var(--secondary) / calc(var(--wp-alpha-muted, 1) * <alpha-value>))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT:
            "hsl(var(--muted) / calc(var(--wp-alpha-muted, 1) * <alpha-value>))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT:
            "hsl(var(--accent) / calc(var(--wp-alpha-accent, 1) * <alpha-value>))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground))",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        sidebar: {
          DEFAULT:
            "hsl(var(--sidebar) / calc(var(--wp-alpha-sidebar, 1) * <alpha-value>))",
          foreground: "hsl(var(--sidebar-foreground))",
          accent:
            "hsl(var(--sidebar-accent) / calc(var(--wp-alpha-sidebar-accent, 1) * <alpha-value>))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
        },
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [animate, typography],
};
