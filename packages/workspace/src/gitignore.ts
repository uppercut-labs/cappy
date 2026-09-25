import { execFile } from "node:child_process";
import path from "node:path";
import { isWithin } from "./paths.js";

export type GitIgnoreStatus = "ignored" | "not_ignored" | "outside_project" | "not_a_repository" | "git_unavailable";

export interface GitIgnoreCheck {
  readonly status: GitIgnoreStatus;
  /** Present when the managed root should be ignored but is not. */
  readonly warning?: string;
}

/**
 * Report whether a project-local managed root is ignored by Git. Cappy only
 * warns; it never edits `.gitignore` on its own.
 */
export async function checkGitIgnore(projectDir: string, root: string): Promise<GitIgnoreCheck> {
  const project = path.resolve(projectDir);
  const managedRoot = path.resolve(root);
  if (!isWithin(project, managedRoot) || managedRoot === project) {
    return { status: "outside_project" };
  }
  const relative = `${path.relative(project, managedRoot).split(path.sep).join("/")}/`;

  const exitCode = await new Promise<number | "missing">((resolve) => {
    execFile("git", ["check-ignore", "--quiet", "--", relative], { cwd: project, windowsHide: true }, (error) => {
      if (error === null) {
        resolve(0);
      } else if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        resolve("missing");
      } else {
        resolve(typeof error.code === "number" ? error.code : 128);
      }
    });
  });

  switch (exitCode) {
    case 0:
      return { status: "ignored" };
    case 1:
      return {
        status: "not_ignored",
        warning: `${relative} is not ignored by Git; add it to .gitignore so generated captures are not committed`,
      };
    case "missing":
      return { status: "git_unavailable" };
    default:
      return { status: "not_a_repository" };
  }
}
