import * as fs from 'fs';
import * as path from 'path';

let cachedPackageRoot: string | undefined;

/**
 * Traverses upward from the given directory to find the nearest package.json file,
 * identifying the repository/package root regardless of the caller's process.cwd().
 */
export function getPackageRoot(startDir: string = __dirname): string {
  if (cachedPackageRoot && fs.existsSync(path.join(cachedPackageRoot, 'package.json'))) {
    return cachedPackageRoot;
  }

  let current = path.resolve(startDir);
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'package.json'))) {
      cachedPackageRoot = current;
      return current;
    }
    current = path.dirname(current);
  }

  // Fallback if not found via traversal (e.g. bundled or edge execution)
  cachedPackageRoot = path.resolve(__dirname, '../../');
  return cachedPackageRoot;
}

/**
 * Resolves an application path.
 * 1. Returns absolute paths directly.
 * 2. Checks process.cwd() if file/dir exists there.
 * 3. Checks package root directory if file/dir exists there.
 * 4. Checks ~/.mattermost/ directory if file/dir exists there.
 * 5. Falls back to package root for deterministic writes/reads instead of arbitrary cwd.
 */
export function resolveAppPath(targetPath: string): string {
  if (path.isAbsolute(targetPath)) {
    return targetPath;
  }

  const inCwd = path.resolve(process.cwd(), targetPath);
  if (fs.existsSync(inCwd)) {
    return inCwd;
  }

  const pkgRoot = getPackageRoot();
  const inPkg = path.resolve(pkgRoot, targetPath);
  if (fs.existsSync(inPkg)) {
    return inPkg;
  }

  const homeDir = process.env.HOME || '';
  if (homeDir) {
    const inHome = path.resolve(homeDir, '.mattermost', targetPath);
    if (fs.existsSync(inHome)) {
      return inHome;
    }
  }

  // Default fallback to package root
  return inPkg;
}

export interface ConfigResolutionResult {
  resolvedPath?: string;
  searchedLocations: string[];
}

/**
 * Searches for a configuration file across predefined locations, checking both
 * the current working directory and the package root.
 */
export function resolveConfigFile(
  relativeLocations: string[],
  customPath?: string,
  envVarName?: string
): ConfigResolutionResult {
  const searchedLocations: string[] = [];

  const testLocation = (loc: string): string | undefined => {
    searchedLocations.push(loc);
    if (fs.existsSync(loc)) {
      return loc;
    }
    return undefined;
  };

  // 1. Explicit customPath takes strict precedence; if explicitly specified, do not silently fallback to defaults
  if (customPath) {
    if (path.isAbsolute(customPath)) {
      const match = testLocation(customPath);
      return { resolvedPath: match, searchedLocations };
    }
    const inCwd = testLocation(path.resolve(process.cwd(), customPath));
    if (inCwd) return { resolvedPath: inCwd, searchedLocations };

    const inPkg = testLocation(path.resolve(getPackageRoot(), customPath));
    if (inPkg) return { resolvedPath: inPkg, searchedLocations };

    return { resolvedPath: undefined, searchedLocations };
  }

  // 2. Environment variable override takes strict precedence if set
  if (envVarName) {
    const envVal = process.env[envVarName]?.trim();
    if (envVal) {
      if (path.isAbsolute(envVal)) {
        const match = testLocation(envVal);
        return { resolvedPath: match, searchedLocations };
      }
      const inCwd = testLocation(path.resolve(process.cwd(), envVal));
      if (inCwd) return { resolvedPath: inCwd, searchedLocations };

      const inPkg = testLocation(path.resolve(getPackageRoot(), envVal));
      if (inPkg) return { resolvedPath: inPkg, searchedLocations };

      return { resolvedPath: undefined, searchedLocations };
    }
  }

  // 3. Candidate relative locations (only when no explicit path was requested)
  for (const loc of relativeLocations) {
    // Check cwd
    const inCwd = testLocation(path.resolve(process.cwd(), loc));
    if (inCwd) return { resolvedPath: inCwd, searchedLocations };

    // Check package root
    const inPkg = testLocation(path.resolve(getPackageRoot(), loc));
    if (inPkg) return { resolvedPath: inPkg, searchedLocations };

    // Check user home directory (.mattermost/...)
    const homeDir = process.env.HOME || '';
    if (homeDir) {
      const inHome = testLocation(path.resolve(homeDir, '.mattermost', loc));
      if (inHome) return { resolvedPath: inHome, searchedLocations };
    }
  }

  return { resolvedPath: undefined, searchedLocations };
}
