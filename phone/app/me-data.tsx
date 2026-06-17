// 数据管理 —— 「我的」二级页（对齐 harmony MeData）
//
// 分组：导入与导出 + 条目统计 + 危险操作（清空 / 重置）

import React from "react";

import { useTheme } from "@/contexts/theme-context";
import { useVault } from "@/contexts/vault-context";
import type { VaultItem, VaultItemType } from "@/data/vault";
import { exportVault, pickAndParseImport } from "@/lib/transfer";
import type { ItemPayload } from "@/lib/vault-service";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { dialog, toast } from "@/components/ui/dialog";
import { ListGroup, ListRow } from "@/components/ui/primitives";
import { SettingsPage } from "@/components/settings/settings-page";

type IconName = Parameters<typeof IconSymbol>[0]["name"];

const ITEM_TYPE_ROWS: { label: string; type: VaultItemType; icon: IconName }[] =
  [
    { label: "登录凭据", type: "login", icon: "key.fill" },
    { label: "验证码", type: "totp", icon: "clock.fill" },
    { label: "支付卡", type: "card", icon: "creditcard.fill" },
    { label: "安全笔记", type: "note", icon: "note.text" },
    { label: "身份信息", type: "identity", icon: "person.crop.circle.fill" },
    { label: "SSH 密钥", type: "ssh", icon: "terminal.fill" },
    { label: "Passkey", type: "passkey", icon: "key.horizontal.fill" },
  ];

function countByType(items: VaultItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i.type] = (out[i.type] ?? 0) + 1;
  return out;
}

export default function MeDataScreen() {
  const { colors: c } = useTheme();
  const { items, importItems, listPayloads, clearAll, reset } = useVault();

  const typeCounts = React.useMemo(() => countByType(items), [items]);

  /* ── 导出：明文备份 ── */
  const handleExport = React.useCallback(async () => {
    if (items.length === 0) {
      toast.warn("保险库为空", "暂无可导出的条目");
      return;
    }
    const ok = await dialog.confirm(
      "导出明文备份",
      `备份文件将包含全部 ${items.length} 个条目的明文内容（含密码、密钥、TOTP 等）。请妥善保管，切勿上传到不可信的位置。`,
      { okLabel: "继续导出", destructive: true },
    );
    if (!ok) return;
    try {
      // 拉原始 ItemPayload[]：envelope 与 desktop exportservice.go 1:1，
      // 不能用 useVault().items（那是平铺的展示态 VaultItem）。
      const payloads: ItemPayload[] = await listPayloads();
      const r = await exportVault(payloads);
      if (!r.shared) toast.ok("已生成备份", r.path);
    } catch (e) {
      toast.danger("导出失败", e instanceof Error ? e.message : String(e));
    }
  }, [items.length, listPayloads]);

  /* ── 导入：选择 JSON ── */
  const handleImport = React.useCallback(async () => {
    const res = await pickAndParseImport();
    if (!res.ok) {
      if (res.reason === "cancelled") return;
      await dialog.alert(
        "导入失败",
        res.reason === "empty"
          ? "文件中没有可识别的条目"
          : "无法解析文件，请选择有效的 ZPass 导出 JSON",
      );
      return;
    }
    const ok = await dialog.confirm(
      "确认导入",
      `已从「${res.fileName}」解析到 ${res.items.length} 个条目，全部追加到加密保险库？`,
      { okLabel: "导入" },
    );
    if (!ok) return;
    const n = await importItems(res.items);
    toast.ok("导入完成", `已导入 ${n} 个条目`);
  }, [importItems]);

  /* ── 清空 ── */
  const handleClearAll = React.useCallback(async () => {
    if (items.length === 0) {
      toast.info("保险库已为空");
      return;
    }
    const ok = await dialog.confirm(
      "清空保险库",
      `将永久删除全部 ${items.length} 个条目，主密码与加密元数据保留，此操作不可撤销。建议先导出备份。`,
      { okLabel: "清空", destructive: true },
    );
    if (ok) clearAll();
  }, [items.length, clearAll]);

  /* ── 完全重置 ── */
  const handleReset = React.useCallback(async () => {
    const ok = await dialog.confirm(
      "重置 ZPass",
      "将永久删除主密码与所有条目，应用回到初始状态。此操作不可撤销。",
      { okLabel: "重置", destructive: true },
    );
    if (ok) await reset();
  }, [reset]);

  return (
    <SettingsPage title="数据管理">
      <ListGroup header="导入与导出">
        <ListRow
          title="导入数据"
          value="ZPass JSON"
          icon="arrow.down.doc.fill"
          onPress={handleImport}
        />
        <ListRow
          title="导出明文备份"
          value={`${items.length} 项`}
          icon="arrow.up.doc.fill"
          onPress={handleExport}
        />
      </ListGroup>

      <ListGroup header="条目统计">
        {ITEM_TYPE_ROWS.map(({ label, type, icon }) => (
          <ListRow
            key={type}
            title={label}
            value={`${typeCounts[type] ?? 0} 项`}
            icon={icon}
            accessory="none"
          />
        ))}
      </ListGroup>

      <ListGroup header="危险操作">
        <ListRow
          title="清空所有条目"
          icon="trash"
          iconBg={c.warn + "1f"}
          iconColor={c.warn}
          tone="danger"
          onPress={handleClearAll}
        />
        <ListRow
          title="重置 ZPass"
          icon="trash.fill"
          iconBg={c.danger + "1f"}
          iconColor={c.danger}
          tone="danger"
          onPress={handleReset}
        />
      </ListGroup>
    </SettingsPage>
  );
}
