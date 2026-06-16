// SheetModal —— iOS HIG bottom sheet 容器 + 表单字段 / 错误提示
//
// 从 me.tsx 抽出，供「应用保护」等设置子页的修改主密码 / 启用设备解锁弹层复用。

import React, { useEffect, useState } from "react";
import {
  Keyboard,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Radius, Spacing, Type } from "@/constants/theme";
import { useTheme } from "@/contexts/theme-context";
import { IconSymbol } from "@/components/ui/icon-symbol";

export function SheetModal({
  visible,
  onClose,
  title,
  subtitle,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const { colors: c } = useTheme();
  const [kbInset, setKbInset] = useState(0);

  useEffect(() => {
    if (!visible) {
      setKbInset(0);
      return;
    }
    const showEvt =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvt =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const s1 = Keyboard.addListener(showEvt, (e) => {
      setKbInset(e.endCoordinates.height);
    });
    const s2 = Keyboard.addListener(hideEvt, () => {
      setKbInset(0);
    });
    return () => {
      s1.remove();
      s2.remove();
    };
  }, [visible]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={[styles.kavWrap, { paddingBottom: kbInset }]}>
        <Pressable
          onPress={onClose}
          style={[
            StyleSheet.absoluteFillObject,
            { backgroundColor: c.overlay },
          ]}
        />
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={[styles.card, { backgroundColor: c.bgElev2 }]}
        >
          <View style={styles.cardHandle}>
            <View style={[styles.handleBar, { backgroundColor: c.line }]} />
          </View>
          <Text style={[styles.title, { color: c.text }]}>{title}</Text>
          {subtitle ? (
            <Text style={[styles.subtitle, { color: c.text3 }]}>
              {subtitle}
            </Text>
          ) : null}
          <View style={{ height: Spacing.md }} />
          {children}
        </Pressable>
      </View>
    </Modal>
  );
}

export function SheetField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const { colors: c } = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: c.text3 }]}>{label}</Text>
      <TextInput
        style={[
          styles.fieldInput,
          { color: c.text, backgroundColor: c.bgElev },
        ]}
        value={value}
        onChangeText={onChange}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      {hint ? (
        <Text style={[styles.fieldHint, { color: c.text3 }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

export function SheetErrorBox({ message }: { message: string }) {
  const { colors: c } = useTheme();
  return (
    <View style={[styles.errorBox, { backgroundColor: c.danger + "1f" }]}>
      <IconSymbol
        name="exclamationmark.circle.fill"
        size={14}
        color={c.danger}
      />
      <Text style={[styles.errorText, { color: c.danger }]}>{message}</Text>
    </View>
  );
}

export const sheetStyles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },
});

const styles = StyleSheet.create({
  kavWrap: {
    flex: 1,
    justifyContent: "flex-end",
  },
  card: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xxl,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    width: "100%",
  },
  cardHandle: {
    alignItems: "center",
    paddingBottom: Spacing.sm,
  },
  handleBar: {
    width: 40,
    height: 4,
    borderRadius: 2,
  },
  title: {
    ...Type.title2,
    marginTop: Spacing.xs,
  },
  subtitle: {
    ...Type.footnote,
    marginTop: 4,
  },

  field: { marginBottom: Spacing.sm },
  fieldLabel: {
    ...Type.footnote,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 6,
  },
  fieldInput: {
    height: 46,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    ...Type.body,
  },
  fieldHint: { ...Type.footnote, marginTop: 4 },

  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    marginTop: Spacing.sm,
    marginBottom: Spacing.xs,
  },
  errorText: { ...Type.footnote, flex: 1 },
});
