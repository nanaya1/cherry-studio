// The worker must start without importing the business service barrel.
// eslint-disable-next-line barrel/closed
import { startAuthWorker } from './core/profiles/authWorker'

const workerIndex = process.argv.indexOf('--profile-auth-worker')
if (workerIndex >= 0) {
  startAuthWorker(process.argv[workerIndex + 1])
} else {
  void import('./main')
}
