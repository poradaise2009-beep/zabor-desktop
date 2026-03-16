/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx,html}",
  ],
  theme: {
    extend: {
      colors: {
        appBg: '#0B0B0B',
        panelBg: '#161618',
        surface: '#222225',
        surfaceHover: '#2A2A2E',
        accent: '#5865F2',
        danger: '#DA373C',
        success: '#23A559',
        textMain: '#F2F3F5',
        textMuted: '#949BA4'
      }
    },
  },
  plugins: [],
}