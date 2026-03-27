import { readFileSync } from 'fs';
import { execSync } from 'child_process';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
const version = pkg.version;

execSync(
  `bun build src/index.ts --outdir dist --target bun --minify --define BUILD_VERSION='"${version}"'`,
  { stdio: 'inherit' }
);
