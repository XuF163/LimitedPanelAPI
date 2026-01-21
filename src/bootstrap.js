import { setupUtf8, suppressNoisyWarnings } from "./utils/log.js"

export async function bootstrap() {
  setupUtf8()
  suppressNoisyWarnings()
}

