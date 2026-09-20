export const KB = 1024
export const MB = 1024 * KB
export const GB = 1024 * MB

export const APP_NAME = 'MEA Cowork'
export const LATEST_PRIVACY_POLICY_VERSION = '20260820'

/** 雪浪工匠（sub2api）服务固定 origin：OAuth 授权、令牌与余额 API 都以此为准。 */
// 停用原写死域名，改为构建期可配置（electron.vite.config.ts 通过 define 注入 __XUELANG_API_ORIGIN__，未注入时回退默认值）
// 配置变量：XUELANG_API_ORIGIN（shell/CI 环境导出）；覆盖范围：雪浪/CherryIN OAuth 授权、令牌与余额 API、设置页授权服务器/充值入口。
// 区别于：MAIN_VITE_ORG_SERVER_BASE_URL（企业服务：登录/技能/连接器）、MAIN_VITE_CHERRY_CLOUD_API_ORIGIN（Cherry Cloud 账号服务）。
// export const XUELANG_API_HOST = 'https://api.xuelanglm.com'
export const XUELANG_API_HOST: string =
  typeof __XUELANG_API_ORIGIN__ === 'string' && __XUELANG_API_ORIGIN__.length > 0
    ? __XUELANG_API_ORIGIN__
    : 'https://api.xuelanglm.com'
