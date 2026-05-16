// Minimal inline SVG icons — stroke 1.5, 16px default
/** biome-ignore-all lint/a11y/noSvgWithoutTitle: <explanation> */
const Icon = ({
	d,
	size = 16,
	fill = "none",
	stroke = "currentColor",
	sw = 1.5,
	children,
	...p
}) => (
	<svg
		width={size}
		height={size}
		viewBox="0 0 24 24"
		fill={fill}
		stroke={stroke}
		strokeWidth={sw}
		strokeLinecap="round"
		strokeLinejoin="round"
		{...p}
	>
		{d ? <path d={d} /> : children}
	</svg>
);

const I = {
	Vault: (p) => (
		<Icon {...p}>
			<rect x="3" y="5" width="18" height="14" rx="2" />
			<circle cx="12" cy="12" r="2.5" />
			<path d="M12 9.5V7M12 17v-2.5M9.5 12H7M17 12h-2.5" />
		</Icon>
	),
	Login: (p) => (
		<Icon {...p}>
			<rect x="3" y="11" width="18" height="10" rx="2" />
			<path d="M7 11V7a5 5 0 0 1 10 0v4" />
		</Icon>
	),
	Note: (p) => (
		<Icon {...p}>
			<path d="M4 4h12l4 4v12a0 0 0 0 1 0 0H4z" />
			<path d="M16 4v4h4" />
			<path d="M8 13h8M8 17h5" />
		</Icon>
	),
	Card: (p) => (
		<Icon {...p}>
			<rect x="3" y="5" width="18" height="14" rx="2" />
			<path d="M3 10h18M7 15h3" />
		</Icon>
	),
	Id: (p) => (
		<Icon {...p}>
			<rect x="3" y="5" width="18" height="14" rx="2" />
			<circle cx="9" cy="12" r="2.5" />
			<path d="M14 10h4M14 14h3M5.5 17c.8-1.5 2-2.5 3.5-2.5s2.7 1 3.5 2.5" />
		</Icon>
	),
	Ssh: (p) => (
		<Icon {...p}>
			<path d="M14 8l-6 8M7 8h1M16 16h1" />
			<rect x="3" y="5" width="18" height="14" rx="2" />
		</Icon>
	),
	Wallet: (p) => (
		<Icon {...p}>
			<path d="M3 7a2 2 0 0 1 2-2h13v4" />
			<rect x="3" y="7" width="18" height="13" rx="2" />
			<circle cx="16" cy="13.5" r="1.25" />
		</Icon>
	),
	Health: (p) => (
		<Icon {...p}>
			<path d="M12 21s-8-4.5-8-11a5 5 0 0 1 8-4 5 5 0 0 1 8 4c0 6.5-8 11-8 11z" />
			<path d="M8 12h2l1.5-3 2 6 1.5-3H17" />
		</Icon>
	),
	Gen: (p) => (
		<Icon {...p}>
			<path d="M4 7h16M4 12h10M4 17h16" />
			<circle cx="18" cy="12" r="2" />
		</Icon>
	),
	Folder: (p) => (
		<Icon {...p}>
			<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
		</Icon>
	),
	Star: (p) => (
		<Icon {...p}>
			<path d="M12 3l2.6 5.6L20 9.5l-4 4 1 5.8-5-3-5 3 1-5.8-4-4 5.4-.9z" />
		</Icon>
	),
	Trash: (p) => (
		<Icon {...p}>
			<path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
		</Icon>
	),
	Search: (p) => (
		<Icon {...p}>
			<circle cx="11" cy="11" r="7" />
			<path d="M20 20l-3.5-3.5" />
		</Icon>
	),
	Plus: (p) => (
		<Icon {...p}>
			<path d="M12 5v14M5 12h14" />
		</Icon>
	),
	Copy: (p) => (
		<Icon {...p}>
			<rect x="8" y="8" width="12" height="12" rx="2" />
			<path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
		</Icon>
	),
	Eye: (p) => (
		<Icon {...p}>
			<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
			<circle cx="12" cy="12" r="2.5" />
		</Icon>
	),
	EyeOff: (p) => (
		<Icon {...p}>
			<path d="M3 3l18 18M10.5 5.2A9 9 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.1 4.1M6.2 6.5A17.6 17.6 0 0 0 2 12s3.5 7 10 7c1.3 0 2.5-.2 3.5-.6M9.5 9.7a3 3 0 0 0 4.2 4.2" />
		</Icon>
	),
	Ext: (p) => (
		<Icon {...p}>
			<path d="M9 15l6-6M9 9h6v6" />
		</Icon>
	),
	Edit: (p) => (
		<Icon {...p}>
			<path d="M4 20h4l10-10-4-4L4 16v4z" />
			<path d="M14 6l4 4" />
		</Icon>
	),
	Share: (p) => (
		<Icon {...p}>
			<circle cx="6" cy="12" r="2.5" />
			<circle cx="18" cy="5.5" r="2.5" />
			<circle cx="18" cy="18.5" r="2.5" />
			<path d="M8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1" />
		</Icon>
	),
	More: (p) => (
		<Icon {...p}>
			<circle cx="5" cy="12" r="1" />
			<circle cx="12" cy="12" r="1" />
			<circle cx="19" cy="12" r="1" />
		</Icon>
	),
	Clock: (p) => (
		<Icon {...p}>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3 2" />
		</Icon>
	),
	Shield: (p) => (
		<Icon {...p}>
			<path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6z" />
		</Icon>
	),
	Alert: (p) => (
		<Icon {...p}>
			<path d="M12 3l10 18H2z" />
			<path d="M12 10v5M12 18v.5" />
		</Icon>
	),
	Check: (p) => (
		<Icon {...p}>
			<path d="M5 12l5 5 9-11" />
		</Icon>
	),
	Lock: (p) => (
		<Icon {...p}>
			<rect x="4" y="11" width="16" height="10" rx="2" />
			<path d="M8 11V7a4 4 0 0 1 8 0v4" />
		</Icon>
	),
	Moon: (p) => (
		<Icon {...p}>
			<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z" />
		</Icon>
	),
	Sun: (p) => (
		<Icon {...p}>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
		</Icon>
	),
	Refresh: (p) => (
		<Icon {...p}>
			<path d="M4 12a8 8 0 0 1 13.5-5.5L20 9M20 4v5h-5M20 12a8 8 0 0 1-13.5 5.5L4 15M4 20v-5h5" />
		</Icon>
	),
	Settings: (p) => (
		<Icon {...p}>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
		</Icon>
	),
	Dice: (p) => (
		<Icon {...p}>
			<rect x="3" y="3" width="18" height="18" rx="3" />
			<circle cx="8" cy="8" r="1.2" />
			<circle cx="16" cy="16" r="1.2" />
			<circle cx="16" cy="8" r="1.2" />
			<circle cx="8" cy="16" r="1.2" />
			<circle cx="12" cy="12" r="1.2" />
		</Icon>
	),
	Chevron: (p) => (
		<Icon {...p}>
			<path d="M9 6l6 6-6 6" />
		</Icon>
	),
	Down: (p) => (
		<Icon {...p}>
			<path d="M6 9l6 6 6-6" />
		</Icon>
	),
	Filter: (p) => (
		<Icon {...p}>
			<path d="M3 5h18l-7 8v6l-4 2v-8z" />
		</Icon>
	),
	Bell: (p) => (
		<Icon {...p}>
			<path d="M6 17h12l-1.5-2V11a4.5 4.5 0 0 0-9 0v4z" />
			<path d="M10 20a2 2 0 0 0 4 0" />
		</Icon>
	),
	Command: (p) => (
		<Icon {...p}>
			<path d="M9 15a3 3 0 1 1 0-6h6a3 3 0 1 1 0 6H9z" />
			<path d="M9 9V6M15 15v3M9 15v3M15 9V6" />
		</Icon>
	),
	Fingerprint: (p) => (
		<Icon {...p}>
			<path d="M6 11a6 6 0 0 1 12 0v2M9 11a3 3 0 0 1 6 0v2c0 2 .5 4 1.5 6M12 11v3c0 3-1 5-2 7M6 14c0 2 .5 4 1.5 6" />
		</Icon>
	),
	Pen: (p) => (
		<Icon {...p}>
			<path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
		</Icon>
	),
	Spaces: (p) => (
		<Icon {...p}>
			<rect x="3" y="3" width="7" height="7" rx="1.5" />
			<rect x="14" y="3" width="7" height="7" rx="1.5" />
			<rect x="3" y="14" width="7" height="7" rx="1.5" />
			<rect x="14" y="14" width="7" height="7" rx="1.5" />
		</Icon>
	),
	Timer: (p) => (
		<Icon {...p}>
			<circle cx="12" cy="13" r="8" />
			<path d="M12 9v4l2.5 1.5" />
			<path d="M10 2h4M12 2v3" />
		</Icon>
	),
	AlertTriangle: (p) => (
		<Icon {...p}>
			<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
			<path d="M12 9v4M12 17h.01" />
		</Icon>
	),
	Upload: (p) => (
		<Icon {...p}>
			<path d="M12 4v12M7 9l5-5 5 5" />
			<path d="M5 18v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2" />
		</Icon>
	),
	Download: (p) => (
		<Icon {...p}>
			<path d="M12 4v12M7 11l5 5 5-5" />
			<path d="M5 18v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2" />
		</Icon>
	),
	User: (p) => (
		<Icon {...p}>
			<circle cx="12" cy="8" r="4" />
			<path d="M4 21c0-4 4-7 8-7s8 3 8 7" />
		</Icon>
	),
	X: (p) => (
		<Icon {...p}>
			<path d="M5 5l14 14M19 5L5 19" />
		</Icon>
	),
};

window.ZPASS_ICONS = I;
