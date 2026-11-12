import React from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text as RNText, TextInput, TextStyle, View, ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, font, radius, shadow, space, Tone, toneColors } from '../theme';

/* ───────────── layout ───────────── */

export function Screen({ children, scroll = true, refreshing, onRefresh, padded = true, footer, edges }: {
  children: React.ReactNode; scroll?: boolean; refreshing?: boolean; onRefresh?: () => void; padded?: boolean; footer?: React.ReactNode;
  edges?: Array<'top' | 'bottom' | 'left' | 'right'>;
}) {
  const content = scroll ? (
    <ScrollView
      contentContainerStyle={[padded && styles.padded, { paddingBottom: footer ? space(28) : space(10) }]}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.brand} /> : undefined}
    >
      {children}
    </ScrollView>
  ) : <View style={[{ flex: 1 }, padded && styles.padded]}>{children}</View>;
  return (
    <SafeAreaView style={styles.screen} edges={edges ?? ['left', 'right', 'bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {content}
        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function Row({ children, gap = 2, style, align = 'center', justify }: { children: React.ReactNode; gap?: number; style?: ViewStyle; align?: ViewStyle['alignItems']; justify?: ViewStyle['justifyContent'] }) {
  return <View style={[{ flexDirection: 'row', alignItems: align, gap: space(gap), justifyContent: justify }, style]}>{children}</View>;
}

export function Spacer({ h = 4 }: { h?: number }) { return <View style={{ height: space(h) }} />; }
export function Divider() { return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: space(3) }} />; }

export function Card({ children, style, onPress, tone }: { children: React.ReactNode; style?: ViewStyle; onPress?: () => void; tone?: 'urgent' | 'brand' }) {
  const toneStyle = tone === 'urgent' ? { borderColor: colors.urgent, borderWidth: 1.5 } : tone === 'brand' ? { borderColor: colors.brand, borderWidth: 1.5 } : null;
  const body = <View style={[styles.card, toneStyle, style]}>{children}</View>;
  return onPress ? <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })} accessibilityRole="button">{body}</Pressable> : body;
}

/* ───────────── text ───────────── */

type TextProps = { children: React.ReactNode; style?: TextStyle; color?: string; numberOfLines?: number; center?: boolean };
const mk = (base: TextStyle) => ({ children, style, color, numberOfLines, center }: TextProps) => (
  <RNText numberOfLines={numberOfLines} style={[base, color ? { color } : null, center ? { textAlign: 'center' } : null, style]}>{children}</RNText>
);
export const H1 = mk({ fontSize: font.h1, fontWeight: '700', color: colors.text, letterSpacing: -0.3 });
export const H2 = mk({ fontSize: font.h2, fontWeight: '700', color: colors.text });
export const H3 = mk({ fontSize: font.h3, fontWeight: '600', color: colors.text });
export const Body = mk({ fontSize: font.body, color: colors.text, lineHeight: 21 });
export const Muted = mk({ fontSize: font.small, color: colors.textMuted, lineHeight: 18 });
export const Caption = mk({ fontSize: font.tiny, color: colors.textFaint, textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: '600' });

/* ───────────── controls ───────────── */

export function Button({ title, onPress, variant = 'primary', loading, disabled, icon, small, style }: {
  title: string; onPress?: () => void; variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'urgent'; loading?: boolean; disabled?: boolean;
  icon?: keyof typeof Ionicons.glyphMap; small?: boolean; style?: ViewStyle;
}) {
  const v = {
    primary: { bg: colors.brand, fg: '#fff', border: colors.brand },
    urgent: { bg: colors.urgent, fg: '#fff', border: colors.urgent },
    secondary: { bg: colors.surface, fg: colors.brand, border: colors.brand },
    danger: { bg: colors.surface, fg: colors.danger, border: colors.danger },
    ghost: { bg: 'transparent', fg: colors.brand, border: 'transparent' },
  }[variant];
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button" accessibilityState={{ disabled: !!off, busy: !!loading }}
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [styles.btn, small && styles.btnSmall, { backgroundColor: v.bg, borderColor: v.border, opacity: off ? 0.55 : pressed ? 0.85 : 1 }, style]}
    >
      {loading ? <ActivityIndicator color={v.fg} /> : (
        <Row gap={2}>
          {icon ? <Ionicons name={icon} size={small ? 16 : 18} color={v.fg} /> : null}
          <RNText style={{ color: v.fg, fontWeight: '600', fontSize: small ? 14 : 16 }}>{title}</RNText>
        </Row>
      )}
    </Pressable>
  );
}

