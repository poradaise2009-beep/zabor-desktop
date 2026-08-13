/**
 * Downloads the DeepFilterNet3 runtime assets (WASM + model) into the renderer
 * public folder so the denoiser works offline and inside the packaged file://
 * app, where fetch() cannot read local resources.
 *
 * The assets are large and license-separate, so they are gitignored and fetched
 * on postinstall / before build instead of being committed. Idempotent: files
 * already present (and large enough) are skipped. Never fails the install/build
 * on network errors — the renderer falls back to the CDN at runtime when online.
 */
const fs = require('fs')
const path = require('path')
const https = require('https')

const CDN_BASE = process.env.DEEPFILTER_CDN_URL || 'https://cdn.laptrinhai.id.vn/deepfilternet3'
const OUT_DIR = path.resolve(__dirname, '..', 'src', 'renderer', 'public', 'deepfilternet3')

const ASSETS = [
  { rel: 'pkg/df_bg.wasm', minBytes: 100 * 1024 },
  { rel: 'models/DeepFilterNet3_onnx.tar.gz', minBytes: 100 * 1024 }
]

function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirectsLeft <= 0) {
          reject(new Error('too many redirects'))
          return
        }
        const next = new URL(res.headers.location, url).href
        resolve(download(next, dest, redirectsLeft - 1))
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      const tmp = `${dest}.download`
      const file = fs.createWriteStream(tmp)
      res.pipe(file)
      file.on('finish', () => file.close(err => {
        if (err) {
          reject(err)
          return
        }
        fs.renameSync(tmp, dest)
        resolve()
      }))
      file.on('error', err => fs.rm(tmp, { force: true }, () => reject(err)))
    })
    req.on('error', reject)
    req.setTimeout(60000, () => req.destroy(new Error('download timeout')))
  })
}

async function main() {
  let missing = false
  for (const asset of ASSETS) {
    const dest = path.join(OUT_DIR, ...asset.rel.split('/'))
    try {
      if (fs.existsSync(dest) && fs.statSync(dest).size >= asset.minBytes) {
        console.log(`[deepfilter-assets] ok: ${asset.rel} already present`)
        continue
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      const url = `${CDN_BASE}/${asset.rel}`
      console.log(`[deepfilter-assets] downloading ${url}`)
      await download(url, dest)
      const size = fs.statSync(dest).size
      if (size < asset.minBytes) throw new Error(`file too small (${size} bytes)`)
      console.log(`[deepfilter-assets] saved ${asset.rel} (${(size / 1024 / 1024).toFixed(1)} MB)`)
    } catch (err) {
      missing = true
      console.warn(`[deepfilter-assets] failed: ${asset.rel}: ${err.message}`)
    }
  }
  if (missing) {
    console.warn('[deepfilter-assets] Some assets are missing. The app will fall back to the CDN at runtime when online. Re-run "node scripts/fetch-deepfilter-assets.cjs" to retry.')
  }
  // Never break install/build on a network error.
  process.exit(0)
}

main()
