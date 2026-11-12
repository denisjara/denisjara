/**
 * Algunos tests (tests/app/robustness.test.ts) usan los datos de prueba de public/mock-data, que no se versionan
 * (.gitignore). Si no existen —por ejemplo en GitHub Actions— se generan una vez antes de los tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default async function setup(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  if (fs.existsSync(path.join(root, 'public', 'mock-data', 'meta.json'))) return;
  await import('../../scripts/mock-data'); // el script genera los archivos al importarse
}
