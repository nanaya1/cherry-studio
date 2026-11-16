const company = process.env.MEA_ENTERPRISE_COMPANY

if (!company || !/^[a-z0-9][a-z0-9_-]*$/i.test(company)) {
  throw new Error('MEA_ENTERPRISE_COMPANY must be a safe company identifier')
}

const artifactPrefix = `MEA-Cowork-Enterprise-${company}`

module.exports = {
  extends: './electron-builder.yml',
  win: {
    artifactName: `${artifactPrefix}-\${version}-win-\${arch}-setup.\${ext}`
  },
  nsis: {
    artifactName: `${artifactPrefix}-\${version}-win-\${arch}-setup.\${ext}`
  },
  portable: {
    artifactName: `${artifactPrefix}-\${version}-win-\${arch}-portable.\${ext}`
  },
  mac: {
    artifactName: `${artifactPrefix}-\${version}-\${os}-\${arch}.\${ext}`
  },
  linux: {
    artifactName: `${artifactPrefix}-\${version}-\${os}-\${arch}.\${ext}`
  }
}
