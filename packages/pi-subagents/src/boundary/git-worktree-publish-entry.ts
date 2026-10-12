import { publicationMain } from "./git-worktree-publish-helper.ts";

publicationMain().catch(() => {
  process.exitCode = 1;
});
