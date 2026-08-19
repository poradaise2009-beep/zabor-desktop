import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Секрет подписи сборки. Берётся из переменной окружения (GitHub Actions secrets)
// либо из локального `.env` — он в .gitignore, в репозиторий секрет не попадает.
// Внедряется ТОЛЬКО в main-бандл: в renderer он оказался бы в читаемом коде страницы.
// Без секрета сборка считается неофициальной и подпись не отправляет.
// Подробности: docs/client-attestation.md
const fileEnv = loadEnv(process.env.NODE_ENV === 'development' ? 'development' : 'production', process.cwd(), '')
const clientSecret = process.env.ZABOR_CLIENT_SECRET || fileEnv.ZABOR_CLIENT_SECRET || ''
const clientChannel =
  process.env.ZABOR_CLIENT_CHANNEL || fileEnv.ZABOR_CLIENT_CHANNEL || (clientSecret ? 'official' : 'unofficial')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __ZABOR_CLIENT_SECRET__: JSON.stringify(clientSecret),
      __ZABOR_CLIENT_CHANNEL__: JSON.stringify(clientChannel)
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true
    }
  }
})