
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx,html}",
  ],
  theme: {
    extend: {
      colors: {
        appBg: 'rgb(var(--z-app) / <alpha-value>)',
        panelBg: 'rgb(var(--z-panel) / <alpha-value>)',
        surface: 'rgb(var(--z-surface) / <alpha-value>)',
        surfaceHover: 'rgb(var(--z-surface-hi) / <alpha-value>)',
        line: 'rgb(var(--z-line) / <alpha-value>)',
        accent: 'rgb(var(--z-primary) / <alpha-value>)',
        primary: 'rgb(var(--z-primary) / <alpha-value>)',
        primaryHover: 'rgb(var(--z-primary-hover) / <alpha-value>)',
        primaryActive: 'rgb(var(--z-primary-active) / <alpha-value>)',
        primaryText: 'rgb(var(--z-primary-text) / <alpha-value>)',
        danger: '#DA373C',
        success: '#23A559',
        warning: '#FBBF24',
        textMain: 'rgb(var(--z-text) / <alpha-value>)',
        textMuted: 'rgb(var(--z-muted) / <alpha-value>)'
      },
      borderRadius: {
        'md': '0.5rem',
        'lg': '0.75rem',
        'xl': '1rem',
        '2xl': '1.5rem',
        '3xl': '2rem',
        'panel': 'var(--z-r-panel)',
        'modal': 'var(--z-r-modal)',
      }
    },
  },
  plugins: [],
}