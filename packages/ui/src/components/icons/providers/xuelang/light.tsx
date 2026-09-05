import { type SVGProps, useId } from 'react'

import type { IconComponent } from '../../types'
const XuelangLight: IconComponent = (props: SVGProps<SVGSVGElement>) => {
  const iconId = useId()

  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="none" viewBox="0 0 120 120" {...props}>
      <defs>
        <linearGradient id={`${iconId}-xuelanglight__a`} x1={60} x2={60} y1={0} y2={120} gradientUnits="userSpaceOnUse">
          <stop stopColor="#4563F5" stopOpacity={0} />
          <stop offset={1} stopColor="#3768F4" />
        </linearGradient>
      </defs>
      <rect width={120} height={120} fill="#4563F5" rx={6} />
      <rect width={120} height={120} fill={`url(#${iconId}-xuelanglight__a)`} rx={6} />
      <path
        fill="#fff"
        d="M91 29H31C26.5817 29 23 32.5817 23 37V88C23 92.4183 26.5817 96 31 96H91C95.4183 96 99 92.4183 99 88V78H90V87H32V38H90V47H99V37C99 32.5817 95.4183 29 91 29Z"
      />
      <path fill="#fff" d="M42 43H82V52H66V80H55V57L47 65V52H42V43Z" />
    </svg>
  )
}
export { XuelangLight }
export default XuelangLight
