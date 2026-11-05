type JavaService = '认证' | '企业资源'

/** 仅业务提示使用公开msg；系统异常不透传内部诊断。 */
export function javaResponseErrorMessage(code: number, msg: unknown, requestId: unknown, service: JavaService): string {
  let message: string
  switch (code) {
    case 10001:
      message =
        typeof msg === 'string' && msg.trim()
          ? msg
              .replace(/\p{Cc}/gu, ' ')
              .trim()
              .slice(0, 500) || '请求被拒绝，请检查输入或联系管理员'
          : '请求被拒绝，请检查输入或联系管理员'
      break
    case 10007:
      message = service === '认证' ? '无权限执行此操作，请联系管理员' : '无权限访问此资源'
      break
    case 10008:
      message = '会话已失效，请重新登录'
      break
    case 10009:
      message = '验证码错误或已过期，当前客户端暂不支持验证码登录，请联系管理员'
      break
    case 500:
      message = service === '认证' ? '认证服务异常，请稍后重试或联系管理员' : '企业资源服务异常，请稍后重试'
      break
    default:
      message = `${service}服务返回未知业务码（${code}），请联系管理员`
  }
  return typeof requestId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(requestId)
    ? `${message}（请求ID：${requestId}）`
    : message
}
