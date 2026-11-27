Commit Diff adds a Commits tab to every workspace. It lists a repository's history and shows any single commit, or everything between two refs, as a diff styled like Paseo's own Changes view: one line-number gutter, green and red line washes, changed words marked inside a line, syntax colours from Paseo's highlighter, and sticky file headers.

The repository does not have to be the workspace's own. The repository picker searches the workspace folder, your Paseo projects, the folders this workspace's agents are working in, recently opened repositories, and git repositories found under your home folder; you can also type any path. Recent repositories can be removed from the picker and the chips under it. Each tab remembers its repository, branch, search and selection.

## What you can do

- Browse any local branch, remote branch or tag without checking it out.
- Search messages, or filter with `author:name` and `path:file`; a file's header has a History button for the same thing.
- Compare two commits or refs, or the current branch against the default branch, and see the combined diff the way a pull request shows it, with its commits listed.
- See which commits are not on the upstream yet, plus per-commit file counts and line totals, grouped by day.
- Expand hidden context between hunks, load the full diff of a file that was cut for size, switch between unified and side-by-side, and wrap or scroll long lines.
- Copy a commit's patch, a file path or a hash, and open the commit, file or comparison on GitHub or GitLab.
- Move between commits with `j` and `k`.

The list updates by itself when a commit, checkout or fetch happens; a watcher on the repository's `.git` directory drives it, so nothing polls while idle.

## Settings

Paseo does not share its Appearance settings with plugins, so Settings > Commit Diff mirrors the three that matter here: code font, code size and syntax theme. Set them to the same values as Settings > Appearance to make the two diff views match.

## What it reads

To suggest repositories, the picker lists folder names under the daemon user's home folder, up to four levels deep, skipping hidden, dependency and build folders. Apart from the `.git/config` of a repository it finds, to tell a bare repository from a normal one, it reads no file contents, and it stops after a few seconds or 15,000 folders.

Everything else runs as read-only `git` commands on the daemon machine, in the repository you open: `log`, `show`, `diff`, `for-each-ref`, `merge-base` and similar. It never fetches, pushes, checks out or writes to a repository. Revisions and paths from the tab are validated and passed after `--end-of-options` and `--`, and repository config cannot run diff drivers, text conversions or fsmonitor hooks. The remote URL is reduced to its web address with any credentials removed. Nothing is sent anywhere except to your browser when you choose to open a page.

## Limits

- Very large commits are cut at 3,000 lines per file and 20,000 per commit until you load a file in full.
- Long lines scroll together rather than per file, and a renamed file loaded in full shows as added.
- Paseo's native Browse folder dialog is not available to plugins, so folders deeper than the scan are opened by typing their path.
- Requires Paseo 0.17.4 or later and `git` 2.24 or later on the daemon machine.