export function Input({ label, error, hint, style, multiline, prefix, ...rest }: React.ComponentProps<typeof TextInput> & { label?: string; error?: string | null; hint?: string; prefix?: string }) {
  return (
    <View style={{ marginBottom: space(4) }}>
      {label ? <RNText style={styles.label}>{label}</RNText> : null}
      <View style={[styles.inputWrap, error ? { borderColor: colors.danger } : null]}>
        {prefix ? <RNText style={styles.prefix}>{prefix}</RNText> : null}
        <TextInput
          placeholderTextColor={colors.textFaint}
          style={[styles.input, multiline && { minHeight: 96, textAlignVertical: 'top', paddingTop: 12 }, style]}
          multiline={multiline}
          {...rest}
        />
      </View>
      {error ? <RNText style={styles.error}>{error}</RNText> : hint ? <RNText style={styles.hint}>{hint}</RNText> : null}
    </View>
  );
}

export function Pill({ label, tone = 'neutral', icon }: { label: string; tone?: Tone; icon?: keyof typeof Ionicons.glyphMap }) {
  const t = toneColors[tone];
  return (
    <View style={[styles.pill, { backgroundColor: t.bg }]}>
      {icon ? <Ionicons name={icon} size={12} color={t.fg} style={{ marginRight: 4 }} /> : null}
      <RNText style={{ color: t.fg, fontSize: 12, fontWeight: '600' }}>{label}</RNText>
    </View>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: { options: Array<{ value: T; label: string; icon?: keyof typeof Ionicons.glyphMap }>; value: T; onChange: (v: T) => void }) {
  return (
    <View style={styles.segmented}>
      {options.map(o => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} style={[styles.segment, on && styles.segmentOn]} accessibilityRole="tab" accessibilityState={{ selected: on }}>
            {o.icon ? <Ionicons name={o.icon} size={16} color={on ? colors.brand : colors.textMuted} /> : null}
            <RNText style={{ color: on ? colors.brand : colors.textMuted, fontWeight: on ? '700' : '500', fontSize: 14 }}>{o.label}</RNText>
          </Pressable>
        );
      })}
    </View>
  );
}

export function ListItem({ title, subtitle, right, icon, onPress, iconColor }: { title: string; subtitle?: string | null; right?: React.ReactNode; icon?: keyof typeof Ionicons.glyphMap; onPress?: () => void; iconColor?: string }) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => [styles.listItem, pressed && { backgroundColor: colors.neutralSoft }]}>
      {icon ? <View style={styles.listIcon}><Ionicons name={icon} size={20} color={iconColor ?? colors.brand} /></View> : null}
      <View style={{ flex: 1 }}>
        <RNText style={{ fontSize: 15, fontWeight: '500', color: colors.text }} numberOfLines={1}>{title}</RNText>
        {subtitle ? <RNText style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }} numberOfLines={2}>{subtitle}</RNText> : null}
      </View>
      {right ?? (onPress ? <Ionicons name="chevron-forward" size={18} color={colors.textFaint} /> : null)}
    </Pressable>
  );
}

export function EmptyState({ icon = 'file-tray-outline', title, body, action }: { icon?: keyof typeof Ionicons.glyphMap; title: string; body?: string; action?: React.ReactNode }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: space(12), paddingHorizontal: space(6) }}>
      <View style={styles.emptyIcon}><Ionicons name={icon} size={30} color={colors.brand} /></View>
      <H3 center>{title}</H3>
      {body ? <><Spacer h={1} /><Muted center>{body}</Muted></> : null}
      {action ? <><Spacer h={4} />{action}</> : null}
    </View>
  );
}

