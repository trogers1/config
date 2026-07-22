import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

const { sql, records, dbPath } = workerData;
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

const statement = db.prepare(sql);
for (const record of records) {
	statement.run(record);
}

db.close();
parentPort.postMessage(records.length);
