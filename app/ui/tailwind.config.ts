import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--primary-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--primary-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--primary-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-bg))",
          foreground: "hsl(var(--sidebar-fg))",
          active: "hsl(var(--sidebar-active))",
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Text"',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          '"Segoe UI"',
          'Roboto',
          'sans-serif',
        ],
        heading: [
          'Space Grotesk',
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          'sans-serif',
        ],
        mono: [
          '"JetBrains Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          '"Liberation Mono"',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          'monospace',
        ],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      /* Strong easing curves — the built-in CSS easings are too weak to read
         as intentional. Mirrors the --ease-* tokens in index.css so utilities
         and raw CSS never drift apart. Use `ease-out-strong` etc. */
      transitionTimingFunction: {
        "out-strong": "var(--ease-out)",
        "in-out-strong": "var(--ease-in-out)",
        drawer: "var(--ease-drawer)",
      },
      /* Apple spring-based keyframes */
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        /* Apple: fade + slight scale for enters */
        "fade-in": {
          from: { opacity: "0", transform: "translateY(8px) scale(0.98)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "fade-out": {
          from: { opacity: "1" },
          to: { opacity: "0" },
        },
        /* Apple: spring slide for sheets/panels */
        "sheet-in": {
          from: { transform: "translateY(100%)" },
          to: { transform: "translateY(0)" },
        },
        "sheet-out": {
          from: { transform: "translateY(0)" },
          to: { transform: "translateY(100%)" },
        },
        /* Apple: spring scale for modals */
        "modal-in": {
          from: { opacity: "0", transform: "scale(0.95)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        /* Subtle pulse for active nav */
        "pulse-dot": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
        /* Apple: shimmer for loading states */
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        /* AI-native: typing dots that rise & settle (calmer than bounce) */
        "typing-dot": {
          "0%, 60%, 100%": { transform: "translateY(0)", opacity: "0.4" },
          "30%": { transform: "translateY(-4px)", opacity: "1" },
        },
        /* Message entrance — rises gently into place */
        "message-in": {
          from: { opacity: "0", transform: "translateY(10px) scale(0.99)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        /* Soft status breathing for presence indicators */
        "status-breathe": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.7", transform: "scale(0.92)" },
        },
        /* Icon pop for empty-state hero */
        "icon-pop": {
          "0%": { opacity: "0", transform: "scale(0.7)" },
          "70%": { transform: "scale(1.04)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
        "fade-out": "fade-out 0.2s ease-out",
        "sheet-in": "sheet-in 0.4s cubic-bezier(0.32, 0.72, 0, 1)",
        "sheet-out": "sheet-out 0.3s cubic-bezier(0.32, 0.72, 0, 1)",
        "modal-in": "modal-in 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
        "pulse-dot": "pulse-dot 2s ease-in-out infinite",
        shimmer: "shimmer 2s linear infinite",
        "message-in": "message-in 0.35s cubic-bezier(0.16, 1, 0.3, 1) both",
        "status-breathe": "status-breathe 3s ease-in-out infinite",
        "icon-pop": "icon-pop 0.5s cubic-bezier(0.16, 1, 0.3, 1) both",
        "typing-dot": "typing-dot 1.4s ease-in-out infinite",
        "stagger-1": "fade-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) 0.05s both",
        "stagger-2": "fade-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) 0.1s both",
        "stagger-3": "fade-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) 0.15s both",
        "stagger-4": "fade-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) 0.2s both",
        "stagger-5": "fade-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) 0.25s both",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
