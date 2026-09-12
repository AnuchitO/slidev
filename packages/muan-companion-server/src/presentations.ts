import { Buffer } from 'node:buffer'
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'pathe'

/**
 * One presentable Slidev deck discovered under the configured root — plan
 * 032's "Presentation" concept: *something presentable, not necessarily
 * running*, as distinct from a live `RoomState` ("Session") in `session.ts`.
 *
 * **This is the shape that crosses the wire**, and it deliberately has no
 * path field. See `DiscoveredPresentation` below for the internal shape that
 * does, and `resolvePresentationDir` for the only supported way to get from
 * one to the other.
 */
export interface Presentation {
  /**
   * Stable identifier for this deck. **The immediate subdirectory's own
   * basename**, chosen over a hash of the path for three reasons:
   *
   * 1. It is unique by construction. Every presentation is an *immediate*
   *    child of one configured root, and a directory cannot contain two
   *    entries with the same name — so collisions are impossible within a
   *    single root, and there is only ever one root. A hash would buy
   *    nothing here and cost the operator a legible id in logs/URLs.
   * 2. It is stable across restarts and across machines that lay the decks
   *    out at different absolute paths (a hash of the absolute path is
   *    neither), which matters because 032c will put this id in a launch
   *    request and this project's own deployment story (`Dockerfile`) mounts
   *    the deck tree at a path that need not match the authoring machine's.
   * 3. It is what an operator would guess when reading a log line.
   *
   * It reveals the folder name and nothing else — not the root, not the
   * absolute path, not the operator's directory layout (see the module
   * comment on `resolvePresentationDir`). A folder name is information the
   * operator chose to expose by putting the folder in the discovery root; an
   * absolute path is information about the host that no client has any
   * business learning.
   */
  id: string
  /**
   * Human-readable name for the deck: `slides.md`'s frontmatter `title:` if
   * it has one, else the folder name (i.e. the same string as `id`). Slidev
   * itself treats frontmatter `title` as the deck's title, so this matches
   * what the presenter already sees in their own browser tab.
   */
  title: string
}

/**
 * A `Presentation` plus the server-side-only absolute path it resolves to.
 * **Never serialized** — `listPresentations` below is the projection that
 * drops `dir`, and it is the only thing any route is allowed to return.
 * Exported solely because `discoverPresentations` returns it (a declaration
 * file cannot reference a private name), not as an invitation to hand one to
 * a client.
 */
export interface DiscoveredPresentation extends Presentation {
  /** Absolute path to the deck folder. Server-side only — see `Presentation`. */
  dir: string
}

/**
 * The Slidev entry deck every presentation must have. Slidev's own default
 * entry filename (`slidev` with no argument opens `slides.md`), so requiring
 * it is not an extra convention this package invents — it is the one file a
 * deck folder is guaranteed to have if `slidev dev` in that folder is
 * expected to work at all, which is exactly what 032c will do with it.
 */
const ENTRY_DECK_FILENAME = 'slides.md'

/**
 * How much of `slides.md` is read to look for frontmatter. Frontmatter is by
 * definition the very start of the file, so reading the whole deck — which
 * can be megabytes once base64 images are inlined — to find a `title:` in
 * its first twenty lines would be wasted I/O on every single discovery
 * scan. 16 KiB is far more than any realistic headmatter block and is read
 * with one `readSync` rather than streamed.
 */
const FRONTMATTER_READ_BYTES = 16 * 1024

/**
 * What counts as "this deck has the companion addon configured".
 *
 * Slidev addons are referenced either by their full package name
 * (`slidev-addon-muan-companion`) or by the short form Slidev resolves
 * against that prefix (`muan-companion`) — see this repo's
 * `packages/addon-muan-companion`. Matching on the *substring*
 * `muan-companion` covers both spellings plus a relative path reference
 * (`../addon-muan-companion`, which is how this monorepo's own demo decks
 * would point at it) without needing to model Slidev's addon-resolution
 * rules here.
 */
const ADDON_MARKER = 'muan-companion'

