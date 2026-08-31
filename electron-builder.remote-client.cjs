const rootPackage = require('./package.json')

module.exports = {
  appId: 'com.kangfenmao.CherryStudioClient',
  productName: 'Cherry Studio Client',
  directories: {
    app: 'packages/desktop-client',
    buildResources: 'build',
    output: 'dist-client'
  },
  files: [
    'package.json',
    {
      from: '../../out-client',
      to: 'out-client',
      filter: ['**/*']
    }
  ],
  extraMetadata: {
    main: 'out-client/main/main.js',
    version: rootPackage.version
  },
  beforeBuild: () => false,
  asar: true,
  mac: {
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize: false,
    artifactName: '${productName}-${version}-${arch}.${ext}',
    target: [{ target: 'dmg' }, { target: 'zip' }]
  },
  win: {
    executableName: 'Cherry Studio Client',
    artifactName: '${productName}-${version}-${arch}-setup.${ext}',
    target: [{ target: 'nsis' }]
  },
  linux: {
    executableName: 'cherry-studio-client',
    artifactName: '${productName}-${version}-${arch}.${ext}',
    category: 'Utility',
    target: [{ target: 'AppImage' }, { target: 'deb' }]
  }
}
