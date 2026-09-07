import path from 'node:path';

export const INSTALLER_VERSION = '1.0.0';
export const DEFAULT_INSTALLER_PORT = 8787;
export const DEFAULT_APP_PORT = 4173;
export const RECOMMENDED_NODE_VERSION = '24.14.0';
export const MIN_NODE_VERSION = '20.0.0';

export const INSTALL_STEPS = [
  { id: 'source', label: 'Download the app', description: 'Pulling the Devil\u2019s Eye source from GitHub' },
  { id: 'extract', label: 'Extract', description: 'Unpacking and verifying the archive' },
  { id: 'runtime', label: 'Runtime', description: 'Preparing Node.js to run the app' },
  { id: 'deps', label: 'Install packages', description: 'Resolving npm dependencies (node_modules)' },
  { id: 'build', label: 'Build', description: 'Compiling the production bundle' },
  { id: 'ready', label: 'Finish', description: 'Writing the launcher and finishing touches' },
];

export const DEFAULT_MANIFEST = Object.freeze({
  name: "Devil's Eye",
  owner: 'R0U5',
  repo: 'Devils-Eye',
  defaultBranch: 'main',
  repoIsPrivate: true,
  installerPort: DEFAULT_INSTALLER_PORT,
  appPort: DEFAULT_APP_PORT,
  recommendedNodeVersion: RECOMMENDED_NODE_VERSION,
  minNodeVersion: MIN_NODE_VERSION,
  homepage: 'https://github.com/R0U5/Devils-Eye',
});

export function normalizeManifest(raw = {}) {
  const merged = { ...DEFAULT_MANIFEST, ...(raw ?? {}) };
  for (const field of ['owner', 'repo', 'defaultBranch']) {
    if (typeof merged[field] !== 'string' || merged[field].length === 0) {
      throw new Error(`Invalid installer manifest: ${field} must be a non-empty string`);
    }
  }
  if (!/^[A-Za-z0-9._-]+$/.test(merged.owner) || !/^[A-Za-z0-9._-]+$/.test(merged.repo)) {
    throw new Error('Invalid installer manifest: owner and repo must be GitHub-safe slug values');
  }
  if (typeof merged.repoIsPrivate !== 'boolean') merged.repoIsPrivate = true;
  if (!Number.isInteger(merged.installerPort) || merged.installerPort < 1 || merged.installerPort > 65535) {
    merged.installerPort = DEFAULT_INSTALLER_PORT;
  }
  if (!Number.isInteger(merged.appPort) || merged.appPort < 1 || merged.appPort > 65535) {
    merged.appPort = DEFAULT_APP_PORT;
  }
  return merged;
}

export function githubArchiveUrl(manifest, branch = manifest.defaultBranch) {
  return `https://github.com/${manifest.owner}/${manifest.repo}/archive/refs/heads/${branch}.zip`;
}

export function resolveSourceUrl(manifest, options = {}) {
  if (typeof options.sourceArchiveUrl === 'string' && options.sourceArchiveUrl.length > 0) {
    return options.sourceArchiveUrl;
  }
  return githubArchiveUrl(manifest, options.branch ?? manifest.defaultBranch);
}

export function authHeaders(token) {
  if (typeof token === 'string' && token.length > 0) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}

export function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

export function satisfiesNodeVersion(actual, minimum) {
  const a = parseSemver(actual);
  const m = parseSemver(minimum);
  if (!a || !m) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > m[i]) return true;
    if (a[i] < m[i]) return false;
  }
  return true;
}

