import { createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'

import { Route as appTasks } from '../../app/scheduled-tasks'
import { redirectLegacyAppTask } from '../../app/scheduled-tasks.$taskId'
import { Route as detailRoute } from '../scheduled-tasks.$taskId'
import { Route as indexRoute } from '../scheduled-tasks.index'

describe('MEA scheduled task entry points', () => {
  it.each([
    ['/app/scheduled-tasks', {}],
    ['/app/scheduled-tasks?taskId=task-1', { taskId: 'task-1' }],
    [
      '/app/scheduled-tasks?taskId=task-1&runId=run-2&notificationId=notice',
      { taskId: 'task-1', runId: 'run-2', notificationId: 'notice' }
    ],
    [
      '/app/scheduled-tasks?view=result&taskId=task-1&runId=run-2&notificationId=notice',
      { taskId: 'task-1', runId: 'run-2', notificationId: 'notice' }
    ],
    [
      '/app/scheduled-tasks/task-1?runId=run-2&notificationId=notice',
      { taskId: 'task-1', runId: 'run-2', notificationId: 'notice' }
    ]
  ])('opens the unified workspace and preserves the requested run from %s', async (url, expectedSearch) => {
    const root = createRootRoute()
    const app = createRoute({ getParentRoute: () => root, path: '/app' })
    const tasks = createRoute({
      getParentRoute: () => app,
      path: '/scheduled-tasks',
      validateSearch: appTasks.options.validateSearch
    })
    const index = createRoute({ getParentRoute: () => tasks, path: '/' })
    const detail = createRoute({ getParentRoute: () => tasks, path: '/$taskId', beforeLoad: redirectLegacyAppTask })
    const router = createRouter({
      routeTree: root.addChildren([app.addChildren([tasks.addChildren([index, detail])])]),
      history: createMemoryHistory({ initialEntries: [url] })
    })

    await router.load()

    expect(router.state.matches.at(-1)?.pathname.replace(/\/$/, '')).toBe('/app/scheduled-tasks')
    expect(router.state.matches.at(-1)?.search).toMatchObject(expectedSearch)
  })
})

describe('legacy scheduled task links', () => {
  it.each([
    { path: '/settings/scheduled-tasks', search: {} },
    { path: '/settings/scheduled-tasks/task-1', search: { taskId: 'task-1' } },
    {
      path: '/settings/scheduled-tasks/task-1?notificationId=notice&runId=run-2',
      search: { taskId: 'task-1', notificationId: 'notice', runId: 'run-2' }
    }
  ])('opens the dedicated task page from $path', async ({ path, search }) => {
    const root = createRootRoute()
    const settings: typeof indexRoute.types.parentRoute.types.parentRoute = createRoute({
      getParentRoute: () => root,
      path: '/settings'
    })
    const tasks: typeof indexRoute.types.parentRoute = createRoute({
      getParentRoute: () => settings,
      path: '/scheduled-tasks'
    })
    const index = createRoute({
      getParentRoute: () => tasks,
      path: '/',
      beforeLoad: indexRoute.options.beforeLoad
    })
    const detail = createRoute({
      getParentRoute: () => tasks,
      path: '/$taskId',
      validateSearch: detailRoute.options.validateSearch,
      beforeLoad: detailRoute.options.beforeLoad
    })
    const destination = createRoute({ getParentRoute: () => root, path: '/app/scheduled-tasks' })
    const history = createMemoryHistory({ initialEntries: ['/app/chat', path], initialIndex: 1 })
    const router = createRouter({
      routeTree: root.addChildren([settings.addChildren([tasks.addChildren([index, detail])]), destination]),
      history
    })
    await router.load()
    expect(router.state.location.pathname).toBe('/app/scheduled-tasks')
    expect(router.state.location.search).toEqual(search)
    expect(history.length).toBe(2)
    history.back()
    expect(history.location.pathname).toBe('/app/chat')
  })
})
