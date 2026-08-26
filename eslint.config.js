import antfu from '@antfu/eslint-config'

export default antfu({
  pnpm: true,
  formatters: {
    markdown: true,
    css: true,
    slidev: {
      files: [
        '**/slides.md',
        '**/template.md',
        '**/example.md',
        'test/fixtures/markdown/**/*.md',
        'packages/vscode/syntaxes/slidev.example.md',
      ],
    },
  },
  ignores: [
    'skills/**/*.md',
    'plans/**',
  ],
})
  .removeRules(
    'vue/no-v-text-v-html-on-component',
    'vue/component-name-in-template-casing',
    'jsonc/sort-array-values',
    'pnpm/yaml-no-duplicate-catalog-item',
  )
  .override('antfu/pnpm/package-json', {
    ignores: [
      'packages/create-theme/template/package.json',
      'packages/create-app/template/package.json',
      // VSCE and OVSX do not support pnpm catalog when reading `@types/vscode`'s version.
      'packages/vscode/package.json',
      // socket.io / socket.io-client aren't in the shared catalog yet (plan
      // 026: deliberately pinned as direct versions in these two new
      // packages — see plans/026-workshop-tracker-m1-slide-sync.md's
      // "Current state" — adding them to the catalog is a separate decision
      // for the maintainer, out of scope for that plan).
      'packages/workshop-tracker-server/package.json',
      'packages/addon-workshop-tracker/package.json',
    ],
  })
  .remove('antfu/markdown/rules')
