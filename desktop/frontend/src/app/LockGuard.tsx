import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useLockStore } from "@/stores/lock";

/**
 * 锁定守卫 —— 路由级别的访问控制
 *
 * 逻辑：
 *   - useLockStore.locked === true  → 重定向到 /unlock
 *   - locked === false              → 渲染 <Outlet />（放行到 AppShell 及其子路由）
 *
 * 设计：把"是否解锁"作为路由守卫而不是 App 组件内的条件渲染，
 * 好处是可以直接用 URL 深链回到具体条目（/vault/:itemId），
 * 解锁后 router 会自然回到目标页面，而不是永远落到首页。
 *
 * 注意：锁定状态特意从独立的 useLockStore 读取（而非 usePrefsStore），
 * 因为运行时锁定是内存敏感状态，不应被持久化 —— 应用重启默认即锁定。
 * 参见 src/stores/lock.ts 的设计说明。
 *
 * 对标 ZPassDesign/src/app.jsx 中 `locked ? <Unlock /> : <AppShell />` 的二选一。
 */
export function LockGuard() {
	const locked = useLockStore((s) => s.locked);
	const location = useLocation();

	if (locked) {
		// 把当前路径塞进 state，解锁页可以在解锁后 navigate(from) 回到原位
		return (
			<Navigate
				to="/unlock"
				replace
				state={{ from: location.pathname + location.search }}
			/>
		);
	}

	return <Outlet />;
}

export default LockGuard;
