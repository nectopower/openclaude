import { startOrRevealRemoteControl } from '../web/remoteControlLauncher.js'

async function main() {
  const result = await startOrRevealRemoteControl()

  if (result.status === 'error') {
    throw new Error(result.message ?? 'Remote Control failed to start')
  }

  if (result.localUrl) {
    console.log(`Remote Control ready at ${result.localUrl}`)
  }

  if (result.publicUrl) {
    console.log(`Public URL: ${result.publicUrl}`)
  }
}

main().catch(error => {
  console.error('Fatal error:', error)
  process.exit(1)
})