export function Banner({ tone = 'info', title, body, icon }: { tone?: Tone; title: string; body?: string; icon?: keyof typeof Ionicons.glyphMap }) {
  const t = toneColors[tone];
  return (
    <View style={[styles.banner, { backgroundColor: t.bg }]}>
      <Ionicons name={icon ?? (tone === 'danger' ? 'alert-circle' : tone === 'success' ? 'checkmark-circle' : tone === 'warning' ? 'time' : 'information-circle')} size={20} color={t.fg} />
      <View style={{ flex: 1 }}>
        <RNText style={{ color: t.fg, fontWeight: '700', fontSize: 14 }}>{title}</RNText>
        {body ? <RNText style={{ color: colors.text, fontSize: 13, marginTop: 2, lineHeight: 18 }}>{body}</RNText> : null}
      </View>
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(10) }}>
      <ActivityIndicator size="large" color={colors.brand} />
      {label ? <><Spacer h={3} /><Muted>{label}</Muted></> : null}
    </View>
  );
}

export function KeyValue({ k, v, strong }: { k: string; v: React.ReactNode; strong?: boolean }) {
  return (
    <Row justify="space-between" style={{ paddingVertical: space(1.5) }}>
      <RNText style={{ color: strong ? colors.text : colors.textMuted, fontSize: 14, fontWeight: strong ? '700' : '400' }}>{k}</RNText>
      {typeof v === 'string' ? <RNText style={{ color: colors.text, fontSize: 14, fontWeight: strong ? '700' : '500' }}>{v}</RNText> : v}
    </Row>
  );
}

export function Stars({ value, size = 16, onChange }: { value: number; size?: number; onChange?: (n: number) => void }) {
  return (
    <Row gap={onChange ? 2 : 0.5}>
      {[1, 2, 3, 4, 5].map(i => (
        <Pressable key={i} disabled={!onChange} onPress={() => onChange?.(i)} hitSlop={6} accessibilityLabel={`${i} star${i > 1 ? 's' : ''}`}>
          <Ionicons name={value >= i ? 'star' : value >= i - 0.5 ? 'star-half' : 'star-outline'} size={size} color={colors.accent} />
        </Pressable>
      ))}
    </Row>
  );
}

export function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0]!.toUpperCase()).join('');
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.brandSoft, alignItems: 'center', justifyContent: 'center' }}>
      <RNText style={{ color: colors.brandDark, fontWeight: '700', fontSize: size * 0.38 }}>{initials || '?'}</RNText>
    </View>
  );
}

export function IconCircle({ name, color = colors.brand, bg = colors.brandSoft, size = 44 }: { name: keyof typeof Ionicons.glyphMap; color?: string; bg?: string; size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: radius.md, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name={name} size={size * 0.5} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  padded: { padding: space(4) },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: space(4), paddingBottom: space(8), backgroundColor: colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: space(4), marginBottom: space(3), ...shadow },
  btn: { height: 52, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, paddingHorizontal: space(5) },
  btnSmall: { height: 38, paddingHorizontal: space(3) },
  label: { fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: space(1.5) },
  inputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md },
  prefix: { paddingLeft: space(3), color: colors.textMuted, fontSize: 16 },
  input: { flex: 1, minHeight: 48, paddingHorizontal: space(3), fontSize: 16, color: colors.text },
  error: { color: colors.danger, fontSize: 12, marginTop: space(1) },
  hint: { color: colors.textFaint, fontSize: 12, marginTop: space(1) },
  pill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space(2.5), paddingVertical: space(1), borderRadius: radius.pill, alignSelf: 'flex-start' },
  segmented: { flexDirection: 'row', backgroundColor: colors.neutralSoft, borderRadius: radius.md, padding: 4, gap: 4 },
  segment: { flex: 1, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, borderRadius: radius.sm },
  segmentOn: { backgroundColor: colors.surface, ...shadow },
  listItem: { flexDirection: 'row', alignItems: 'center', gap: space(3), paddingVertical: space(3), paddingHorizontal: space(1) },
  listIcon: { width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.brandSoft, alignItems: 'center', justifyContent: 'center' },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.brandSoft, alignItems: 'center', justifyContent: 'center', marginBottom: space(3) },
  banner: { flexDirection: 'row', gap: space(3), padding: space(3), borderRadius: radius.md, marginBottom: space(3), alignItems: 'flex-start' },
});
