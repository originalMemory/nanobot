const { appendFileSync, mkdirSync, renameSync, statSync } = require('node:fs');
const path = require('node:path');

function createStreamDiagnostics(directory) {
  const file = path.join(directory, 'stream.jsonl');
  return (record) => {
    try {
      mkdirSync(directory, { recursive: true });
      try {
        if (statSync(file).size > 5 * 1024 * 1024) renameSync(file, `${file}.1`);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...record })}\n`, { mode: 0o600 });
    } catch (error) { console.error('Stream diagnostics write failed:', error.code); }
  };
}

module.exports = { createStreamDiagnostics };
