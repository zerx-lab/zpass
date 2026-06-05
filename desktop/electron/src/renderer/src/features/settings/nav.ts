import {
	AppWindow,
	ArrowRightLeft,
	Cloud,
	Globe,
	Info,
	LayoutGrid,
	Shield,
	ShieldCheck,
	SlidersHorizontal,
} from "lucide-react";
import type { IconComp } from "./shared";

/**
 * 设置页导航定义
 * ---------------------------------------------------------------------------
 * 单一真源：`id` 同时承担两个职责
 *   1. 子路由 path（/settings/<id>，见 app/router.tsx）
 *   2. SettingsLayout 侧栏导航项的 key
 * 改一个 section 的归属 / 顺序 / 文案，只动这里。
 */

export type NavItem = {
	/** 既是路由 path，又是 NavLink 的稳定 key */
	id: string;
	labelKey: string;
	icon: IconComp;
	/** 所属分组 key，对应 NAV_GROUPS */
	group: string;
};

export const NAV_GROUPS: { key: string; labelKey: string }[] = [
	{ key: "general", labelKey: "settings_nav_group_general" },
	{ key: "security", labelKey: "settings_nav_group_security" },
	{ key: "about", labelKey: "settings_nav_group_about" },
];

export const NAV_ITEMS: NavItem[] = [
	{
		id: "appearance",
		labelKey: "settings_section_appearance",
		icon: SlidersHorizontal,
		group: "general",
	},
	{
		id: "language",
		labelKey: "settings_section_language",
		icon: Globe,
		group: "general",
	},
	{
		id: "spaces",
		labelKey: "settings_section_spaces",
		icon: LayoutGrid,
		group: "general",
	},
	{
		id: "window",
		labelKey: "settings_section_window",
		icon: AppWindow,
		group: "general",
	},
	{
		id: "security",
		labelKey: "settings_section_security",
		icon: Shield,
		group: "security",
	},
	{
		id: "trusted-device",
		labelKey: "settings_section_trusted_device",
		icon: ShieldCheck,
		group: "security",
	},
	{
		id: "ssh-agent",
		labelKey: "settings_section_ssh_agent",
		icon: ShieldCheck,
		group: "security",
	},
	{
		id: "lan-sync",
		labelKey: "settings_section_lan_sync",
		icon: ArrowRightLeft,
		group: "security",
	},
	{
		id: "cloud-sync",
		labelKey: "cloud_settings_title",
		icon: Cloud,
		group: "security",
	},
	{
		id: "about",
		labelKey: "settings_section_about",
		icon: Info,
		group: "about",
	},
];
