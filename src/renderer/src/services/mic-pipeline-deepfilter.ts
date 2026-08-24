import { registerMicPipeline } from './mic-pipeline-core'
import { DeepFilterEngine } from './deepfilter-engine'

registerMicPipeline('mic-pipeline-deepfilter', () => new DeepFilterEngine())
