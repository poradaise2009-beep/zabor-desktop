# Third-party notices

ZABOR Desktop is distributed under GPL-3.0-only. It redistributes the third-party
components listed below. Their own licence terms apply to them.

## DeepFilterNet 3 — model weights

- File: `src/renderer/public/deepfilternet3/models/DeepFilterNet3_onnx.tar.gz`
- Size: 7 983 136 bytes
- SHA-256: `c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616`
- Upstream: <https://github.com/Rikorose/DeepFilterNet> (`models/DeepFilterNet3_onnx.tar.gz`)
- Licence: MIT **or** Apache-2.0, at the recipient's option
- Copyright (c) 2021 Hendrik Schröter

The vendored file is byte-identical to the upstream blob (git object
`1c4f4ffe1015fbb4541433cf291234ca32338871`).

If you publish measurements obtained with this model, the upstream project asks that you cite:

> H. Schröter, T. Rosenkranz, A. Escalante-B., A. Maier, *DeepFilterNet: Perceptually
> Motivated Real-Time Speech Enhancement*, INTERSPEECH 2023.

## DeepFilterNet 3 — WebAssembly build

- File: `src/renderer/public/deepfilternet3/pkg/df_bg.wasm`
- Size: 9 235 331 bytes
- SHA-256: `6ea100532996aa0a07405fa2265e27337c351fe1cbdf63ac65886373484089c7`
- Contains: a `wasm32-unknown-unknown` build of the DeepFilterNet Rust implementation
  (MIT or Apache-2.0, copyright (c) 2021 Hendrik Schröter) behind a `wasm-bindgen` wrapper
- Obtained from: <https://github.com/abdullahtalal1122/deepfilternet3-standalone-raw-audio-denoising>
  (npm package `deepfilter-standalone`, MIT), itself derived from
  <https://github.com/phuvinh010701/livekit-deepfilternet3-noise-filter>

This binary is not published by the DeepFilterNet project. It is pinned by size and SHA-256
in `scripts/fetch-deepfilter-assets.cjs`, which refuses to build if the bytes change.

## deepfilter-standalone

- JavaScript loader for the two files above, used at build time only
- Licence: MIT
- Upstream: <https://github.com/abdullahtalal1122/deepfilternet3-standalone-raw-audio-denoising>

## Silero VAD

- File: `src/renderer/public/silero_vad.onnx`
- Licence: MIT
- Upstream: <https://github.com/snakers4/silero-vad>

## RNNoise

- Bundled through the npm package `@timephy/rnnoise-wasm` (Apache-2.0),
  <https://github.com/timephy/rnnoise-wasm>
- RNNoise itself is BSD-3-Clause, Xiph.Org Foundation / Jean-Marc Valin,
  <https://gitlab.xiph.org/xiph/rnnoise>
- The full Apache-2.0 text is at <http://www.apache.org/licenses/LICENSE-2.0>

## ONNX Runtime Web

- Files: `src/renderer/public/ort*.mjs`, `src/renderer/public/ort-wasm-*.wasm`
- Licence: MIT, copyright (c) Microsoft Corporation
- Upstream: <https://github.com/microsoft/onnxruntime>

## MIT licence text

Applies to every component above that is listed as MIT, with the copyright notice given in
that component's entry.

```
Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the Software
without restriction, including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```
