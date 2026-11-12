// Script perawatan standalone: refresh rute basi + spot-check.
// Dipakai system cron sebagai alternatif timer di dalam service, mis:
//   0 3 * * * OPENONGKIR_DB=/opt/openongkir/data/openongkir.db node /opt/openongkir/scripts/refresh.js
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { createHarvester } from '../src/harvester.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.OPENONGKIR_DB || join(ROOT, 'data', 'openongkir.db');
const refreshLimit = Number(process.env.OPENONGKIR_REFRESH_LIMIT || 10);
const spotCheckLimit = Number(process.env.OPENONGKIR_SPOTCHECK_LIMIT || 5);

const db = openDb(dbPath);
const harvester = createHarvester({ db });
try {
  const out = await harvester.runDailyMaintenance({ refreshLimit, spotCheckLimit });
  console.log(JSON.stringify(out, null, 2));
} finally {
  db.close();
}
