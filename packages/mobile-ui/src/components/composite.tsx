import React, { useRef, useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BOOKING_STATUS, BookingStatus, REQUEST_STATUS, RequestStatus, TimelineEvent, formatDateTime } from '@trades/shared';
import { colors, radius, space } from '../theme';
import { Body, Button, H3, Muted, Pill, Row, Spacer } from './primitives';

export function BookingStatusPill({ status, audience }: { status: BookingStatus; audience: 'customer' | 'provider' }) {
  const s = BOOKING_STATUS[status];
  return <Pill label={s[audience]} tone={s.tone} />;
}

export function RequestStatusPill({ status }: { status: RequestStatus }) {
  const s = REQUEST_STATUS[status];
  return <Pill label={s.label} tone={s.tone} />;
}

/** 6-digit OTP entry with a hidden input driving visible boxes (works with SMS autofill). */
export function OtpInput({ value, onChange, autoFocus = true }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const ref = useRef<TextInput>(null);
  return (
    <Pressable onPress={() => ref.current?.focus()} accessibilityLabel="Verification code">
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <View key={i} style={[styles.otpBox, value.length === i && styles.otpBoxActive]}>
            <Text style={{ fontSize: 24, fontWeight: '700', color: colors.text }}>{value[i] ?? ''}</Text>
          </View>
        ))}
      </View>
      <TextInput
        ref={ref} value={value} onChangeText={t => onChange(t.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad"
        textContentType="oneTimeCode" autoComplete="sms-otp" autoFocus={autoFocus} maxLength={6} style={{ position: 'absolute', opacity: 0, height: 1, width: 1 }}
      />
    </Pressable>
  );
}

const TIMELINE_LABEL: Record<string, string> = {
  create: 'Booked', payment_captured: 'Payment received', assign: 'Provider confirmed', start: 'Job started', complete: 'Marked complete',
  approve: 'Approved', auto_approve: 'Auto-approved', schedule_payout: 'Payout scheduled', release_payout: 'Payout sent', cancel: 'Cancelled',
  no_show: 'No-show reported', initiate_refund: 'Refund started', refund_processed: 'Refunded', refund_processed_partial: 'Partial refund processed',
  dispute: 'Problem reported', resolve_release: 'Dispute resolved', resolve_refund: 'Dispute resolved — refund', resolve_keep_released: 'Dispute resolved',
  payment_window_expired: 'Payment window expired',
};

export function Timeline({ events }: { events: TimelineEvent[] }) {
  return (
    <View>
      {events.map((e, i) => (
        <Row key={i} align="flex-start" gap={3} style={{ marginBottom: space(3) }}>
          <View style={{ alignItems: 'center' }}>
            <View style={[styles.dot, i === events.length - 1 && { backgroundColor: colors.brand }]} />
            {i < events.length - 1 ? <View style={styles.line} /> : null}
          </View>
          <View style={{ flex: 1, marginTop: -3 }}>
            <Body style={{ fontWeight: i === events.length - 1 ? '700' : '500' }}>{TIMELINE_LABEL[e.trigger] ?? e.to_state.replace(/_/g, ' ')}</Body>
            <Muted>{formatDateTime(e.occurred_at)}{e.actor_type === 'system' ? ' · automatic' : ''}</Muted>
          </View>
        </Row>
      ))}
    </View>
  );
}

export function PhotoStrip({ uris, onAdd, onRemove, max = 6 }: { uris: string[]; onAdd?: () => void; onRemove?: (i: number) => void; max?: number }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
      {uris.map((u, i) => (
        <View key={u + i}>
          <Image source={{ uri: u }} style={styles.photo} />
          {onRemove ? (
            <Pressable onPress={() => onRemove(i)} style={styles.photoX} hitSlop={8} accessibilityLabel="Remove photo">
              <Ionicons name="close" size={14} color="#fff" />
            </Pressable>
          ) : null}
        </View>
      ))}
      {onAdd && uris.length < max ? (
        <Pressable onPress={onAdd} style={[styles.photo, styles.photoAdd]} accessibilityLabel="Add photo">
          <Ionicons name="camera-outline" size={24} color={colors.brand} />
          <Text style={{ color: colors.brand, fontSize: 11, marginTop: 2 }}>Add</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Bottom sheet modal for confirmations / small forms. */
export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        <Row justify="space-between" style={{ marginBottom: space(3) }}>
          <H3>{title}</H3>
          <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close"><Ionicons name="close" size={24} color={colors.textMuted} /></Pressable>
        </Row>
        {children}
      </View>
    </Modal>
  );
}

export function ConfirmSheet({ visible, onClose, title, body, confirmLabel, onConfirm, danger, loading }: {
  visible: boolean; onClose: () => void; title: string; body: string; confirmLabel: string; onConfirm: () => void; danger?: boolean; loading?: boolean;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <Body>{body}</Body>
      <Spacer h={5} />
      <Button title={confirmLabel} variant={danger ? 'danger' : 'primary'} onPress={onConfirm} loading={loading} />
      <Spacer h={2} />
      <Button title="Not now" variant="ghost" onPress={onClose} />
    </Sheet>
  );
}

export function useToggle(initial = false): [boolean, () => void, (v: boolean) => void] {
  const [v, setV] = useState(initial);
  return [v, () => setV(x => !x), setV];
}

const styles = StyleSheet.create({
  otpBox: { width: 48, height: 58, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  otpBoxActive: { borderColor: colors.brand },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.border, marginTop: 2 },
  line: { width: 2, flex: 1, minHeight: 22, backgroundColor: colors.border, marginTop: 2 },
  photo: { width: 84, height: 84, borderRadius: radius.md, backgroundColor: colors.neutralSoft },
  photoAdd: { alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.brand, backgroundColor: colors.brandSoft },
  photoX: { position: 'absolute', top: 4, right: 4, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 10, padding: 2 },
  backdrop: { flex: 1, backgroundColor: 'rgba(10,15,20,0.35)' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: space(5), paddingBottom: space(10) },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: space(3) },
});
