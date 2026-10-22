import { writeFile } from 'node:fs/promises';
import { ReviewSchema } from './schema.js';

// JSON is a generated reference for agents; runtime types and validation share TypeBox.
await writeFile(
  new URL('../../scripts/flow.schema.json', import.meta.url),
  `${JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', ...ReviewSchema }, null, 2)}\n`,
  'utf8',
);
