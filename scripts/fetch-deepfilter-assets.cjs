const fs = require('fs')
const path = require('path')
const https = require('https')
const crypto = require('crypto')

const MIRROR_BASE = (process.env.DEEPFILTER_CDN_URL || '').replace(/\/+$/, '')
const OUT_DIR = path.resolve(__dirname, '..', 'src', 'renderer', 'public', 'deepfilternet3')
const ALLOW_MISSING = process.argv.includes('--allow-missing')

const ASSETS = [
  {
    rel: 'pkg/df_bg.wasm',
    bytes: 9235331,
    sha256: '6ea100532996aa0a07405fa2265e27337c351fe1cbdf63ac65886373484089c7'
  },
  {
    rel: 'models/DeepFilterNet3_onnx.tar.gz',
    bytes: 7983136,
    sha256: 'c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616'
  }
]

function digestOf(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function verify(file, asset) {
  const size = fs.statSync(file).size
  if (size !== asset.bytes) return `size ${size}, expected ${asset.bytes}`
  const digest = digestOf(file)
  if (digest !== asset.sha256) return `sha256 ${digest}, expected ${asset.sha256}`
  return null
}

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
        resolve(tmp)
      }))
      file.on('error', err => fs.rm(tmp, { force: true }, () => reject(err)))
    })
    req.on('error', reject)
    req.setTimeout(60000, () => req.destroy(new Error('download timeout')))
  })
}

async function restoreFromMirror(asset, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const url = `${MIRROR_BASE}/${asset.rel}`
  console.log(`[deepfilter-assets] ${asset.rel} is absent, restoring from DEEPFILTER_CDN_URL: ${url}`)
  const tmp = await download(url, dest)
  const problem = verify(tmp, asset)
  if (problem) {
    fs.rmSync(tmp, { force: true })
    throw new Error(`mirror served bytes that do not match the pinned digest (${problem})`)
  }
  fs.renameSync(tmp, dest)
  console.log(`[deepfilter-assets] restored and verified ${asset.rel} (${(asset.bytes / 1024 / 1024).toFixed(1)} MB)`)
}

async function main() {
  let missing = false
  let tampered = false

  for (const asset of ASSETS) {
    const dest = path.join(OUT_DIR, ...asset.rel.split('/'))

    if (fs.existsSync(dest)) {
      const problem = verify(dest, asset)
      if (!problem) {
        console.log(`[deepfilter-assets] ok: ${asset.rel} verified`)
        continue
      }
      tampered = true
      console.error(`[deepfilter-assets] INTEGRITY FAILURE on ${asset.rel}: ${problem}`)
      console.error(`[deepfilter-assets] this file is vendored in git; restore it with "git checkout -- src/renderer/public/deepfilternet3/${asset.rel}", or update the pin in this script if you upgraded the asset on purpose`)
      continue
    }

    if (!MIRROR_BASE) {
      missing = true
      console.warn(`[deepfilter-assets] missing: ${asset.rel}`)
      continue
    }

    try {
      await restoreFromMirror(asset, dest)
    } catch (err) {
      missing = true
      console.warn(`[deepfilter-assets] mirror restore failed for ${asset.rel}: ${err.message}`)
    }
  }

  if (tampered) {
    console.error('[deepfilter-assets] aborting: at least one asset failed its pinned SHA-256 check')
    process.exit(1)
  }
  if (missing) {
    console.warn('[deepfilter-assets] DeepFilterNet3 assets are vendored in this repository under src/renderer/public/deepfilternet3/ and are not downloaded from any third party.')
    console.warn('[deepfilter-assets] Restore them with "git checkout -- src/renderer/public/deepfilternet3", or point DEEPFILTER_CDN_URL at your own mirror.')
    if (ALLOW_MISSING) {
      process.exit(0)
    }
    console.error('[deepfilter-assets] aborting: assets are missing and the app never downloads them at runtime, so this build would ship without noise suppression')
    process.exit(1)
  }
  process.exit(0)
}

main()
