// Git's repository-local variables (`git rev-parse --local-env-vars`) would aim a command's Git at
// the parent's repository, index, or config instead of the repository in its own cwd.
const GIT_LOCAL_ENV_KEYS: ReadonlySet<string> = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
]);
const GIT_CONFIG_ENTRY_KEY = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u;

export const isGitLocalEnvironmentKey = (key: string): boolean =>
  GIT_LOCAL_ENV_KEYS.has(key) || GIT_CONFIG_ENTRY_KEY.test(key);
