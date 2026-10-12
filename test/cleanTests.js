const fs = require('node:fs');
const path = require('node:path');

fs.rmSync(path.resolve(__dirname, '..', '.test-dist'), { recursive: true, force: true });
