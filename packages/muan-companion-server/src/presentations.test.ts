import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverPresentations, listPresentations, resolvePresentation, resolvePresentationDir } from './presentations'

// A real temp directory tree per test rather than a mocked `node:fs`: the
// whole point of this module is what it does against a real filesystem
// (dirents vs. symlinks, missing files, unreadable roots), and a mock would
// only ever assert that the code calls the functions the mock was written
// for.
describe('presentation discovery', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'muan-presentations-test-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** Creates `<root>/<name>/slides.md` with the given contents. */
  function makeDeck(name: string, slides: string, packageJson?: string) {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'slides.md'), slides)
    if (packageJson !== undefined)
      writeFileSync(join(dir, 'package.json'), packageJson)
    return dir
  }

  const WITH_ADDON_FRONTMATTER = `---
title: Intro to Vue
addons:
  - muan-companion
---

# Slide one
`

  describe('an unconfigured root is a no-op, never an error', () => {
    it('returns nothing for an undefined root', () => {
      // The single most important property of this feature: every
      // deployment that predates 032b, and every one that never opts in,
      // must behave exactly as it did before — an empty list, not a throw,
      // not a warning.
      expect(listPresentations(undefined)).toEqual([])
      expect(discoverPresentations(undefined)).toEqual([])
    })

    it('returns nothing for an empty-string root', () => {
      expect(listPresentations('')).toEqual([])
    })

    it('returns nothing for a root that does not exist', () => {
      // A typo'd env var must surface as an empty list on `/home`, not as a
      // crashed request mid-workshop.
      expect(listPresentations(join(root, 'no-such-directory'))).toEqual([])
    })

    it('returns nothing for a root that is a file, not a directory', () => {
      const file = join(root, 'not-a-directory.txt')
      writeFileSync(file, 'hello')
      expect(listPresentations(file)).toEqual([])
    })
  })

  describe('what counts as a presentation', () => {
    it('lists a subdirectory with slides.md declaring the addon in frontmatter', () => {
      makeDeck('intro', WITH_ADDON_FRONTMATTER)

      expect(listPresentations(root)).toEqual([{ id: 'intro', title: 'Intro to Vue' }])
    })

    it('accepts the inline flow form of the addons list', () => {
      makeDeck('flow', '---\naddons: [muan-companion]\n---\n\n# Hi\n')

      expect(listPresentations(root).map(p => p.id)).toEqual(['flow'])
    })

    it('accepts the full package name spelling of the addon', () => {
      makeDeck('full-name', '---\naddons:\n  - slidev-addon-muan-companion\n---\n')

      expect(listPresentations(root).map(p => p.id)).toEqual(['full-name'])
    })

    it('accepts the addon declared only as a package.json dependency', () => {
      makeDeck(
        'via-package-json',
        '---\ntitle: No addons key here\n---\n',
        JSON.stringify({ dependencies: { 'slidev-addon-muan-companion': '^1.0.0' } }),
      )

      expect(listPresentations(root)).toEqual([{ id: 'via-package-json', title: 'No addons key here' }])
    })

    it('accepts the addon declared in devDependencies', () => {
      makeDeck('dev-dep', '---\n---\n', JSON.stringify({ devDependencies: { 'muan-companion': '*' } }))

      expect(listPresentations(root).map(p => p.id)).toEqual(['dev-dep'])
    })

    it('skips a subdirectory with no slides.md at all', () => {
      mkdirSync(join(root, 'not-a-deck'), { recursive: true })
      writeFileSync(join(root, 'not-a-deck', 'README.md'), '# nope')

      expect(listPresentations(root)).toEqual([])
    })

    it('skips a slides.md deck that does not configure the addon', () => {
      // The "falsely presentable" case plan 032 calls out: this deck would
      // start fine and then never sync with anything, which is a failure an
      // operator can only diagnose by noticing that nothing happens.
      makeDeck('plain-slidev', '---\ntitle: Plain deck\n---\n\n# Hi\n')

      expect(listPresentations(root)).toEqual([])
    })

    it('does not accept the addon name appearing outside the addons list', () => {
      // Mentioning the addon in a title is not configuring it.
      makeDeck('mentions-only', '---\ntitle: All about muan-companion\nlayout: cover\n---\n')

      expect(listPresentations(root)).toEqual([])
    })

    it('does not read past the addons block into an unrelated key', () => {
      makeDeck('other-key', '---\naddons:\n  - some-other-addon\nauthor: muan-companion\n---\n')

      expect(listPresentations(root)).toEqual([])
    })

    it('skips a malformed package.json rather than failing the whole scan', () => {
      makeDeck('broken-json', '---\n---\n', '{ not json at all')
      makeDeck('good', WITH_ADDON_FRONTMATTER)

      expect(listPresentations(root).map(p => p.id)).toEqual(['good'])
    })

    it('skips dotfiles, node_modules, and plain files in the root', () => {
      makeDeck('.hidden-deck', WITH_ADDON_FRONTMATTER)
      makeDeck('node_modules', WITH_ADDON_FRONTMATTER)
      writeFileSync(join(root, 'slides.md'), WITH_ADDON_FRONTMATTER)
      makeDeck('real', WITH_ADDON_FRONTMATTER)

      expect(listPresentations(root).map(p => p.id)).toEqual(['real'])
    })

    it('does not follow a symlinked directory out of the configured root', () => {
      // The discovery root has to be a real boundary, not a starting point —
      // 032c will `spawn` inside whatever this returns.
      const outside = mkdtempSync(join(tmpdir(), 'muan-presentations-outside-'))
      try {
        mkdirSync(join(outside, 'escaped'), { recursive: true })
        writeFileSync(join(outside, 'escaped', 'slides.md'), WITH_ADDON_FRONTMATTER)
        symlinkSync(join(outside, 'escaped'), join(root, 'escaped'), 'dir')

        expect(listPresentations(root)).toEqual([])
      }
      finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })

    it('only scans immediate subdirectories, not nested ones', () => {
      const nested = join(root, 'outer', 'inner')
      mkdirSync(nested, { recursive: true })
      writeFileSync(join(nested, 'slides.md'), WITH_ADDON_FRONTMATTER)

      expect(listPresentations(root)).toEqual([])
    })
  })

  describe('title extraction', () => {
    it('falls back to the folder name when there is no frontmatter at all', () => {
      makeDeck('no-frontmatter', '# Just a heading\n', JSON.stringify({ dependencies: { 'muan-companion': '*' } }))

      expect(listPresentations(root)).toEqual([{ id: 'no-frontmatter', title: 'no-frontmatter' }])
    })

    it('falls back to the folder name when frontmatter has no title', () => {
      makeDeck('untitled', '---\naddons:\n  - muan-companion\n---\n')

      expect(listPresentations(root)).toEqual([{ id: 'untitled', title: 'untitled' }])
    })

    it('strips one layer of matching quotes from the title', () => {
      makeDeck('quoted', '---\ntitle: "Quoted: Title"\naddons:\n  - muan-companion\n---\n')
      makeDeck('single', '---\ntitle: \'Single\'\naddons:\n  - muan-companion\n---\n')

      expect(listPresentations(root)).toEqual([
        { id: 'quoted', title: 'Quoted: Title' },
        { id: 'single', title: 'Single' },
      ])
    })

    it('falls back to the folder name for an empty title value', () => {
      makeDeck('blank-title', '---\ntitle:\naddons:\n  - muan-companion\n---\n')

      expect(listPresentations(root)).toEqual([{ id: 'blank-title', title: 'blank-title' }])
    })

    it('tolerates CRLF frontmatter', () => {
      makeDeck('windows', '---\r\ntitle: Windows Deck\r\naddons:\r\n  - muan-companion\r\n---\r\n')

      expect(listPresentations(root)).toEqual([{ id: 'windows', title: 'Windows Deck' }])
    })
  })

  it('returns results sorted by id, so list order is stable across scans', () => {
    makeDeck('zeta', WITH_ADDON_FRONTMATTER)
    makeDeck('alpha', WITH_ADDON_FRONTMATTER)
    makeDeck('mid', WITH_ADDON_FRONTMATTER)

    expect(listPresentations(root).map(p => p.id)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('never exposes a filesystem path in the client-facing projection', () => {
    // The read-side half of the proposal's "never accept a path from a
    // request" principle: a client must not learn the operator's directory
    // layout either.
    makeDeck('intro', WITH_ADDON_FRONTMATTER)

    const [presentation] = listPresentations(root)

    expect(Object.keys(presentation).sort()).toEqual(['id', 'title'])
    expect(JSON.stringify(presentation)).not.toContain(root)
    // The internal shape *does* carry the path — that's the seam 032c uses.
    expect(discoverPresentations(root)[0].dir).toBe(join(root, 'intro'))
  })

  describe('resolvePresentationDir (the id → path direction 032c needs)', () => {
    it('resolves a discovered id to its absolute directory', () => {
      const dir = makeDeck('intro', WITH_ADDON_FRONTMATTER)

      expect(resolvePresentationDir(root, 'intro')).toBe(dir)
    })

    it('returns undefined for an id that names nothing discovered', () => {
      makeDeck('intro', WITH_ADDON_FRONTMATTER)

      expect(resolvePresentationDir(root, 'nope')).toBeUndefined()
      expect(resolvePresentationDir(root, undefined)).toBeUndefined()
      expect(resolvePresentationDir(root, '')).toBeUndefined()
    })

    it('returns undefined for a folder that exists but is not presentable', () => {
      // Resolution is against the *discovered* list, not the filesystem —
      // so a folder discovery rejected can't be reached by naming it.
      makeDeck('plain-slidev', '---\ntitle: Plain deck\n---\n')

      expect(resolvePresentationDir(root, 'plain-slidev')).toBeUndefined()
    })

    it('cannot be made to escape the root with a traversal id', () => {
      makeDeck('intro', WITH_ADDON_FRONTMATTER)
      // No path arithmetic happens at all — every candidate id is compared
      // for equality against strings `readdirSync` just produced as
      // immediate children of the root, and none of these is one of them.
      for (const hostile of ['..', '../..', '../intro', 'intro/..', '/etc', './intro', 'intro/', 'intro\0'])
        expect(resolvePresentationDir(root, hostile)).toBeUndefined()
    })

    it('returns undefined when no root is configured at all', () => {
      expect(resolvePresentationDir(undefined, 'intro')).toBeUndefined()
    })
  })

  describe('resolvePresentation (resolvePresentationDir\'s title-carrying superset)', () => {
    it('resolves a discovered id to its id, title, and absolute directory', () => {
      const dir = makeDeck('intro', WITH_ADDON_FRONTMATTER)

      expect(resolvePresentation(root, 'intro')).toEqual({ id: 'intro', title: 'Intro to Vue', dir })
    })

    it('agrees with resolvePresentationDir on every id resolvePresentationDir rejects', () => {
      makeDeck('intro', WITH_ADDON_FRONTMATTER)
      for (const id of ['nope', undefined, '', '..', '../intro', 'intro/'])
        expect(resolvePresentation(root, id)).toBeUndefined()
    })
  })
})
