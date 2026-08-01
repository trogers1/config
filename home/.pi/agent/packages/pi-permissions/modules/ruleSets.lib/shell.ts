import type { Rule } from "../policyHelpers";
import { defaultGuardRules } from "./guards";
import { readOnlyGitRules } from "./git";

export const defaultShellRules: Rule[] = [
  { pattern: "*", decision: "ask" },
  { pattern: "pwd", decision: "allow" },
  { pattern: "cd", decision: "allow" },
  {
    pattern: "printf",
    decision: "deny",
    guidance:
      'printing can reveal secrets. If you just want a separator use `echo "---"`',
  },
  {
    pattern: "echo",
    decision: "deny",
    guidance:
      'echo can reveal secrets. If you just want a separator use `echo "---"`',
  },
  { pattern: 'echo "---"', decision: "allow" },
  { pattern: "cd *", decision: "allow" },
  { pattern: "find *", decision: "allow" },
  { pattern: "cat", decision: "allow" },
  { pattern: "cat *", decision: "allow" },
  { pattern: "sort *", decision: "allow" },
  { pattern: "sort", decision: "allow" },
  { pattern: "sed", decision: "allow" },
  { pattern: "sed *", decision: "allow" },
  { pattern: "ls", decision: "allow" },
  { pattern: "ls *", decision: "allow" },
  { pattern: "wc", decision: "allow" },
  { pattern: "wc *", decision: "allow" },
  { pattern: "file", decision: "allow" },
  { pattern: "file *", decision: "allow" },
  { pattern: "head", decision: "allow" },
  { pattern: "head *", decision: "allow" },
  { pattern: "tail", decision: "allow" },
  { pattern: "tail *", decision: "allow" },
  { pattern: "rg *", decision: "allow" },
  { pattern: "ripgrep *", decision: "allow" },

  { pattern: "true", decision: "allow" },
  { pattern: "rg *", decision: "allow" },
  { pattern: "ripgrep *", decision: "allow" },
  { pattern: "terraform fmt *", decision: "allow" },
  { pattern: "terraform validate", decision: "allow" },
  { pattern: "terraform validate *", decision: "allow" },
  { pattern: "terraform -chdir=* validate", decision: "allow" },
  { pattern: "terraform -chdir=* validate *", decision: "allow" },
  { pattern: "nl", decision: "allow" },
  { pattern: "nl *", decision: "allow" },
];

const readOnlyGuardRules: Rule[] = [
  {
    pattern: "git branch -d*",
    decision: "deny",
    guidance: "Branch deletion is not allowed in the read-only profile.",
  },
  {
    pattern: "git branch -D*",
    decision: "deny",
    guidance: "Branch deletion is not allowed in the read-only profile.",
  },
  {
    pattern: "git branch -m*",
    decision: "deny",
    guidance: "Branch renames are not allowed in the read-only profile.",
  },
  {
    pattern: "git tag -d*",
    decision: "deny",
    guidance: "Tag deletion is not allowed in the read-only profile.",
  },
  {
    pattern: "git tag -f*",
    decision: "deny",
    guidance: "Tag rewrites are not allowed in the read-only profile.",
  },
  {
    pattern: "git remote add*",
    decision: "deny",
    guidance: "Remote creation is not allowed in the read-only profile.",
  },
  {
    pattern: "git remote remove*",
    decision: "deny",
    guidance: "Remote removal is not allowed in the read-only profile.",
  },
  {
    pattern: "git remote rename*",
    decision: "deny",
    guidance: "Remote renames are not allowed in the read-only profile.",
  },
  {
    pattern: "git remote set-url*",
    decision: "deny",
    guidance: "Remote URL changes are not allowed in the read-only profile.",
  },
  {
    pattern: "git worktree add*",
    decision: "deny",
    guidance: "Worktree creation is not allowed in the read-only profile.",
  },
  {
    pattern: "git worktree remove*",
    decision: "deny",
    guidance: "Worktree removal is not allowed in the read-only profile.",
  },
  {
    pattern: "git worktree move*",
    decision: "deny",
    guidance: "Worktree moves are not allowed in the read-only profile.",
  },
  {
    pattern: "git update-ref*",
    decision: "deny",
    guidance: "Reference updates are not allowed in the read-only profile.",
  },
  {
    pattern: "git symbolic-ref*",
    decision: "deny",
    guidance: "Reference updates are not allowed in the read-only profile.",
  },
  {
    pattern: "git checkout -b*",
    decision: "deny",
    guidance: "Branch creation is not allowed in the read-only profile.",
  },
  {
    pattern: "git switch -c*",
    decision: "deny",
    guidance: "Branch creation is not allowed in the read-only profile.",
  },
  {
    pattern: "git merge *",
    decision: "deny",
    guidance: "Merges are not allowed in the read-only profile.",
  },
  {
    pattern: "git rebase *",
    decision: "deny",
    guidance: "Rebases are not allowed in the read-only profile.",
  },
  {
    pattern: "git reset *",
    decision: "deny",
    guidance: "History rewrites are not allowed in the read-only profile.",
  },
  {
    pattern: "git commit *",
    decision: "deny",
    guidance: "Commits are not allowed in the read-only profile.",
  },
  {
    pattern: "git push *",
    decision: "deny",
    guidance: "Pushes are not allowed in the read-only profile.",
  },
  {
    pattern: "git stash push*",
    decision: "deny",
    guidance: "Stash writes are not allowed in the read-only profile.",
  },
  {
    pattern: "git stash drop*",
    decision: "deny",
    guidance: "Stash writes are not allowed in the read-only profile.",
  },
  {
    pattern: "git stash pop*",
    decision: "deny",
    guidance: "Stash writes are not allowed in the read-only profile.",
  },
];

export const readOnlyShellRules: Rule[] = [
  {
    pattern: "*",
    decision: "deny",
    guidance:
      "The read-only profile only permits inspection commands and non-destructive git history queries.",
  },
  { pattern: "pwd", decision: "allow" },
  { pattern: "cd", decision: "allow" },
  { pattern: "cd *", decision: "allow" },
  { pattern: "ls", decision: "allow" },
  { pattern: "ls *", decision: "allow" },
  { pattern: "find *", decision: "allow" },
  { pattern: "cat", decision: "allow" },
  { pattern: "cat *", decision: "allow" },
  { pattern: "sed", decision: "allow" },
  { pattern: "sed *", decision: "allow" },
  { pattern: "sort", decision: "allow" },
  { pattern: "sort *", decision: "allow" },
  { pattern: "rg *", decision: "allow" },
  { pattern: "ripgrep *", decision: "allow" },
  { pattern: "head", decision: "allow" },
  { pattern: "head *", decision: "allow" },
  { pattern: "tail", decision: "allow" },
  { pattern: "tail *", decision: "allow" },
  { pattern: "nl", decision: "allow" },
  { pattern: "nl *", decision: "allow" },
  { pattern: "wc", decision: "allow" },
  { pattern: "wc *", decision: "allow" },
  { pattern: "file", decision: "allow" },
  { pattern: "file *", decision: "allow" },
  ...readOnlyGitRules,
  ...readOnlyGuardRules,
  // Compose the shared guard set last so its specificity-tie winners remain
  // the final authority for destructive/unsafe shell operands.
  ...defaultGuardRules,
];