export function nodeDistSpec(version, platform, arch) {
  const key = `${platform}-${arch}`;
  const map = {
    'win32-x64': { platform: 'win-x64', format: 'zip', binRel: 'node.exe', npmRel: 'node_modules/npm/bin/npm-cli.js' },
    'win32-arm64': { platform: 'win-arm64', format: 'zip', binRel: 'node.exe', npmRel: 'node_modules/npm/bin/npm-cli.js' },
    'darwin-x64': { platform: 'darwin-x64', format: 'tar.gz', binRel: 'bin/node', npmRel: 'lib/node_modules/npm/bin/npm-cli.js' },
    'darwin-arm64': { platform: 'darwin-arm64', format: 'tar.gz', binRel: 'bin/node', npmRel: 'lib/node_modules/npm/bin/npm-cli.js' },
    'linux-x64': { platform: 'linux-x64', format: 'tar.gz', binRel: 'bin/node', npmRel: 'lib/node_modules/npm/bin/npm-cli.js' },
    'linux-arm64': { platform: 'linux-arm64', format: 'tar.gz', binRel: 'bin/node', npmRel: 'lib/node_modules/npm/bin/npm-cli.js' },
    'linux-arm': { platform: 'linux-armv7l', format: 'tar.gz', binRel: 'bin/node', npmRel: 'lib/node_modules/npm/bin/npm-cli.js' },
  };
  const spec = map[key];
  if (!spec) {
    throw new Error(`No Node.js distribution for platform "${platform}" arch "${arch}"`);
  }
  const base = `node-v${version}-${spec.platform}`;
  const archiveFile = `${base}.${spec.format}`;
  const distRoot = `https://nodejs.org/dist/v${version}`;
  return {
    archiveName: spec.platform,
    format: spec.format,
    binRel: spec.binRel,
    npmRel: spec.npmRel,
    version,
    archiveFile,
    topDir: base,
    url: `${distRoot}/${archiveFile}`,
    shasumsUrl: `${distRoot}/SHASUMS256.txt`,
  };
}

export function defaultInstallDir(platform, env = {}) {
  if (platform === 'win32') {
    const base = process.env.LOCALAPPDATA || env.localAppData;
    if (base) return path.join(base, 'DevilsEye');
    return path.join(env.homedir ?? '', 'DevilsEye');
  }
  const home = env.homedir ?? process.env.HOME ?? '';
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'DevilsEye');
  return path.join(home, '.local', 'share', 'devils-eye');
}

export function buildDependencyItems({ platform, arch, nodeVersion, minNodeVersion = MIN_NODE_VERSION, recommendedNodeVersion = RECOMMENDED_NODE_VERSION, pythonVersion }) {
  const node = {
    id: 'node',
    label: 'Node.js',
    detail: nodeVersion ? `v${nodeVersion}` : 'not found on PATH',
    required: true,
    status: nodeVersion && satisfiesNodeVersion(nodeVersion, minNodeVersion) ? 'ok' : nodeVersion ? 'old' : 'missing',
  };
  const python = {
    id: 'python',
    label: 'Python + pip (optional)',
    detail: pythonVersion ? `v${pythonVersion}` : 'not found',
    required: false,
    status: 'optional',
    note: 'Only used to regenerate the Axis camera catalog. Not needed to run the globe.',
  };
  const toolchain = {
    id: 'toolchain',
    label: `Bundled Node ${recommendedNodeVersion}`,
    detail: `${platform}-${arch}`,
    required: true,
    status: 'pending',
    note: 'Used to launch the app offline even when the system Node is missing.',
  };
  return [node, python, toolchain];
}

export function planNodeChoices({ platform, arch, nodeVersion, minNodeVersion = MIN_NODE_VERSION, bundleNode }) {
  const systemOk = typeof nodeVersion === 'string' && satisfiesNodeVersion(nodeVersion, minNodeVersion);
  return {
    systemOk,
    bundleNode: bundleNode !== undefined ? Boolean(bundleNode) : !systemOk,
    distArch: nodeDistSpec(RECOMMENDED_NODE_VERSION, platform, arch).platform,
  };
}

export function sha256LineMatch(lines, fileName) {
  for (const line of lines) {
    const match = /^([0-9a-fA-F]{64})  (\*?.+)$/.exec(line.trim());
    if (!match) continue;
    const listed = match[2].replace(/^\*/, '');
    if (listed === fileName) return match[1].toLowerCase();
  }
  return null;
}

export function classifyReachability(statusCode, repoIsPrivate) {
  if (statusCode === 200 || statusCode === 301 || statusCode === 302) return 'ok';
  if (statusCode === 401 || statusCode === 403 || statusCode === 404) {
    return repoIsPrivate ? 'need-token' : 'missing';
  }
  return 'error';
}

export function sanitizeInstallDir(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  const resolved = path.resolve(candidate);
  if (resolved.length < 3) return null;
  return resolved;
}

export function resolveAppPort(manifest, overrides = {}) {
  const value = overrides.appPort ?? manifest.appPort;
  if (!Number.isInteger(value) || value < 1 || value > 65535) return manifest.appPort;
  return value;
}