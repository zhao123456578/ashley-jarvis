const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const distRoot = path.join(projectRoot, 'dist');

const nativeDestination = path.join(distRoot, 'native');
fs.rmSync(nativeDestination, { recursive: true, force: true });
fs.mkdirSync(nativeDestination, { recursive: true });
// Windows version: ship the PowerShell window-occupancy helper as a real file
// so it can be unpacked from asar and executed via powershell.exe.
fs.copyFileSync(
  path.join(projectRoot, 'src', 'native', 'window-status.ps1'),
  path.join(nativeDestination, 'window-status.ps1')
);

for (const directory of ['renderer', 'assets']) {
  const source = path.join(projectRoot, directory === 'renderer' ? 'src' : '', directory);
  const destination = path.join(distRoot, directory);

  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) => {
      if (directory === 'renderer') return !entry.endsWith('.ts');
      return path.basename(entry) !== 'model.original.glb';
    }
  });
}

fs.cpSync(
  path.join(projectRoot, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco'),
  path.join(distRoot, 'renderer', 'draco'),
  { recursive: true }
);

const wakePackageRoot = path.dirname(require.resolve('openwakeword-wasm-browser/package.json'));
const wakeDestination = path.join(distRoot, 'assets', 'wake-word');
const wakeModelDestination = path.join(wakeDestination, 'models');
fs.mkdirSync(wakeModelDestination, { recursive: true });
for (const file of [
  'melspectrogram.onnx',
  'embedding_model.onnx',
  'silero_vad.onnx',
  'hey_jarvis_v0.1.onnx'
]) {
  fs.copyFileSync(path.join(wakePackageRoot, 'models', file), path.join(wakeModelDestination, file));
}

const ortEntry = require.resolve('onnxruntime-web', { paths: [wakePackageRoot] });
const ortDestination = path.join(wakeDestination, 'ort');
fs.mkdirSync(ortDestination, { recursive: true });
for (const file of [
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.wasm'
]) {
  fs.copyFileSync(path.join(path.dirname(ortEntry), file), path.join(ortDestination, file));
}
