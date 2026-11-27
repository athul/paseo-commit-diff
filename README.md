# Commit Diff

A [Paseo](https://paseo.sh) plugin that adds a **Commits** tab to every workspace: browse any repository's history and open a single commit, or everything between two refs, as a diff styled like Paseo's own Changes view.

Paseo's built-in diff shows what changed in your working tree. Commit Diff covers the other question: *what did this commit, or this branch, actually change?*

## Features

- **Any repository.** It doesn't have to be the workspace's own. Type a path, or pick the workspace folder, a folder one of the workspace's agents is working in, or a recently opened repo.
- **Any ref.** Browse local branches, remote branches and tags without checking them out.
- **Search.** Search commit messages, or use `author:name` and `path:file` (quote paths with spaces: `path:"docs/a b.md"`). Each file header has a History button.
- **Compare.** Pick two commits or refs, or compare the current branch with the default branch in one click. You get the combined `base...head` diff, as a pull request shows it, plus the list of commits in it.
- **Unpushed commits.** These are marked against the upstream branch. Every row shows its file count and `+N −N`, and the list is grouped by day.
- **A diff that looks like Paseo's:**
  - one line-number gutter;
  - green and red line backgrounds, with changed words marked inside a line;
  - syntax colours from Paseo's own highlighter, [`@getpaseo/highlight`](https://www.npmjs.com/package/@getpaseo/highlight);
  - sticky file headers and the changed files as a folder tree;
  - unified or side-by-side, wrap or scroll.
- **More context and large files.** Expand the hidden lines between hunks; load the full diff of a file that was cut for size.
- **Copy and open.** Copy a patch, path or hash; open the commit, file or comparison on GitHub or GitLab.
- **Live updates.** A watcher on `.git` refreshes the list on commit, checkout or fetch, so nothing polls while idle.
- **Keyboard:** `j` and `k` move between commits.

## Install

Plugins have to be enabled on the daemon: **Settings → Plugins → Enable plugins**, or `"pluginsEnabled": true` in the daemon's `config.json`. Then:

```bash
paseo plugin install github:athul/paseo-commit-diff
```

Open it from the Command Center (**⌘K** / **Ctrl+K**) with **Open commit diffs**.

Requires Paseo **0.17.4** or later and git **2.24** or later on the daemon machine.

## Settings

Paseo doesn't share its Appearance settings with plugins, so **Settings → Commit Diff** has copies of the three that affect the diff: **code font**, **code size** and **syntax theme**. Set them to the same values as **Settings → Appearance** and both diff views will match.

## Security

Plugins run unsandboxed on the daemon machine, so here is exactly what this one does:

- It only runs read-only git commands (`log`, `show`, `diff`, `for-each-ref`, `merge-base`, `cat-file`, `format-patch --stdout`, `rev-parse`). It never fetches, pushes, checks out or writes to a repository.
- git is run directly with an argument list, never through a shell.
- Everything the tab sends is checked before git sees it:
  - revisions are limited to a safe character set and can't start with `-` or contain `..` or `:`;
  - commit hashes must be hex;
  - revisions go after `--end-of-options` and paths after `--`, with `GIT_LITERAL_PATHSPECS=1`;
  - searches are passed as fixed strings, not patterns.
- Settings in your git config or the repository's can't make it run diff drivers, text conversions or `core.fsmonitor` hooks (`--no-ext-diff --no-textconv`, `-c core.fsmonitor=false`).
- Remote URLs are reduced to `https://host/org/repo`, with any credentials removed, before the app sees them. The raw URL is never logged.
- Every git call has a timeout and an output size limit.

## Development

```bash
bun install
bun run typecheck
bun run check        # git handlers against a throwaway repo + the diff layout model
paseo plugin install "$PWD"
paseo plugin reload paseo-commit-diff   # after each change
paseo plugin logs paseo-commit-diff
```

| Path | Runs in | What |
|---|---|---|
| `server/git.ts` | daemon | git handlers and the `.git` watcher |
| `server/patch.ts` | daemon | splits `git show` / `git diff` output into one entry per file |
| `server/highlight.ts` | daemon | syntax tokens via `@getpaseo/highlight` |
| `shared/git.ts` | both | the contracts between app and daemon (Zod), plus settings |
| `shared/diff-model.ts` | both | pure layout: file tree, unified/split rows, context gaps, word changes |
| `client/` | app | the tab, commit/range view, ref picker, settings page |

One thing to know if you change the styling: in Paseo's web app, a `fontFamily` set through `StyleSheet.create` in a plugin is ignored. Monospace fonts are therefore set inline.

## Limits

- Very large commits are cut at 3,000 lines per file and 20,000 per commit; **Load full diff** fetches one file in full.
- With wrapping off, the whole diff scrolls sideways together rather than file by file.
- A renamed file shows as added after **Load full diff**.
- `j`/`k` only work after you've clicked inside the tab.

## License

[Apache-2.0](LICENSE). Diff colours, spacing and layout follow Paseo's own viewer ([getpaseo/paseo](https://github.com/getpaseo/paseo), Apache-2.0).
