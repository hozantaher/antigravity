import { execSync } from 'child_process';

const pkg = '1.0.0';

const getGitSha = (): string => {
  // Docker build injects BUILD_SHA; locally fall back to git
  if (process.env.BUILD_SHA) return process.env.BUILD_SHA;
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
};

const sha = getGitSha();

export const VERSION = `${pkg}+${sha}`;
export const BUILD_SHA = sha;
export const BUILD_TIME = process.env.BUILD_TIME || new Date().toISOString();
