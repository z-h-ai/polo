// 视觉验收夹具安装器（EXPO_PUBLIC_PREVIEW_MODE=1 构建专用）。
//
// 必须作为 app/_layout.tsx 的第一个 import：api client（src/api/client.ts）
// 在模块求值时捕获全局 fetch 引用（`deps.fetch ?? fetch`），本模块必须先于
// 它执行才能让 fixture 拦截生效。生产构建为空操作。
import { installPreviewFetch, PREVIEW_TOKENS } from './preview';
import { tokenStore } from '../auth/tokenStore';

installPreviewFetch();
// 预览身份写入真实 tokenStore 的内存缓存（同步生效）：
// session restore() 与 api client 的 getCached() 由此自然进入已登录态。
void tokenStore.save(PREVIEW_TOKENS);
