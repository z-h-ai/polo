import { describe, expect, it } from 'bun:test'
import type { RuntimeTask } from '../AppRuntimeTasksContext'
import { runningTasksForTab } from '../AppRuntimeTasksContext'
import {
  appCloseDialogReducer,
  selectFailedTasks,
} from '../AppCloseDialog'
import {
  homeSurfaceViewReducer,
  type HomeSurfaceView,
} from '../HomeViewState'
import { groupRuntimeTasksBySpace } from '../RuntimeCenter'

const TASK_A: RuntimeTask = {
  id: 'task-a',
  appId: 'app-quote',
  tabId: 'tab-quote',
  spaceId: 'space-ent',
  spaceName: '晨星科技',
  kind: 'app',
  title: '整理 10 月报价',
  appName: '报价整理',
  startedAt: 1,
  state: 'running',
}

const TASK_B: RuntimeTask = {
  id: 'task-b',
  appId: 'app-report',
  tabId: 'tab-report',
  spaceId: 'space-ent',
  spaceName: '晨星科技',
  kind: 'app',
  title: '生成月度报表',
  appName: '数据报表生成器',
  startedAt: 2,
  state: 'running',
}

const TASK_C: RuntimeTask = {
  id: 'task-c',
  appId: 'polo-ai',
  spaceId: 'space-personal',
  spaceName: '我的空间',
  kind: 'assistant',
  title: '总结会议录音',
  appName: 'Polo 助手',
  startedAt: 3,
  state: 'running',
}

describe('appCloseDialogReducer (P-M04 close three options)', () => {
  it('starts at choose and stays on dismiss/reset', () => {
    expect(appCloseDialogReducer({ kind: 'choose' }, { type: 'reset' }))
      .toEqual({ kind: 'choose' })
    expect(
      appCloseDialogReducer(
        { kind: 'failed', failedTaskIds: ['task-a'] },
        { type: 'reset' },
      ),
    ).toEqual({ kind: 'choose' })
  })

  it('moves choose → terminating → succeeded(choose) on success', () => {
    const terminating = appCloseDialogReducer(
      { kind: 'choose' },
      { type: 'terminate-started' },
    )
    expect(terminating).toEqual({ kind: 'terminating' })
    expect(
      appCloseDialogReducer(terminating, { type: 'terminate-succeeded' }),
    ).toEqual({ kind: 'choose' })
  })

  it('records only the failed task ids on partial failure', () => {
    const failed = appCloseDialogReducer(
      { kind: 'terminating' },
      { type: 'terminate-failed', failedTaskIds: ['task-b'] },
    )
    expect(failed).toEqual({ kind: 'failed', failedTaskIds: ['task-b'] })
  })

  it('selectFailedTasks filters to the failed subset only', () => {
    const tasks = [TASK_A, TASK_B, TASK_C]
    expect(selectFailedTasks(tasks, ['task-b', 'missing']))
      .toEqual([TASK_B])
    expect(selectFailedTasks(tasks, [])).toEqual([])
  })
})

describe('runningTasksForTab (TabBar close interception)', () => {
  it('matches tasks by tab id or app id and only while running', () => {
    const stopping: RuntimeTask = { ...TASK_B, state: 'stopping' }
    expect(runningTasksForTab([TASK_A, stopping, TASK_C], {
      id: 'tab-quote',
      appId: 'app-quote',
    })).toEqual([TASK_A])
    expect(runningTasksForTab([TASK_C], {
      id: 'tab-quote',
      appId: 'app-quote',
    })).toEqual([])
    expect(runningTasksForTab([], { id: 'tab-quote', appId: 'app-quote' }))
      .toEqual([])
  })
})

describe('groupRuntimeTasksBySpace (P-M04-RUNTIME)', () => {
  it('groups tasks by space preserving first-seen order', () => {
    const groups = groupRuntimeTasksBySpace([TASK_A, TASK_B, TASK_C])
    expect(groups.map(group => group.spaceId))
      .toEqual(['space-ent', 'space-personal'])
    expect(groups[0]!.tasks).toEqual([TASK_A, TASK_B])
    expect(groups[1]!.tasks).toEqual([TASK_C])
  })

  it('returns an empty list for no tasks', () => {
    expect(groupRuntimeTasksBySpace([])).toEqual([])
  })
})

describe('homeSurfaceViewReducer (home | all-apps | inspector | manage | hidden)', () => {
  const home: HomeSurfaceView = { kind: 'home' }

  it('opens the directory and returns home', () => {
    const allApps = homeSurfaceViewReducer(home, { type: 'open-all-apps' })
    expect(allApps).toEqual({ kind: 'all-apps' })
    expect(homeSurfaceViewReducer(allApps, { type: 'go-home' })).toEqual(home)
  })

  it('opens the inspector with its source and resets cleanly', () => {
    const inspector = homeSurfaceViewReducer(home, {
      type: 'inspect',
      id: 'scope-key-1',
      source: 'organization',
    })
    expect(inspector).toEqual({
      kind: 'inspector',
      id: 'scope-key-1',
      source: 'organization',
    })
    expect(homeSurfaceViewReducer(inspector, { type: 'reset' })).toEqual(home)
  })

  it('walks manage → hidden → manage and back home', () => {
    const manage = homeSurfaceViewReducer(home, { type: 'open-manage' })
    expect(manage).toEqual({ kind: 'manage' })
    const hidden = homeSurfaceViewReducer(manage, { type: 'open-hidden' })
    expect(hidden).toEqual({ kind: 'hidden' })
    expect(homeSurfaceViewReducer(hidden, { type: 'open-manage' }))
      .toEqual({ kind: 'manage' })
    expect(homeSurfaceViewReducer(hidden, { type: 'go-home' })).toEqual(home)
  })
})
