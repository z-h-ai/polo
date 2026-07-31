const { validateSourceCliLayout } = require('./packaged-cli-layout.cjs')

module.exports = async function beforePack(context) {
  validateSourceCliLayout(context.packager.projectDir, context.electronPlatformName)
}
