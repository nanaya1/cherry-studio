const { CHINA_EDITION, getReleaseChannel } = require('./scripts/release/edition')

module.exports = async function createChinaEditionConfig({ packageMetadata }) {
  const { version } = await packageMetadata.value

  return {
    extends: './electron-builder.yml',
    appId: 'com.meacowork.enterprise.cn',
    extraMetadata: {
      cherryEdition: CHINA_EDITION
    },
    // 企业发布地址未配置时不生成更新源，禁止回落到个人版。
    // publish: { provider: 'generic', url: 'https://releases.cherry-ai.com' }
    publish: process.env.MEA_ENTERPRISE_UPDATE_URL
      ? {
          provider: 'generic',
          url: process.env.MEA_ENTERPRISE_UPDATE_URL,
          channel: getReleaseChannel(version, CHINA_EDITION)
        }
      : null
  }
}
