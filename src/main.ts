import { cmdMetaSync } from "./meta/sync.js"
import { cmdSampleCollect } from "./samples/collect.js"
import { cmdPresetGenerate } from "./preset/generate.js"
import { cmdScoreCalc } from "./score/calc.js"
import { cmdVerifyLiangshi } from "./verify/liangshi.js"
import { cmdVerifyPreset } from "./verify/preset.js"

export async function run(argv) {
  const [ command = "" ] = argv
  switch (command) {
    case "meta:sync":
      return await cmdMetaSync(argv.slice(1))
    case "sample:collect":
      return await cmdSampleCollect(argv.slice(1))
    case "preset:generate":
      return await cmdPresetGenerate(argv.slice(1))
    case "score:calc":
      return await cmdScoreCalc(argv.slice(1))
    case "verify:liangshi":
      return await cmdVerifyLiangshi(argv.slice(1))
    case "verify:preset":
      return await cmdVerifyPreset(argv.slice(1))
    default:
      console.log(`用法:
  node dist/cli.js meta:sync [--game gs|sr|all]
  node dist/cli.js sample:collect --game gs --uids 242422996,xxxx [--delayMs 20000]
  node dist/cli.js sample:collect --game sr --uids 100843318,xxxx [--delayMs 20000]
  node dist/cli.js sample:collect --game zzz --uids 10000000,xxxx [--delayMs 20000]
  node dist/cli.js preset:generate --game gs [--uid 100000000]
  node dist/cli.js preset:generate --game sr [--uid 100000000]
  node dist/cli.js preset:generate --game zzz [--uid 10000000]
  node dist/cli.js score:calc --game gs --file <PlayerData.json> [--charId 10000002]
  node dist/cli.js score:calc --game sr --file <PlayerData.json> [--charId 1001]
  node dist/cli.js verify:liangshi --uid 100000000 [--games gs,sr]
  node dist/cli.js verify:preset --game gs --uid 100000000 [--threshold 300]
`)
  }
}
