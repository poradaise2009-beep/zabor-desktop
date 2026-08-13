const { spawnSync } = require('child_process')
const path = require('path')

const workspaceRoot = path.resolve(__dirname, '..')
const electronVersion = require(path.join(workspaceRoot, 'node_modules', 'electron', 'package.json')).version
const nodeGypScript = require.resolve('node-gyp/bin/node-gyp.js', { paths: [workspaceRoot] })
const nativeModuleDir = path.join(workspaceRoot, 'node_modules', 'electron-native-screenshare')

const result = spawnSync(process.execPath, [
  nodeGypScript,
  'rebuild',
  '--directory', nativeModuleDir,
  '--runtime=electron',
  `--target=${electronVersion}`,
  '--dist-url=https://electronjs.org/headers'
], {
  cwd: workspaceRoot,
  env: process.env,
  stdio: 'inherit'
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