/**
 * Directory entries that are never presentations, skipped before any file
 * access. `node_modules` is the one that actually matters (a deck tree with
 * a hoisted install at its root would otherwise be stat-ed for a
 * `slides.md`); dotfiles cover `.git`, `.DS_Store` and friends.
 */
function isSkippedEntry(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules'
}

/**
 * Reads at most `maxBytes` from the *start* of a file. Sync (this whole
 * module is sync — it is called from a request handler that has to answer
 * with a list, and the alternative is threading async through
 * `createMuanCompanionServer`'s construction for a directory listing) and
 * bounded, so a pathological `slides.md` cannot turn a discovery scan into a
 * multi-megabyte read. Returns `''` if the file can't be opened at all,
 * which every caller treats as "no frontmatter", never as an error worth
 * failing the whole scan over.
 */
function readFilePrefix(path: string, maxBytes: number): string {
  let fd: number
  try {
    fd = openSync(path, 'r')
  }
  catch {
    return ''
  }
  try {
    const buffer = Buffer.alloc(maxBytes)
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  }
  catch {
    return ''
  }
  finally {
    closeSync(fd)
  }
}

/**
 * Extracts the raw text of a Markdown file's leading frontmatter block — the
 * lines between the opening `---` and the next `---` on its own line.
 * Returns `''` when the file doesn't start with a frontmatter fence, which
 * is a perfectly ordinary Slidev deck (frontmatter is optional).
 *
 * Deliberately **not** a YAML parse. This package has no YAML dependency and
 * adding one to read two fields out of a headmatter block would be
 * over-engineering the detection step that plan 032b explicitly warns
 * against. The two things read out of this block below (`title:` and the
 * `addons:` list) are both used in ways where a false negative is safe — a
 * deck with exotic YAML falls back to its folder name for the title, or
 * fails the addon check and is left off the list, which is the fail-closed
 * direction.
 */
function extractFrontmatter(source: string): string {
  // `\r\n` tolerated so a deck authored on Windows isn't silently
  // undiscoverable — the fence check is the one place a stray `\r` would
  // otherwise make every line fail to match.
  const normalized = source.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n'))
    return ''
  const end = normalized.indexOf('\n---', 3)
  return end === -1 ? '' : normalized.slice(4, end + 1)
}

/**
 * Pulls `title:` out of a frontmatter block. Strips one layer of matching
 * quotes (YAML's two string forms) and trims, so `title: "Intro to Vue"`,
 * `title: 'Intro to Vue'` and `title: Intro to Vue` all yield the same
 * thing. Returns `undefined` for a missing or empty title, so the caller can
 * fall back to the folder name rather than showing a blank row.
 */
