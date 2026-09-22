import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

/**
 * 运行任务注册表（POO-70 WS-HOME-APPS）。
 *
 * TabBar 的运行 pill、关闭三选项拦截和运行状态中心都从这里读数据。
 * 产品内的真实任务数据来源（App SDK 后台请求 + 助手生成事件）由主
 * agent 接线（见 .ws-requests/WS-HOME-APPS.md）；未挂 Provider 时使用
 * 空默认值，TabBar 行为与接入前完全一致。
 */

export interface RuntimeTask {
  id: string
  /** 任务归属的 App / 助手。 */
  appId: string
  /** 产生任务的标签页（如有）。 */
  tabId?: string
  spaceId: string
  spaceName: string
  kind: 'app' | 'assistant'
  /** 任务标题（如「生成 10 月报表」）。 */
  title: string
  appName: string
  startedAt: number
  state: 'running' | 'stopping'
}

export interface AppRuntimeTasksContextValue {
  tasks: RuntimeTask[]
  runningCount: number
  runtimeCenterOpen: boolean
  openRuntimeCenter: () => void
  closeRuntimeCenter: () => void
  toggleRuntimeCenter: () => void
  /** 停止单个任务；失败时 reject（调用方决定 UI 反馈）。 */
  stopTask: (taskId: string) => Promise<void>
  openTask: ((task: RuntimeTask) => void) | null
}

const NO_OP = () => {}

const AppRuntimeTasksContext = createContext<AppRuntimeTasksContextValue>({
  tasks: [],
  runningCount: 0,
  runtimeCenterOpen: false,
  openRuntimeCenter: NO_OP,
  closeRuntimeCenter: NO_OP,
  toggleRuntimeCenter: NO_OP,
  stopTask: async () => {},
  openTask: null,
})

export interface AppRuntimeTasksProviderProps {
  /** 受控任务列表（调用方负责停止成功后移除条目）。 */
  tasks: RuntimeTask[]
  /** 执行停止；失败 reject。 */
  onStopTask: (task: RuntimeTask) => Promise<void>
  /** 聚焦到任务所属标签页；未提供时运行中心不显示「打开」。 */
  openTask?: (task: RuntimeTask) => void
  initialCenterOpen?: boolean
  children: ReactNode
}

export function AppRuntimeTasksProvider({
  tasks,
  onStopTask,
  openTask,
  initialCenterOpen = false,
  children,
}: AppRuntimeTasksProviderProps) {
  const [runtimeCenterOpen, setRuntimeCenterOpen] = useState(
    initialCenterOpen,
  )
  const openRuntimeCenter = useCallback(() => {
    setRuntimeCenterOpen(true)
  }, [])
  const closeRuntimeCenter = useCallback(() => {
    setRuntimeCenterOpen(false)
  }, [])
  const toggleRuntimeCenter = useCallback(() => {
    setRuntimeCenterOpen(current => !current)
  }, [])

  const stopTask = useCallback(async (taskId: string) => {
    const task = tasks.find(candidate => candidate.id === taskId)
    if (!task) return
    await onStopTask(task)
  }, [onStopTask, tasks])

  const value = useMemo<AppRuntimeTasksContextValue>(() => ({
    tasks,
    runningCount: tasks.filter(task => task.state === 'running').length,
    runtimeCenterOpen,
    openRuntimeCenter,
    closeRuntimeCenter,
    toggleRuntimeCenter,
    stopTask,
    openTask: openTask ?? null,
  }), [
    closeRuntimeCenter,
    openRuntimeCenter,
    openTask,
    runtimeCenterOpen,
    stopTask,
    tasks,
    toggleRuntimeCenter,
  ])

  return (
    <AppRuntimeTasksContext.Provider value={value}>
      {children}
    </AppRuntimeTasksContext.Provider>
  )
}

/** Reads the runtime task registry; empty and inert without a provider. */
export function useAppRuntimeTasks(): AppRuntimeTasksContextValue {
  return useContext(AppRuntimeTasksContext)
}

/** TabBar 关闭拦截用：该标签页名下未结束的运行任务。 */
export function runningTasksForTab(
  tasks: readonly RuntimeTask[],
  tab: { id: string; appId: string },
): RuntimeTask[] {
  return tasks.filter(task => (
    task.state === 'running'
    && (task.tabId === tab.id || task.appId === tab.appId)
  ))
}
