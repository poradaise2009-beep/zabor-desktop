import { registerMicPipeline } from './mic-pipeline-core'
import { RnnoiseEngine } from './rnnoise-engine'

registerMicPipeline('mic-pipeline-rnnoise', () => new RnnoiseEngine())
