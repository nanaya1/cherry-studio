import type { CompoundIcon, CompoundIconProps } from '../../types'
import { XuelangAvatar } from './avatar'
import { XuelangLight } from './light'

const Xuelang = ({ variant, className, ...props }: CompoundIconProps) => {
  if (variant === 'light') return <XuelangLight {...props} className={className} />
  return <XuelangLight {...props} className={className} />
}

export const XuelangIcon: CompoundIcon = /*#__PURE__*/ Object.assign(Xuelang, {
  Avatar: XuelangAvatar,
  colorPrimary: '#4563F5'
})

export default XuelangIcon
