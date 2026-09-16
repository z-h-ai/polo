# 分离 CLI 的配置工作区与执行目录

CLI 执行将配置工作区与执行目录视为两个独立概念：前者按“显式 `--workspace`、当前 active workspace、全局默认配置”的顺序确定，后者来自 `-C/--cd` 或当前目录。这样用户可以在任意代码目录使用既有 Polo 能力，而不会因为执行 `polo exec` 自动注册 workspace 或向代码目录写入 Polo 配置。
