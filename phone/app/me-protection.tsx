// 应用保护 —— 「我的」二级页（对齐 harmony MeProtection）
//
// 分组：保险库解锁（修改主密码 / 此设备自动解锁）+ 锁定（立即锁定）
// 弹层：修改主密码 / 启用设备解锁（SheetModal）

import React, { useState } from "react";
import { Switch, View } from "react-native";

import { useTheme } from "@/contexts/theme-context";
import { useVault } from "@/contexts/vault-context";
import { dialog, toast } from "@/components/ui/dialog";
import { Button, ListGroup, ListRow } from "@/components/ui/primitives";
import { SettingsPage } from "@/components/settings/settings-page";
import {
  SheetErrorBox,
  SheetField,
  SheetModal,
  sheetStyles,
} from "@/components/settings/sheet-modal";

export default function MeProtectionScreen() {
  const { colors: c } = useTheme();
  const {
    lock,
    changeMasterPassword,
    trustedDeviceSupported,
    trustedDeviceEnabled,
    enableTrustedDevice,
    disableTrustedDevice,
  } = useVault();

  const [pwModal, setPwModal] = useState(false);
  const [trustedModal, setTrustedModal] = useState(false);

  /* ── 信任设备切换 ── */
  const handleToggleTrustedDevice = React.useCallback(async () => {
    if (!trustedDeviceSupported) {
      toast.info(
        "当前平台不支持设备解锁",
        "需在 iOS / Android 真机上启用生物识别",
      );
      return;
    }
    if (trustedDeviceEnabled) {
      const ok = await dialog.confirm(
        "关闭设备解锁",
        "下次启动 ZPass 需要重新输入主密码。",
        { okLabel: "关闭", destructive: true },
      );
      if (!ok) return;
      const r = await disableTrustedDevice();
      if (!r.ok) {
        await dialog.alert("关闭失败", r.message);
        return;
      }
      toast.ok("已关闭设备解锁");
      return;
    }
    setTrustedModal(true);
  }, [trustedDeviceSupported, trustedDeviceEnabled, disableTrustedDevice]);

  /* ── 立即锁定 ── */
  const handleLock = React.useCallback(async () => {
    const ok = await dialog.confirm("锁定 ZPass", "确认要锁定保险库吗？", {
      okLabel: "锁定",
      destructive: true,
    });
    if (ok) lock();
  }, [lock]);

  return (
    <SettingsPage title="应用保护">
      <ListGroup header="保险库解锁">
        <ListRow
          title="修改主密码"
          icon="lock.fill"
          onPress={() => setPwModal(true)}
        />
        <ListRow
          title="此设备自动解锁"
          subtitle="使用生物识别 / 设备凭据解锁保险库"
          value={trustedDeviceSupported ? undefined : "不支持"}
          icon="faceid"
          disabled={!trustedDeviceSupported}
          onPress={handleToggleTrustedDevice}
          trailing={
            trustedDeviceSupported ? (
              <Switch
                value={trustedDeviceEnabled}
                onValueChange={handleToggleTrustedDevice}
                trackColor={{ false: c.bgActive, true: c.accent }}
                thumbColor="#ffffff"
              />
            ) : undefined
          }
        />
      </ListGroup>

      <ListGroup header="锁定">
        <ListRow
          title="立即锁定"
          icon="lock.shield.fill"
          iconBg={c.danger + "1f"}
          iconColor={c.danger}
          tone="danger"
          onPress={handleLock}
        />
      </ListGroup>

      {pwModal ? (
        <ChangePasswordModal
          visible={pwModal}
          onClose={() => setPwModal(false)}
          onSubmit={changeMasterPassword}
        />
      ) : null}

      {trustedModal ? (
        <TrustedDeviceEnableModal
          visible={trustedModal}
          onClose={() => setTrustedModal(false)}
          onSubmit={enableTrustedDevice}
        />
      ) : null}
    </SettingsPage>
  );
}

/* ----- 修改主密码 modal ----- */

function ChangePasswordModal({
  visible,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  onClose: () => void;
  onSubmit: (
    oldPwd: string,
    newPwd: string,
  ) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;
}) {
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setOldPwd("");
    setNewPwd("");
    setConfirmPwd("");
    setError(null);
  };
  const close = () => {
    if (busy) return;
    resetForm();
    onClose();
  };

  const handleSubmit = async () => {
    setError(null);
    if (newPwd.length < 8) {
      setError("新密码至少 8 位");
      return;
    }
    if (newPwd !== confirmPwd) {
      setError("两次输入不一致");
      return;
    }
    setBusy(true);
    const r = await onSubmit(oldPwd, newPwd);
    setBusy(false);
    if (r.ok) {
      resetForm();
      onClose();
      toast.ok("已更新", "主密码已修改");
    } else {
      setError(r.message);
    }
  };

  return (
    <SheetModal
      visible={visible}
      onClose={close}
      title="修改主密码"
      subtitle="主密码用于解锁与加密保险库，请妥善保管"
    >
      <SheetField label="当前主密码" value={oldPwd} onChange={setOldPwd} />
      <SheetField
        label="新主密码"
        hint="至少 8 位，建议混合大小写 + 数字 + 符号"
        value={newPwd}
        onChange={setNewPwd}
      />
      <SheetField
        label="确认新主密码"
        value={confirmPwd}
        onChange={setConfirmPwd}
      />

      {error ? <SheetErrorBox message={error} /> : null}

      <View style={sheetStyles.actions}>
        <Button
          label="取消"
          variant="ghost"
          onPress={close}
          disabled={busy}
          style={{ flex: 1 }}
          fullWidth
        />
        <Button
          label={busy ? "处理中" : "确认修改"}
          variant="primary"
          onPress={handleSubmit}
          disabled={busy}
          style={{ flex: 1 }}
          fullWidth
        />
      </View>
    </SheetModal>
  );
}

/* ----- 启用信任设备 modal ----- */

function TrustedDeviceEnableModal({
  visible,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  onClose: () => void;
  onSubmit: (
    confirmPassword: string,
  ) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;
}) {
  const [pwd, setPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setPwd("");
    setError(null);
  };
  const close = () => {
    if (busy) return;
    resetForm();
    onClose();
  };

  const handleSubmit = async () => {
    setError(null);
    if (!pwd) {
      setError("请输入主密码");
      return;
    }
    setBusy(true);
    const r = await onSubmit(pwd);
    setBusy(false);
    if (r.ok) {
      resetForm();
      onClose();
      toast.ok("已启用设备解锁", "下次启动可使用生物识别");
      return;
    }
    setError(
      r.code === "trusted-unsupported"
        ? "当前平台不支持设备解锁"
        : r.message || "请稍后重试",
    );
  };

  return (
    <SheetModal
      visible={visible}
      onClose={close}
      title="启用设备解锁"
      subtitle="启用后此设备可用生物识别 / 设备凭据解锁。请输入主密码以确认。"
    >
      <SheetField label="主密码" value={pwd} onChange={setPwd} />

      {error ? <SheetErrorBox message={error} /> : null}

      <View style={sheetStyles.actions}>
        <Button
          label="取消"
          variant="ghost"
          onPress={close}
          disabled={busy}
          style={{ flex: 1 }}
          fullWidth
        />
        <Button
          label={busy ? "启用中" : "启用"}
          variant="primary"
          onPress={handleSubmit}
          disabled={busy}
          style={{ flex: 1 }}
          fullWidth
        />
      </View>
    </SheetModal>
  );
}