function extractTitle(frontmatter: string): string | undefined {
  // No `[ \t]*` before the capture: the capture is trimmed below anyway, and
  // two adjacent whitespace-accepting quantifiers is the shape that gives a
  // regex super-linear backtracking on a hostile input.
  const match = /^title:(.*)$/m.exec(frontmatter)
  if (!match)
    return undefined
  const raw = match[1].trim()
  const unquoted = /^(['"])(.*)\1$/.exec(raw)
  return (unquoted ? unquoted[2] : raw) || undefined
}

/**
 * Decides whether a deck folder actually has the companion addon wired up.
 *
 * **Why check at all**: plan 032's Presentation definition is explicit that
 * a folder counts only if the addon is configured, "so folders that can't
 * actually sync don't show up as falsely presentable". A deck without the
 * addon will start fine under 032c and then simply never appear in any
 * session — a failure the operator can only diagnose by noticing that
 * nothing happens, which is exactly the kind of silent wrong-looking-right
 * state this check exists to prevent.
 *
 * **What is actually checked** (both places Slidev/npm allow the addon to be
 * declared, either one sufficing):
 * 1. `slides.md`'s frontmatter `addons:` block, matched by substring against
 *    `ADDON_MARKER` on the lines following it. The match is scoped to the
 *    `addons:` block rather than the whole frontmatter so that a deck
 *    merely _mentioning_ the addon in, say, its `title` doesn't qualify.
 * 2. Any dependency key in the folder's `package.json` containing the same
 *    marker (`dependencies`, `devDependencies`, `peerDependencies`,
 *    `optionalDependencies`) — the other, equally valid way a deck pulls the
 *    addon in, and the one this monorepo's own packages would use.
 *
 * **What is deliberately not checked**: whether the addon actually resolves
 * on disk, whether its version is compatible, or whether the deck's Slidev
 * version matches this server's. Those are real questions with real answers
 * only at spawn time (032c), and answering them here would mean resolving
 * node module trees during a directory listing. Discovery's job is to filter
 * out the obviously-unpresentable, not to guarantee a successful launch.
 */
function hasCompanionAddon(dir: string, frontmatter: string): boolean {
  if (frontmatterDeclaresAddon(frontmatter))
    return true
  return packageJsonDeclaresAddon(dir)
}

function frontmatterDeclaresAddon(frontmatter: string): boolean {
  const lines = frontmatter.split('\n')
  const addonsIndex = lines.findIndex(line => line.startsWith('addons:'))
  if (addonsIndex === -1)
    return false
  // Inline flow form: `addons: [muan-companion]` — everything is on the
  // `addons:` line itself, so there is no block to walk.
  if (lines[addonsIndex].slice('addons:'.length).includes(ADDON_MARKER))
    return true
  // Block form: consume the indented `- item` lines that follow, stopping at
  // the first line that isn't one (i.e. the next top-level frontmatter key).
  for (let i = addonsIndex + 1; i < lines.length; i++) {
    if (!/^\s+-\s/.test(lines[i]))
      break
    if (lines[i].includes(ADDON_MARKER))
      return true
  }
  return false
}

function packageJsonDeclaresAddon(dir: string): boolean {
  const source = readFilePrefix(join(dir, 'package.json'), FRONTMATTER_READ_BYTES)
  if (!source)
    return false
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  }
  catch {
    // A truncated (over `FRONTMATTER_READ_BYTES`) or malformed
    // `package.json` is not an error worth failing the scan over — it just
    // means this half of the check can't answer, and the frontmatter half
    // above already didn't. Fail closed: the folder isn't listed.
    return false
  }
  if (typeof parsed !== 'object' || parsed === null)
    return false
  const record = parsed as Record<string, unknown>
  return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some((field) => {
    const deps = record[field]
    if (typeof deps !== 'object' || deps === null)
      return false
    return Object.keys(deps).some(name => name.includes(ADDON_MARKER))
  })
}

/**
 * Scans the immediate subdirectories of `rootDir` for presentable decks.
 *
 * `rootDir` is **configuration, never client input** — it arrives from
 * `SLIDEV_MUAN_COMPANION_PRESENTATIONS_DIR` via
 * `CreateMuanCompanionServerOptions.presentationsDir`, and nothing in the
 * request path can influence it. That is the whole reason this can be a
 * plain filesystem scan with no traversal defenses of its own: there is no
 * attacker-controlled component in any path this function builds.
 *
 * An unset/empty root returns `[]` rather than throwing, and so does a root
 * that doesn't exist or isn't readable. **This feature is opt-in and must be
 * a complete no-op for every deployment that doesn't opt in** — an operator
 * running this server exactly as they did before 032b must not get a startup
 * crash, a warning, or a behavior change because a new env var they've never
 * heard of is unset. "No presentations configured" and "the configured
 * directory has no decks in it" are the same, unremarkable, empty state.
 *
 * Results are sorted by id so the home view's list order is stable across
 * scans regardless of what `readdirSync` returns on a given filesystem.
 */
export function discoverPresentations(rootDir: string | undefined): DiscoveredPresentation[] {
  if (!rootDir)
    return []

  let entries: string[]
  try {
    entries = readdirSync(rootDir, { withFileTypes: true })
      // Symlinked directories are deliberately **not** followed. A symlink is
      // the one entry in this listing whose target can be anywhere on the
      // host, which would quietly turn "one configured directory" into "one
      // configured directory plus wherever its symlinks point" — and 032c
      // will `spawn` inside whatever this returns. Restricting to real
      // directories keeps the discovery root a genuine boundary rather than a
      // starting point. An operator who wants a deck from elsewhere can
      // bind-mount or copy it in, which is an explicit act.
      .filter(entry => entry.isDirectory() && !isSkippedEntry(entry.name))
      .map(entry => entry.name)
  }
  catch {
    // Unset-but-wrong is treated exactly like unset: a root that doesn't
    // exist, isn't a directory, or isn't readable by this process yields no
    // presentations rather than an exception that would take down whichever
    // request or startup path asked. The operator's signal that they got the
    // path wrong is an empty list on `/home`, not a crashed server
    // mid-workshop.
    return []
  }

  const presentations: DiscoveredPresentation[] = []
  for (const name of entries) {
    const dir = join(rootDir, name)
    const entryDeck = join(dir, ENTRY_DECK_FILENAME)
    try {
      if (!statSync(entryDeck).isFile())
        continue
    }
    catch {
      // No `slides.md` — not a Slidev deck folder, skip silently. This is
      // the common case for any non-deck directory that happens to sit in
      // the root, not an error condition.
      continue
    }

    const frontmatter = extractFrontmatter(readFilePrefix(entryDeck, FRONTMATTER_READ_BYTES))
    if (!hasCompanionAddon(dir, frontmatter))
      continue

    presentations.push({ id: name, title: extractTitle(frontmatter) ?? name, dir })
  }
  return presentations.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * The client-facing projection of `discoverPresentations` — id and title
 * only. This is what `GET /api/presentations` serializes, and the *only*
 * shape that is ever allowed to leave this process.
 *
 * Its own function rather than a `.map()` at the one call site so that
 * "strip the path" is a named, testable step that a future field addition
 * has to pass through, instead of an easily-forgotten inline transform. The
 * proposal's Security section is explicit that a client must never learn a
 * filesystem path; applied to the read side, that means the stripping
 * happens here, once, and not in the route handler where a later refactor
 * could reasonably decide to "just return the discovered objects".
 */
export function listPresentations(rootDir: string | undefined): Presentation[] {
  return discoverPresentations(rootDir).map(({ id, title }) => ({ id, title }))
}

/**
 * Resolves a client-supplied presentation **id** to the absolute directory
 * it names, or `undefined` if it names none.
 *
 * This is the id → path direction plan 032's Security section is about:
 * _"Never accept a filesystem path from a request... the Present action
 * must take a Presentation id resolved server-side against the discovered
 * list"_.
 * The resolution is deliberately an **exact-match lookup against a freshly
 * scanned list**, not a `join(rootDir, id)`:
 *
 * - `join(rootDir, id)` with a hostile id (`../../etc`, an absolute path, a
 *   percent-decoded traversal) escapes the root, and defending it would mean
 *   normalizing and prefix-checking — the pattern plan 010 had to fix in
 *   `getSlidePath` after it went wrong once already.
 * - An exact match against `readdirSync` output cannot escape anything: the
 *   only ids that resolve are strings the filesystem itself just produced as
 *   immediate children of the root. `..` is not among them, and neither is
 *   any string containing a separator. There is no normalization step to get
 *   wrong because there is no path arithmetic at all.
 *
 * Re-scanning per call (rather than caching the listing at boot) is also
 * deliberate: a deck folder added, removed, or renamed while the server runs
 * is reflected immediately, and a stale cache can never hand 032c a path to
 * a directory that no longer exists.
 *
 * Nothing in 032b calls this — 032b is read-only and deliberately spawns
 * nothing. It exists now, next to the discovery it is the inverse of and
 * with the test coverage that pins its traversal behavior down, so that
 * 032c's launcher has one obvious correct way to get a path and no reason to
 * invent a second.
 */
export function resolvePresentationDir(rootDir: string | undefined, id: string | undefined): string | undefined {
  if (!id)
    return undefined
  return discoverPresentations(rootDir).find(presentation => presentation.id === id)?.dir
}
