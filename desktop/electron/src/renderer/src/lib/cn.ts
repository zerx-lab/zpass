// className 合并工具：clsx 直接转发，保持命名与业内惯例一致
// 用法：cn("base", cond && "active", { "text-red": hasError })
import clsx, { type ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]): string {
	return clsx(inputs);
}
