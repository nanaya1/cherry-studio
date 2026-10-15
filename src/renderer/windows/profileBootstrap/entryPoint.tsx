import '@renderer/assets/styles/tailwind.css'
import './login.css'
import { createRoot } from 'react-dom/client'

import ProfileBootstrapApp from './ProfileBootstrapApp'

// 引导窗口不初始化业务偏好和数据服务。
createRoot(document.getElementById('root') as HTMLElement).render(<ProfileBootstrapApp />)
