# CLI 执行覆盖不写入共享配置

`polo run` 和 `polo exec` 在每次调用开始时读取一份不可变配置快照，命令行 provider、model、endpoint 和凭据只作为该次执行的临时覆盖，不保存为连接、不改变默认模型，也不写入共享凭据；调用级秘密永不进入 Thread。唯一共享写入例外是既有 OAuth credential 的 token 轮换，它通过与 Electron 共用的 credential manager 和写入锁原子更新同一 identity。这样牺牲了把执行命令顺便当作配置入口及实时跟随桌面设置的便利性，但避免后台 CLI 改变 Electron 状态或让单次自动化中途漂移。
